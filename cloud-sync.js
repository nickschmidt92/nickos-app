// NickOS cloud sync.
// Responsibilities:
//   1. Sign the user in via Apple (or let them use the app anonymously).
//   2. Maintain a realtime subscription to /users/{uid}/state in Firestore.
//   3. Wrap the existing saveToLocalStorage() so every write also pushes to Firestore.
//   4. On first sign-in, migrate whatever is in localStorage up to Firestore so nothing is lost.
//
// The app still saves to localStorage on every change — that is the offline cache.
// Firestore is the source of truth across devices; localStorage is the per-device mirror.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  OAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDocFromServer,
  setDoc,
  onSnapshot,
  serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { firebaseConfig, backend as configuredBackend } from "./firebase-config.js";
import { mergeById } from "./merge-by-id.js";
import { createV2Sync, resolveBackend, isNotAuthorized, retryDelayMs } from "./v2-sync.js?v=14";

const backend = resolveBackend(configuredBackend, location.hostname, localStorage);
const POLL_MS = 60000;
let rawSaveLocal = null; // saveToLocalStorage without the push, set when it's wrapped below
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every entity the API can write — NOT just the six this UI renders.
//
// This list was the six renderable ones, while firebase/functions/index.js has
// eleven. Because pushLocalState() built its payload from this list and wrote with
// { merge: false } — a whole-document replace — every save from the web app
// DELETED contacts, goals, financials, schedule and notes from state/current.
// Anything written through the API/MCP into those five was destroyed the next time
// the app saved, silently, behind a green "Synced" pill.
//
// Keep this in sync with ENTITY_KEYS in firebase/functions/index.js.
const ENTITY_KEYS = [
  'tasks', 'projects', 'decisions', 'docs', 'blockers', 'reviews',
  'contacts', 'goals', 'financials', 'schedule', 'notes'
];

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Offline cache — lets the app work without a connection.
// Only enabled in a single tab at a time; failing silently is fine here.
// v2 doesn't use Firestore from the browser; every read and write goes through the API.
if (backend.mode !== 'v2') {
  enableIndexedDbPersistence(db).catch(() => { /* already enabled or unsupported browser */ });
}

const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

// ──────────────────────────────────────────────────────────────────────
// Public API — what the main app reaches into the window namespace for.
// ──────────────────────────────────────────────────────────────────────

const cloud = {
  user: null,             // firebase User or null
  status: 'booting',      // 'booting' | 'signed-out' | 'signed-in' | 'syncing' | 'error' | 'save-failed'
  lastError: null,
  unsubscribe: null,      // firestore listener disposer
  suppressNextRemote: false, // set true after a local push so we don't bounce it back to ourselves
  pushing: false,         // true while a push is in flight (stops retry-tap pile-ups)
  lastSaveError: null,

  async signIn() {
    try {
      // Popup works in Chrome/Safari desktop; mobile Safari sometimes blocks
      // popups for third-party auth — fall back to redirect there.
      const isMobileSafari = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (isMobileSafari) {
        await signInWithRedirect(auth, appleProvider);
      } else {
        await signInWithPopup(auth, appleProvider);
      }
    } catch (e) {
      cloud.status = 'error';
      cloud.lastError = e.message || String(e);
      console.error('[cloud-sync] sign-in failed:', e);
      renderAuthUI();
    }
  },

  async signOut() {
    try { await signOut(auth); } catch (e) { console.error('[cloud-sync] signOut:', e); }
  },

  // Called by the wrapped saveToLocalStorage() after a local change.
  async pushLocalState() {
    if (!cloud.user) return; // not signed in — localStorage is the only store
    if (v2) return v2.push();
    if (!window.appState) return;
    cloud.pushing = true;
    try {
      const payload = buildStatePayload();
      cloud.suppressNextRemote = true;
      // TEST-ONLY hook: lets browser tests force a save failure. Never set in production.
      if (window.__nickosTestFailSave) throw new Error('test: save failed');
      // merge:true, deliberately. merge:false replaced the WHOLE document, so any
      // field absent from this payload was deleted — which is how five entities got
      // wiped on every save. Deletions within a managed entity still work: that
      // entity's array is present in the payload and replaced wholesale.
      await setDoc(
        doc(db, 'users', cloud.user.uid, 'state', 'current'),
        { ...payload, _updatedAt: serverTimestamp() },
        { merge: true }
      );
      // A successful push (including a retry) clears any save-failed pill.
      cloud.lastSaveError = null;
      cloud.status = 'signed-in';
      try { localStorage.removeItem('nickos_unsaved'); } catch (_) {}
      renderAuthUI();
    } catch (e) {
      console.error('[cloud-sync] push failed:', e);
      cloud.suppressNextRemote = false;
      // Surface the failure: otherwise the user thinks their edits are saved.
      cloud.lastSaveError = e && e.message ? e.message : String(e);
      cloud.status = 'save-failed';
      // Persist across reloads so a stale server copy can't overwrite local edits on next open.
      try { localStorage.setItem('nickos_unsaved', '1'); } catch (_) {}
      renderAuthUI();
    } finally {
      cloud.pushing = false;
    }
  },

  // The ONLY path that pushes while unsaved (the save-failed pill's tap).
  // Why: every entity is pushed as a wholesale array, so pushing the stale local
  // copy would delete every record the API wrote since (e.g. tasks Claude added).
  // Read the server first, merge by id (local wins on a shared id, server-only
  // records are kept), then push the merged copy.
  async retryUnsaved() {
    if (!cloud.user || !window.appState) return;
    if (v2) {
      cloud.pushing = true;
      try {
        await v2.retry();
        if (v2.massDeletes.length) {
          const list = v2.massDeletes.map((m) => `${m.count} ${m.entity}:\n${m.titles.slice(0, 8).join('\n')}${m.count > 8 ? `\n…and ${m.count - 8} more` : ''}`).join('\n\n');
          const ok = window.confirm(`These records are missing from this device.\n\n${list}\n\nOK deletes them everywhere. Cancel keeps them and puts them back.`);
          if (ok) {
            await v2.confirmMassDelete();
          } else {
            v2.restoreMassDelete();
            await v2.retry();
          }
        }
      } finally { cloud.pushing = false; }
      return;
    }
    cloud.pushing = true; // covers the read and the push, so taps can't pile up
    try {
      let server;
      try {
        // FromServer, not getDoc: with IndexedDB persistence on, getDoc returns the
        // cached copy when offline, a stale merge base that could still drop
        // server-only records. Offline must fail here and stay red instead.
        const snap = await getDocFromServer(doc(db, 'users', cloud.user.uid, 'state', 'current'));
        server = snap.exists() ? snap.data() : {};
      } catch (e) {
        // Can't see the server, so can't merge: don't push. Stay red.
        console.error('[cloud-sync] retry read failed:', e);
        cloud.lastSaveError = e && e.message ? e.message : String(e);
        cloud.status = 'save-failed';
        renderAuthUI();
        return;
      }
      const merged = {};
      ENTITY_KEYS.forEach(k => {
        if (Array.isArray(server[k])) merged[k] = mergeById(window.appState[k], server[k]);
      });
      applyRemoteState(merged); // same apply + render helpers as the snapshot path
      await cloud.pushLocalState(); // clears the flag and status on success
    } finally {
      cloud.pushing = false;
    }
  }
};

// While unsaved, nothing pushes except the retry tap, which merges the local copy
// with the server by id first (see retryUnsaved). index.html loads nickos_v4 into
// appState before this module runs, so the retry has the local copy to merge.
try {
  if (localStorage.getItem('nickos_unsaved') === '1') {
    cloud.status = 'save-failed';
    cloud.lastSaveError = 'Unsaved changes from a previous session';
  }
} catch (_) {}

window.nickosCloud = cloud;

// ──────────────────────────────────────────────────────────────────────
// The v2 backend. Only built when the config says so; v1 is untouched otherwise.
// ──────────────────────────────────────────────────────────────────────

const v2 = backend.mode === 'v2' ? createV2Sync({
  apiBase: backend.apiBase,
  getToken: () => (backend.devToken ? Promise.resolve(backend.devToken) : cloud.user.getIdToken()),
  getState: () => window.appState,
  storage: localStorage,
  fetchImpl: (...a) => fetch(...a),
  onStatus: (status, err) => {
    cloud.status = status;
    if (status === 'save-failed') cloud.lastSaveError = err;
    if (status === 'error') cloud.lastError = err;
    renderAuthUI();
  },
  render: () => {
    if (typeof window.render !== 'function') return;
    try { window.render(); } catch (e) { console.error('[cloud-sync] render after sync failed:', e); }
  },
  isBusy: () => Boolean(window.nickosTabLocked || document.querySelector('.modal-overlay.active')),
  saveLocal: () => { if (rawSaveLocal) rawSaveLocal(); }
}) : null;

// Sync must not start until the app has loaded its local copy: an empty boot copy would make
// every local record look new. Don't use readyState for this: a module script runs while it's
// already 'interactive', before DOMContentLoaded and so before the copy is loaded.
const localCopyReady = !v2 ? Promise.resolve() : new Promise((resolve) => {
  const ready = () => { v2.captureBoot(); resolve(); };
  if (window.nickosLocalCopyLoaded) ready();
  else window.addEventListener('nickos-local-copy', ready, { once: true });
});

if (v2) cloud.getRecord = (entity, id) => v2.getRecord(entity, id);

let pollTimer = null;
const pollNow = () => v2.poll().catch((e) => console.warn('[cloud-sync] poll failed:', e));
if (v2) {
  window.addEventListener('online', retryLoadNow);
  document.addEventListener('visibilitychange', retryLoadNow);
}

let loadRetryTimer = null;
let loadAttempts = 0;
let loadRunning = false;

function clearLoadRetry() {
  if (loadRetryTimer) { clearTimeout(loadRetryTimer); loadRetryTimer = null; }
}

// Coming back online or to the app is the moment a failed load is most likely to work.
function retryLoadNow() {
  if (window.nickosTabLocked || !cloud.user || loadRunning || !v2 || v2.loaded || cloud.status === 'not-authorized') return;
  if (document.visibilityState === 'hidden') return;
  startV2();
}

async function startV2() {
  if (loadRunning || window.nickosTabLocked) return;
  loadRunning = true;
  clearLoadRetry();
  await localCopyReady;
  try {
    await v2.load();
    loadAttempts = 0;
  } catch (e) {
    console.error('[cloud-sync] v2 load failed:', e);
    cloud.lastError = e.message || String(e);
    if (hasUnsaved()) {
      cloud.status = 'save-failed';
      cloud.lastSaveError = cloud.lastError;
    } else {
      cloud.status = isNotAuthorized(e) ? 'not-authorized' : 'error';
    }
    // A rejected login won't fix itself; anything else might, so keep trying.
    if (!isNotAuthorized(e)) loadRetryTimer = setTimeout(startV2, retryDelayMs(loadAttempts++));
    renderAuthUI();
    return;
  } finally {
    loadRunning = false;
  }
  if (!pollTimer) {
    pollTimer = setInterval(pollNow, POLL_MS);
    window.addEventListener('focus', pollNow);
  }
}

function stopV2() {
  clearLoadRetry();
  loadAttempts = 0;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  window.removeEventListener('focus', pollNow);
  localCopyReady.then(() => v2.signedOut());
}

// Edits the sync couldn't save. Nothing here writes to NickOS: Nick reads them and re-enters
// what he still wants. Text goes in through textContent, because it's record data.
function showSetAside() {
  document.getElementById('nickos-setaside')?.remove();
  const list = v2.setAsideEdits();
  if (!list.length) { renderAuthUI(); return; }
  const panel = document.createElement('div');
  panel.id = 'nickos-setaside';
  panel.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.75);overflow:auto;padding:24px;font:14px/1.4 -apple-system,system-ui,sans-serif;color:#e5e7eb;';
  const add = (parent, tag, text, css) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (css) el.style.cssText = css;
    parent.appendChild(el);
    return el;
  };
  const box = add(panel, 'div', '', 'max-width:640px;margin:0 auto;background:#141414;border:1px solid #2a2a2a;border-radius:12px;padding:16px;');
  add(box, 'h3', 'Edits set aside', 'margin:0 0 8px;');
  add(box, 'p', 'These were not saved to NickOS. Re-enter anything you still want.', 'margin:0 0 12px;opacity:0.8;');
  const btn = 'margin-right:8px;padding:6px 10px;border-radius:6px;border:1px solid #444;background:#222;color:#e5e7eb;cursor:pointer;';
  list.forEach((entry, i) => {
    const row = add(box, 'div', '', 'border-top:1px solid #2a2a2a;padding:10px 0;');
    add(row, 'div', entry.reason || 'Edits', 'font-weight:600;');
    const ids = Object.values(entry.data || {}).flat().map((r) => r && (r.id || r.title)).filter(Boolean);
    add(row, 'div', `${entry.at ? new Date(entry.at).toLocaleString() : 'Earlier'} · ${ids.length} record(s): ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''}`, 'font-size:12px;opacity:0.8;margin:4px 0 8px;');
    const dl = add(row, 'button', 'Download', btn);
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(entry, null, 2)], { type: 'application/json' }));
      a.download = `nickos-set-aside-${i + 1}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
    const drop = add(row, 'button', 'Dismiss', btn);
    drop.onclick = () => {
      if (!confirm('Dismiss these edits? They were never saved, so this removes the only copy.')) return;
      v2.dismissSetAside(i);
      showSetAside();
      renderAuthUI();
    };
  });
  add(box, 'button', 'Close', `${btn}margin-top:8px;`).onclick = () => panel.remove();
  document.body.appendChild(panel);
}

function hasUnsaved() {
  if (cloud.status === 'save-failed') return true;
  try { return localStorage.getItem('nickos_unsaved') === '1'; } catch (_) { return false; }
}

// ──────────────────────────────────────────────────────────────────────
// Auth state → Firestore subscription lifecycle
// ──────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
  cloud.user = user || null;

  // Tear down any previous listener.
  if (cloud.unsubscribe) { cloud.unsubscribe(); cloud.unsubscribe = null; }

  if (!user && backend.devToken) {
    // Local testing only: resolveBackend() ignores devToken anywhere but localhost.
    cloud.user = { uid: 'dev' };
    await startV2();
    return;
  }

  if (!user) {
    if (v2) stopV2();
    cloud.status = 'signed-out';
    renderAuthUI();
    return;
  }

  if (cloud.status !== 'save-failed') cloud.status = 'syncing';
  renderAuthUI();

  if (v2) { await startV2(); return; }

  const stateRef = doc(db, 'users', user.uid, 'state', 'current');

  cloud.unsubscribe = onSnapshot(stateRef, async (snap) => {
    // Unsaved local edits: never apply remote state until a push succeeds. Checks the
    // persisted flag too, since status resets to 'signed-out'/'syncing' on sign-out/in.
    if (hasUnsaved()) {
      cloud.suppressNextRemote = false; // a guarded echo must not swallow a later real update
      cloud.status = 'save-failed';
      renderAuthUI();
      return;
    }
    if (cloud.suppressNextRemote) {
      // Echo of our own push; ignore so we don't re-render mid-type.
      cloud.suppressNextRemote = false;
      cloud.status = 'signed-in';
      renderAuthUI();
      return;
    }

    if (!snap.exists()) {
      // First sign-in on this account. Migrate whatever is in localStorage up.
      console.log('[cloud-sync] first sign-in: migrating localStorage → Firestore');
      await cloud.pushLocalState(); // sets 'signed-in' itself on success, 'save-failed' on failure
      return;
    }

    // Remote state exists — apply it to the running app.
    const remote = snap.data();
    applyRemoteState(remote);
    cloud.status = 'signed-in';
    renderAuthUI();
  }, (err) => {
    console.error('[cloud-sync] snapshot error:', err);
    cloud.lastError = err.message;
    // Keep the red unsaved pill visible during an outage; only record the error.
    if (!hasUnsaved()) cloud.status = 'error';
    renderAuthUI();
  });
});

// Handle redirect result on mobile Safari after Apple returns.
getRedirectResult(auth).catch((e) => {
  if (e && e.code && e.code !== 'auth/no-auth-event') {
    console.error('[cloud-sync] redirect result error:', e);
  }
});

// ──────────────────────────────────────────────────────────────────────
// State bridge — move data between window.appState and Firestore doc.
// ──────────────────────────────────────────────────────────────────────

function buildStatePayload() {
  const s = window.appState;
  const payload = {
    _version: '4.0',
    _device: navigator.userAgent,
    _savedAt: new Date().toISOString(),
    currentPage: s.currentPage,
    taskFilters: s.taskFilters,
    taskView: s.taskView
  };
  // Only send keys this client actually holds. Paired with { merge: true } below,
  // an entity the app has never loaded is left untouched in Firestore rather than
  // being overwritten with []. Without this guard, widening ENTITY_KEYS alone would
  // still wipe the five new entities during the window between boot and the first
  // snapshot landing, because appState has no array for them yet.
  ENTITY_KEYS.forEach(k => { if (Array.isArray(s[k])) payload[k] = s[k]; });
  return payload;
}

function applyRemoteState(remote) {
  if (!window.appState || !remote) return;

  // UI prefs — take remote if present, don't clobber local with undefined.
  if (remote.currentPage) window.appState.currentPage = remote.currentPage;
  if (remote.taskFilters) window.appState.taskFilters = remote.taskFilters;
  if (remote.taskView)    window.appState.taskView    = remote.taskView;

  // Entities — replace wholesale. Firestore is the source of truth once signed in.
  ENTITY_KEYS.forEach(k => {
    if (Array.isArray(remote[k])) window.appState[k] = remote[k];
  });

  if (typeof window.render === 'function') {
    try { window.render(); } catch (e) { console.error('[cloud-sync] render after remote apply failed:', e); }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Auth UI — a single pill in the top-right showing status + sign in/out.
// ──────────────────────────────────────────────────────────────────────

function renderAuthUI() {
  let host = document.getElementById('cloud-auth-pill');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cloud-auth-pill';
    host.style.cssText = [
      'position:fixed','top:12px','right:12px','z-index:1000',
      'display:flex','align-items:center','gap:8px',
      'padding:6px 10px','border-radius:999px',
      'background:rgba(20,20,20,0.85)','backdrop-filter:blur(12px)',
      'border:1px solid #2a2a2a','color:#e5e7eb',
      'font:500 12px/1 -apple-system,system-ui,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
      'user-select:none'
    ].join(';');
    document.body.appendChild(host);
  }

  const dot = (color) =>
    `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span>`;

  let inner = '';
  switch (cloud.status) {
    case 'booting':
      inner = `${dot('#6b7280')} <span>Loading…</span>`;
      break;
    case 'signed-out':
      inner = `${dot('#6b7280')} <button id="cloud-signin-btn" style="all:unset;cursor:pointer;font-weight:600;color:#e5e7eb;">Sign in with Apple</button>`;
      break;
    case 'syncing':
      inner = `${dot('#fbbf24')} <span>Syncing…</span>`;
      break;
    case 'signed-in':
      inner = `${dot('#10b981')} <span>Synced</span> <button id="cloud-signout-btn" style="all:unset;cursor:pointer;opacity:0.6;font-size:11px;">Sign out</button>`;
      break;
    case 'save-failed':
      // Written out, not a tooltip: a phone never shows a tooltip.
      inner = `${dot('#ef4444')} <span style="line-height:1.3;">Not saved — tap to retry${cloud.lastSaveError ? `<br><span style="font-weight:400;opacity:0.8;display:block;max-width:70vw;max-height:4.2em;overflow:hidden;">${escapeHtml(cloud.lastSaveError)}</span>` : ''}</span>`;
      break;
    case 'error':
      // v2's Retry reloads the data. Signing in again wouldn't fix a failed load, and on a
      // phone it would leave the app.
      inner = `${dot('#ef4444')} <span title="${(cloud.lastError||'').replace(/"/g,'&quot;')}">Offline</span> <button id="${v2 && cloud.user ? 'cloud-retry-btn' : 'cloud-signin-btn'}" style="all:unset;cursor:pointer;opacity:0.6;font-size:11px;">Retry</button>`;
      break;
    case 'not-authorized':
      inner = `${dot('#ef4444')} <span style="line-height:1.3;">Not authorized. Wrong Apple account?</span> <button id="cloud-signout-btn" style="all:unset;cursor:pointer;opacity:0.6;font-size:11px;">Sign out</button>`;
      break;
  }
  const parked = v2 ? v2.setAsideEdits().length : 0;
  if (parked) inner += ` <button id="cloud-setaside-btn" style="all:unset;cursor:pointer;text-decoration:underline;font-size:11px;">${parked} set aside</button>`;
  host.innerHTML = inner;
  const parkedEl = document.getElementById('cloud-setaside-btn');
  if (parkedEl) parkedEl.addEventListener('click', (e) => { e.stopPropagation(); showSetAside(); });

  const inEl  = document.getElementById('cloud-signin-btn');
  const outEl = document.getElementById('cloud-signout-btn');
  if (inEl)  inEl.addEventListener('click', () => cloud.signIn());
  const retryEl = document.getElementById('cloud-retry-btn');
  if (retryEl) retryEl.addEventListener('click', () => startV2());
  if (outEl) outEl.addEventListener('click', () => cloud.signOut());
  // The save-failed pill is itself the retry control; other states ignore pill clicks.
  host.onclick = () => { if (cloud.status === 'save-failed' && !cloud.pushing) cloud.retryUnsaved(); };
}

renderAuthUI();

// ──────────────────────────────────────────────────────────────────────
// Patch the app's saveToLocalStorage to also push to Firestore.
// ──────────────────────────────────────────────────────────────────────

(function patchSaveWhenReady() {
  const start = Date.now();
  const tryPatch = () => {
    if (typeof window.saveToLocalStorage === 'function' && !window.saveToLocalStorage.__cloudPatched) {
      const original = window.saveToLocalStorage;
      rawSaveLocal = original;
      window.saveToLocalStorage = function patched(...args) {
        const r = original.apply(this, args);
        if (v2) v2.noteEdit(); // covers signed out and not loaded, where nothing below sends
        // Unsaved: save locally only and keep the pill red. A push here (autosave
        // or any edit) would replace the server's arrays with the stale local copy
        // and delete server-only records; only retryUnsaved() may push now.
        if (hasUnsaved()) return r;
        // Fire-and-forget; don't block the UI thread.
        Promise.resolve().then(() => cloud.pushLocalState());
        return r;
      };
      window.saveToLocalStorage.__cloudPatched = true;
      console.log('[cloud-sync] saveToLocalStorage wrapped for cloud push');
      return;
    }
    if (Date.now() - start > 10000) {
      console.warn('[cloud-sync] saveToLocalStorage not found after 10s');
      return;
    }
    setTimeout(tryPatch, 50);
  };
  tryPatch();
})();

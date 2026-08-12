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
  setDoc,
  onSnapshot,
  serverTimestamp,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

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
enableIndexedDbPersistence(db).catch(() => { /* already enabled or unsupported browser */ });

const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

// ──────────────────────────────────────────────────────────────────────
// Public API — what the main app reaches into the window namespace for.
// ──────────────────────────────────────────────────────────────────────

const cloud = {
  user: null,             // firebase User or null
  status: 'booting',      // 'booting' | 'signed-out' | 'signed-in' | 'syncing' | 'error'
  lastError: null,
  unsubscribe: null,      // firestore listener disposer
  suppressNextRemote: false, // set true after a local push so we don't bounce it back to ourselves

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
    if (!window.appState) return;
    try {
      const payload = buildStatePayload();
      cloud.suppressNextRemote = true;
      // merge:true, deliberately. merge:false replaced the WHOLE document, so any
      // field absent from this payload was deleted — which is how five entities got
      // wiped on every save. Deletions within a managed entity still work: that
      // entity's array is present in the payload and replaced wholesale.
      await setDoc(
        doc(db, 'users', cloud.user.uid, 'state', 'current'),
        { ...payload, _updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      console.error('[cloud-sync] push failed:', e);
      cloud.suppressNextRemote = false;
    }
  }
};

window.nickosCloud = cloud;

// ──────────────────────────────────────────────────────────────────────
// Auth state → Firestore subscription lifecycle
// ──────────────────────────────────────────────────────────────────────

onAuthStateChanged(auth, async (user) => {
  cloud.user = user || null;

  // Tear down any previous listener.
  if (cloud.unsubscribe) { cloud.unsubscribe(); cloud.unsubscribe = null; }

  if (!user) {
    cloud.status = 'signed-out';
    renderAuthUI();
    return;
  }

  cloud.status = 'syncing';
  renderAuthUI();

  const stateRef = doc(db, 'users', user.uid, 'state', 'current');

  cloud.unsubscribe = onSnapshot(stateRef, async (snap) => {
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
      await cloud.pushLocalState();
      cloud.status = 'signed-in';
      renderAuthUI();
      return;
    }

    // Remote state exists — apply it to the running app.
    const remote = snap.data();
    applyRemoteState(remote);
    cloud.status = 'signed-in';
    renderAuthUI();
  }, (err) => {
    console.error('[cloud-sync] snapshot error:', err);
    cloud.status = 'error';
    cloud.lastError = err.message;
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
    case 'error':
      inner = `${dot('#ef4444')} <span title="${(cloud.lastError||'').replace(/"/g,'&quot;')}">Offline</span> <button id="cloud-signin-btn" style="all:unset;cursor:pointer;opacity:0.6;font-size:11px;">Retry</button>`;
      break;
  }
  host.innerHTML = inner;

  const inEl  = document.getElementById('cloud-signin-btn');
  const outEl = document.getElementById('cloud-signout-btn');
  if (inEl)  inEl.addEventListener('click', () => cloud.signIn());
  if (outEl) outEl.addEventListener('click', () => cloud.signOut());
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
      window.saveToLocalStorage = function patched(...args) {
        const r = original.apply(this, args);
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

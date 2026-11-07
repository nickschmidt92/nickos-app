// NickOS web app sync against the v2 API. No imports, so node tests can run it
// (scripts/v2-sync.test.mjs); cloud-sync.js hands it the login token and the app state.
//
// v1 pushed each entity as a whole array, so a stale copy could delete records. v2 has
// no such write. This works out what changed against the last server copy (`base`) and
// sends one patch per record with the version it was based on. A failed save stays
// local and visible, and nothing here can remove a record from the server: a record
// missing from the app becomes a soft delete, and a suspiciously large number of them
// is refused until Nick confirms that list. The retry tap alone never approves it.
//
// An edit is recorded as pending BEFORE anything is sent, and whenever it's made with no
// server copy loaded, so closing the tab or signing out can't lose it. A pending edit is
// separate from a failed save (nickos_unsaved): it keeps pushing and shows no red pill.
// The next load re-sends it, and idempotency keys make that safe.

export const ENTITIES = ['projects', 'tasks', 'decisions', 'docs', 'blockers', 'reviews'];
const REF_FIELDS = ['projectId', 'parentProject'];
const BATCH = 50;
const MAX_PASSES = 3;
const POLL_OVERLAP_MS = 5000;
export const MASS_DELETE_LIMIT = 20;
export const MASS_CREATE_LIMIT = 20;
const UNSAVED = 'nickos_unsaved';
const BASE = 'nickos_v2_base';
const ORPHAN = 'nickos_v2_orphan';
const SET_ASIDE_MAX = 5;
const PENDING = 'nickos_v2_pending';
const KEEPALIVE_MAX_BYTES = 60000; // browsers refuse keepalive bodies over 64 KB
const ITEM_ERRORS = new Set([400, 404, 422]); // this record is the problem, not the connection

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const copy = (x) => JSON.parse(JSON.stringify(x));
const blank = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** A rejected login needs a person; retrying won't change the answer. */
export const isNotAuthorized = (e) => e?.status === 401 || e?.status === 403;

/** Wait before the next load attempt: 15s, 30s, 1m, 2m, then every 5m. */
export const retryDelayMs = (attempt) => Math.min(15000 * 2 ** Math.max(0, attempt), 300000);

/** The backend to use. The dev override only ever applies on localhost. */
export function resolveBackend(configured, hostname, storage) {
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (isLocal) {
    try {
      const dev = JSON.parse(storage.getItem('nickos_backend_dev') || 'null');
      if (dev && dev.mode) return dev;
    } catch (_) { /* a bad override means the configured backend */ }
  }
  const { devToken: _ignored, ...safe } = configured || {};
  return { mode: 'v1', ...safe };
}

/** What differs between the last server copy and the app. Pure. */
export function diffEntity(baseMap, current, writable) {
  const out = { creates: [], updates: [], deletes: [], ignored: [] };
  const seen = new Set();
  for (const item of current) {
    if (!item) continue;
    const before = item.id != null ? baseMap.get(item.id) : undefined;
    if (!before) { out.creates.push(item); continue; }
    seen.add(item.id);
    const patch = {};
    for (const k of new Set([...Object.keys(item), ...Object.keys(before)])) {
      if (k.endsWith('Sys') || k === 'id' || same(item[k], before[k])) continue;
      // '' and absent differ in stored data, but going from one to the other isn't an edit.
      if (blank(item[k]) && blank(before[k])) continue;
      if (writable.has(k)) patch[k] = item[k] === undefined ? null : item[k];
      else out.ignored.push({ id: item.id, field: k, value: item[k] });
    }
    if (Object.keys(patch).length) out.updates.push({ id: item.id, patch, expectedVersion: before.versionSys });
  }
  for (const [id, before] of baseMap) {
    if (!seen.has(id)) out.deletes.push({ id, expectedVersion: before.versionSys });
  }
  return out;
}

/** Fields for a new record: writable ones with a value. The server assigns the id. */
export function createFields(item, writable) {
  const f = {};
  for (const [k, v] of Object.entries(item)) if (writable.has(k) && !blank(v)) f[k] = v;
  return f;
}

/** After a version conflict: fields Nick changed that someone else also changed differently. */
export function overlappingFields(before, server, patch) {
  return Object.keys(patch).filter((k) => !same(server[k], before[k]) && !same(server[k], patch[k]));
}

export function createV2Sync({ apiBase, getToken, getState, storage, fetchImpl, onStatus, render, isBusy = () => false, saveLocal = () => {}, log = console }) {
  let base = null;
  let writable = null;
  let since = null;
  let pushing = false;
  let again = false;
  let loaded = false;
  // The local copy as it was before any edit this session. Edits made with no server copy
  // loaded are diffed against this, so only real edits are sent, never a stale local copy.
  let boot = null;
  let needsRefresh = false;
  let massDeletes = [];

  const status = (s, err) => onStatus(s, err || null);
  const hasUnsaved = () => { try { return storage.getItem(UNSAVED) === '1'; } catch (_) { return false; } };
  const hasPending = () => { try { return storage.getItem(PENDING) === '1'; } catch (_) { return false; } };
  const baseJson = () => JSON.stringify(Object.fromEntries(ENTITIES.map((e) => [e, [...base[e].values()]])));

  function markUnsaved() {
    try {
      storage.setItem(BASE, baseJson());
      storage.setItem(UNSAVED, '1');
    } catch (e) { log.error('[v2-sync] could not persist unsaved state:', e); }
  }
  // The base goes first, so the flag never exists without one.
  function markPending(json) {
    try {
      storage.setItem(BASE, json);
      storage.setItem(PENDING, '1');
    } catch (e) { log.error('[v2-sync] could not persist pending edit:', e); }
  }
  function clearUnsaved() {
    try { storage.removeItem(UNSAVED); storage.removeItem(PENDING); storage.removeItem(BASE); } catch (_) {}
  }

  /** Edits that couldn't be saved. A list, so a new one never overwrites an older one. */
  function readSetAside() {
    try {
      const v = JSON.parse(storage.getItem(ORPHAN) || '[]');
      return Array.isArray(v) ? v : [{ at: null, reason: 'Earlier edits that were not saved', data: v }];
    } catch (_) { return []; }
  }

  function setAside(reason, data) {
    const list = [{ at: new Date().toISOString(), reason, data }, ...readSetAside()].slice(0, SET_ASIDE_MAX);
    // Browser storage is limited, and the app's own copy lives there too: drop the oldest first.
    while (list.length) {
      try { storage.setItem(ORPHAN, JSON.stringify(list)); return true; } catch (_) { list.pop(); }
    }
    log.error('[v2-sync] could not keep edits set aside:', reason);
    return false;
  }

  function dismissSetAside(index) {
    const list = readSetAside();
    list.splice(index, 1);
    try {
      if (list.length) storage.setItem(ORPHAN, JSON.stringify(list));
      else storage.removeItem(ORPHAN);
    } catch (_) {}
  }

  /** What the local copy holds that the server doesn't: the part worth keeping, and it fits. */
  function localDifferences(serverData) {
    const state = getState();
    const out = {};
    for (const e of ENTITIES) {
      const server = new Map((serverData[e] || []).map((r) => [r.id, r]));
      const differ = (Array.isArray(state[e]) ? state[e] : []).filter((r) => {
        if (!r) return false;
        const s = server.get(r.id);
        if (!s) return true;
        return [...new Set([...Object.keys(r), ...Object.keys(s)])].some((k) =>
          !k.endsWith('Sys') && !same(r[k], s[k]) && !(blank(r[k]) && blank(s[k])));
      });
      if (differ.length) out[e] = differ;
    }
    return out;
  }

  async function call(method, path, body) {
    const token = await getToken();
    const payload = body ? JSON.stringify(body) : undefined;
    const res = await fetchImpl(apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: payload,
      // Lets a save finish after the tab closes. An oversized body fails the fetch, so skip it.
      ...(payload && payload.length < KEEPALIVE_MAX_BYTES ? { keepalive: true } : {})
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* a non-JSON body is reported by status */ }
    if (!res.ok && res.status !== 207) {
      const e = new Error((data && data.error) || `API ${res.status}`);
      e.status = res.status;
      e.code = data && data.code;
      throw e;
    }
    return data;
  }

  const toMaps = (data) => Object.fromEntries(ENTITIES.map((e) => [e, new Map((data[e] || []).filter((r) => r && r.id != null).map((r) => [r.id, copy(r)]))]));
  const stepBack = (iso) => new Date(new Date(iso).getTime() - POLL_OVERLAP_MS).toISOString();

  function applyAll(body) {
    const state = getState();
    for (const e of ENTITIES) state[e] = body.data[e] || [];
    base = toMaps(body.data);
    since = stepBack(body.serverTime);
  }

  /**
   * First load after sign-in. With unsaved edits from an earlier session the local copy
   * stays and is retried against the base it was made from. If that base was lost a
   * diff can't be trusted, so the local copy is set aside and the server's is used.
   */
  const entitiesNow = () => { const st = getState(); return JSON.stringify(Object.fromEntries(ENTITIES.map((e) => [e, st[e]]))); };

  /** Record the local copy before any edit. Call once the app has loaded it. */
  function captureBoot() {
    if (boot === null) boot = entitiesNow();
  }

  /** Call after every local save. An edit with no server copy loaded has to survive a reload. */
  function noteEdit() {
    if (loaded || boot === null || hasUnsaved() || hasPending()) return;
    if (entitiesNow() !== boot) markPending(boot);
  }

  /** Signed out: no server copy to save against, so edits from here on are pending. */
  function signedOut() {
    if (hasPending() || hasUnsaved()) { loaded = false; return; } // those keep their own base
    loaded = false;
    boot = entitiesNow();
  }

  function edited() {
    const state = getState();
    return ENTITIES.some((e) => {
      if (!Array.isArray(state[e])) return false;
      const d = diffEntity(base[e], state[e], writable[e]);
      return d.creates.length || d.updates.length || d.deletes.length;
    });
  }

  /** After recovering edits, catch up on what changed on the server in the meantime. */
  async function refresh() {
    try {
      const body = await call('GET', '/all');
      if (pushing || hasUnsaved() || edited()) return;
      applyAll(body);
      needsRefresh = false;
      render();
    } catch (e) { log.warn('[v2-sync] refresh after recovery failed:', e); }
  }

  async function load() {
    let setAsideNow = false;
    // Stay red with unsaved work: the red pill is what lets Nick retry if this fails.
    if (!hasUnsaved()) status('syncing');
    captureBoot();
    const body = await call('GET', '/all');
    writable = Object.fromEntries(ENTITIES.map((e) => [e, new Set(body.writable[e] || [])]));
    if (hasUnsaved()) {
      let saved = null;
      try { saved = JSON.parse(storage.getItem(BASE) || 'null'); } catch (_) {}
      if (saved) {
        base = toMaps(saved);
        fillVersions(body.data);
        since = stepBack(body.serverTime);
        loaded = true;
        needsRefresh = true;
        status('save-failed', 'Unsaved changes from a previous session');
        return;
      }
      setAside('Unsaved edits from an earlier session, with nothing to compare them against', localDifferences(body.data));
      log.warn('[v2-sync] unsaved edits had no base; local differences set aside');
      clearUnsaved();
      setAsideNow = true;
    }
    // An empty answer with a full local copy means the wrong target, not an empty life.
    const serverHolds = ENTITIES.some((e) => (body.data[e] || []).length);
    const state = getState();
    if (!serverHolds && ENTITIES.some((e) => (state[e] || []).length)) {
      throw new Error('The server returned no records. Keeping the local copy and not syncing.');
    }
    // Edits made before there was a server copy: a reload left them pending, or they were
    // made this session while signed out or during an outage. applyAll would overwrite
    // them, so send them against the copy they were made from, then catch up.
    if (!setAsideNow) {
      let from = null;
      if (hasPending()) {
        try { from = JSON.parse(storage.getItem(BASE) || 'null'); } catch (_) {}
        if (!from) {
          // Can't diff without the base. Keep the copy and say so, never overwrite silently.
          setAside('Pending edits from an earlier session, with nothing to compare them against', localDifferences(body.data));
          log.warn('[v2-sync] pending edit had no base; local differences set aside');
          setAsideNow = true;
        }
      } else if (entitiesNow() !== boot) {
        from = JSON.parse(boot);
      }
      if (from) {
        base = toMaps(from);
        fillVersions(body.data);
        since = stepBack(body.serverTime);
        loaded = true;
        boot = null;
        needsRefresh = true;
        await push();
        render();
        return;
      }
    }
    applyAll(body);
    loaded = true;
    boot = null;
    try { storage.removeItem(PENDING); } catch (_) {}
    if (setAsideNow) status('save-failed', 'Earlier edits were not saved. Tap "set aside" to see them.');
    else status('signed-in');
    render();
  }

  /**
   * A copy from before versions existed has none, and the API refuses the whole batch for one
   * missing. Take them from the server. A record it no longer holds can't be saved or recreated.
   */
  function fillVersions(serverData) {
    const state = getState();
    for (const e of ENTITIES) {
      const server = new Map((serverData[e] || []).map((r) => [r.id, r]));
      for (const [id, record] of base[e]) {
        if (record.versionSys != null) continue;
        const s = server.get(id);
        if (s) { record.versionSys = s.versionSys; continue; }
        base[e].delete(id);
        const list = state[e] || [];
        const at = list.findIndex((x) => x && x.id === id);
        if (at >= 0) {
          setAside(`${id} from an old local copy is no longer on the server`, { [e]: [list[at]] });
          list.splice(at, 1);
        }
      }
    }
  }

  function remapRefs(from, to) {
    const state = getState();
    for (const e of ENTITIES) {
      for (const item of state[e] || []) {
        for (const f of REF_FIELDS) if (item && item[f] === from) item[f] = to;
      }
    }
  }

  async function sendCreate(entity, item) {
    if (item.id == null) item.id = `LOCAL-${Date.now().toString(36)}-${fnv(JSON.stringify(item))}`;
    const localId = item.id;
    const made = await call('POST', '/add', {
      entity, fields: createFields(item, writable[entity]), idempotencyKey: `web-add-${entity}-${localId}`
    });
    // On a replay an earlier attempt made the record, so what this attempt sent wasn't stored.
    const sent = made.replayed ? createFields(item, writable[entity]) : null;
    const { record } = await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(made.id)}`);
    const live = !record.lifecycleSys || record.lifecycleSys === 'LIVE';
    // Changed or removed elsewhere since that attempt. Its copy wins: keep this edit where Nick
    // can see it, because the difference could be the other device's edit, not a later one here.
    const superseded = sent && (!live || record.versionSys > 1);
    if (superseded) {
      setAside(`${record.id} changed on another device before this edit saved, so it was not applied`, { [entity]: [copy(item)] });
    }
    remapRefs(localId, record.id);
    if (!live) {
      const list = getState()[entity] || [];
      const at = list.indexOf(item);
      if (at >= 0) list.splice(at, 1);
      return;
    }
    // The app now holds exactly what the server stored, as it will after a reload.
    for (const k of Object.keys(item)) if (!(k in record)) delete item[k];
    Object.assign(item, copy(record));
    base[entity].set(record.id, copy(record));
    // Put Nick's later edits back on top, so the next pass sends them as an update.
    if (sent && !superseded) {
      for (const k of writable[entity]) if (k in record && !(k in sent)) delete item[k];
      Object.assign(item, copy(sent));
    }
  }

  async function sendUpdates(entity, updates, conflicts, failures, { localWins }) {
    for (let i = 0; i < updates.length; i += BATCH) {
      const chunk = updates.slice(i, i + BATCH);
      const res = await call('POST', '/batchUpdate', {
        updates: chunk.map((u) => ({
          entity, id: u.id, patch: u.patch, expectedVersion: u.expectedVersion,
          idempotencyKey: `web-upd-${entity}-${u.id}-v${u.expectedVersion}-${fnv(JSON.stringify(u.patch))}`
        }))
      });
      for (let j = 0; j < chunk.length; j++) {
        const u = chunk[j];
        const r = res.results[j];
        const local = (getState()[entity] || []).find((x) => x && x.id === u.id);
        if (r.ok) {
          base[entity].set(u.id, { ...base[entity].get(u.id), ...copy(u.patch), versionSys: r.versionSys });
          if (local) local.versionSys = r.versionSys;
          continue;
        }
        // One bad record must not hold back every edit after it.
        if (r.code !== 'VERSION_CONFLICT' && r.code !== 'NOT_LIVE') { failures.push(`${u.id}: ${r.error}`); continue; }
        const { record: server } = await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(u.id)}`);
        // Archived or deleted elsewhere: an edit reapplied here would show green and be gone
        // on reload. Take the record out, as a poll would, and keep the edit where Nick sees it.
        if (server.lifecycleSys && server.lifecycleSys !== 'LIVE') {
          setAside(`${u.id} was ${String(server.lifecycleSys).toLowerCase()} elsewhere, so this edit was not saved`, { [entity]: [{ id: u.id, title: server.title, ...copy(u.patch) }] });
          base[entity].delete(u.id);
          const list = getState()[entity] || [];
          const at = list.findIndex((x) => x && x.id === u.id);
          if (at >= 0) list.splice(at, 1);
          failures.push(`${u.id}: changed elsewhere and no longer live. Your edit was set aside.`);
          continue;
        }
        const overlap = localWins ? [] : overlappingFields(base[entity].get(u.id), server, u.patch);
        if (overlap.length) { conflicts.push(`${u.id} (${overlap.join(', ')})`); continue; }
        // Take the server's copy as the new base and keep only Nick's patch on top, so
        // the next pass sends the same change against the current version.
        base[entity].set(u.id, copy(server));
        if (local) {
          for (const k of Object.keys(local)) if (!(k in server) && !(k in u.patch)) delete local[k];
          Object.assign(local, copy(server), copy(u.patch));
        }
      }
    }
  }

  async function sendDeletes(entity, deletes, failures) {
    for (const d of deletes) {
      try {
        await call('POST', '/delete', {
          entity, id: d.id, expectedVersion: d.expectedVersion,
          idempotencyKey: `web-del-${entity}-${d.id}-v${d.expectedVersion}`
        });
        base[entity].delete(d.id);
      } catch (e) {
        if (ITEM_ERRORS.has(e.status)) { failures.push(`${d.id}: ${e.message}`); continue; }
        if (e.code !== 'VERSION_CONFLICT') throw e;
        const { record } = await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(d.id)}`);
        if (record.lifecycleSys === 'LIVE') base[entity].set(d.id, copy(record));
        else base[entity].delete(d.id);
      }
    }
  }

  async function pass(opts) {
    const state = getState();
    const conflicts = [];
    const failures = [];
    const unsent = new Set(); // local ids that failed to create; nothing may point at them
    const pointsAtUnsent = (r) => REF_FIELDS.some((f) => unsent.has(r[f]));
    let wrote = false;
    massDeletes = [];
    // The id is the retry's idempotency key, so it must be on disk before the first send.
    let named = false;
    for (const e of ENTITIES) {
      for (const item of Array.isArray(state[e]) ? state[e] : []) {
        if (item && item.id == null) {
          item.id = `LOCAL-${Date.now().toString(36)}-${fnv(JSON.stringify(item))}`;
          named = true;
        }
      }
    }
    if (named) saveLocal();
    // Projects go first, so records pointing at a new project get its real id.
    for (const e of ENTITIES) {
      if (!Array.isArray(state[e])) continue;
      const first = diffEntity(base[e], state[e], writable[e]);
      // Nobody adds this many records by hand: it means the comparison copy is wrong, and
      // sending them would duplicate everything. Refused outright; no tap can approve it.
      if (first.creates.length > MASS_CREATE_LIMIT) {
        failures.push(`Refusing to create ${first.creates.length} ${e} at once. Nothing was sent.`);
        first.creates.forEach((item) => unsent.add(item.id));
        continue;
      }
      for (const item of first.creates) {
        if (pointsAtUnsent(item)) { failures.push(`${item.id}: its project wasn't saved`); unsent.add(item.id); continue; }
        try {
          await sendCreate(e, item);
          wrote = true;
        } catch (err) {
          if (!ITEM_ERRORS.has(err.status)) throw err;
          failures.push(`${item.title || item.id}: ${err.message}`);
          unsent.add(item.id);
        }
      }
      const d = diffEntity(base[e], state[e], writable[e]);
      if (d.ignored.length) {
        log.warn('[v2-sync] not writable, not sent:', d.ignored.map((x) => `${x.id}.${x.field}`).join(', '));
        // Say it once: remember the app's value so this isn't a change on every autosave.
        for (const x of d.ignored) base[e].get(x.id)[x.field] = copy(x.value ?? null);
      }
      const updates = d.updates.filter((u) => {
        if (!pointsAtUnsent(u.patch)) return true;
        failures.push(`${u.id}: its project wasn't saved`);
        return false;
      });
      if (updates.length) { await sendUpdates(e, updates, conflicts, failures, opts); wrote = true; }
      if (d.deletes.length > MASS_DELETE_LIMIT && !opts.allowMassDelete) {
        massDeletes.push({
          entity: e,
          count: d.deletes.length,
          ids: d.deletes.map((x) => x.id),
          titles: d.deletes.map((x) => base[e].get(x.id)?.title || x.id)
        });
        failures.push(`Refusing to delete ${d.deletes.length} ${e} at once. Tap to review.`);
      } else if (d.deletes.length) {
        await sendDeletes(e, d.deletes, failures);
        wrote = true;
      }
    }
    return { conflicts, failures, wrote };
  }

  async function push(opts = {}) {
    if (!loaded) { noteEdit(); return; }
    if (pushing) { again = true; return; }
    pushing = true;
    let saved = false;
    try {
      do {
        again = false;
        if (edited()) markPending(baseJson());
        let conflicts = [];
        let failures = [];
        let settled = false;
        for (let i = 0; i < MAX_PASSES; i++) {
          const r = await pass(opts);
          conflicts = r.conflicts;
          failures = r.failures;
          if (conflicts.length || failures.length) break;
          // Only a pass with nothing left to send proves everything landed.
          if (!r.wrote) { settled = true; break; }
        }
        const problems = [
          ...failures,
          ...(conflicts.length ? [`Also changed elsewhere: ${conflicts.join('; ')}. Tap to keep yours.`] : [])
        ];
        if (problems.length) throw new Error(problems.join(' | '));
        if (!settled) throw new Error('Records kept changing while saving. Tap to try again.');
      } while (again);
      clearUnsaved();
      saved = true;
      status('signed-in');
    } catch (e) {
      log.error('[v2-sync] save failed:', e);
      markUnsaved();
      status('save-failed', e.message || String(e));
    } finally {
      pushing = false;
    }
    if (saved && needsRefresh) await refresh();
  }

  /**
   * The red pill's tap: Nick has seen the warning, so his copy wins this time. Conflicts
   * only. A large delete still needs confirmMassDelete(), because a stale local copy looks
   * exactly like one and a retry tap says nothing about wanting those records gone.
   */
  async function retry() {
    if (!loaded) {
      try {
        await load();
      } catch (e) {
        log.error('[v2-sync] retry could not load:', e);
        status('save-failed', e.message || String(e));
        return;
      }
    }
    await push({ localWins: true });
  }

  /** Nick reviewed the list and wants these records deleted. */
  async function confirmMassDelete() {
    await push({ localWins: true, allowMassDelete: true });
  }

  /** Nick didn't want that: put the records back from the last server copy. */
  function restoreMassDelete() {
    const state = getState();
    for (const m of massDeletes) {
      const list = state[m.entity];
      for (const id of m.ids) {
        if (base[m.entity].has(id) && !list.some((x) => x && x.id === id)) list.push(copy(base[m.entity].get(id)));
      }
    }
    massDeletes = [];
    saveLocal();
    render();
  }

  async function poll() {
    if (!loaded || pushing || hasUnsaved() || hasPending() || isBusy()) return;
    const state = getState();
    // Checked again after each wait: an edit made meanwhile must not be replaced. since
    // stays put, so the next poll fetches the same changes.
    const standDown = () => pushing || hasUnsaved() || hasPending() || isBusy() || edited();
    if (edited()) return;
    const body = await call('GET', `/changes?since=${encodeURIComponent(since)}`);
    if (standDown()) return;
    if (body.hasMore) {
      const all = await call('GET', '/all');
      if (standDown()) return;
      applyAll(all);
      render();
      return;
    }
    let changed = false;
    for (const e of ENTITIES) {
      for (const r of body.data[e] || []) {
        const before = base[e].get(r.id);
        if (before && before.versionSys >= r.versionSys) continue;
        const list = state[e];
        const at = list.findIndex((x) => x && x.id === r.id);
        if (r.lifecycleSys === 'LIVE') {
          base[e].set(r.id, copy(r));
          if (at >= 0) list[at] = r; else list.push(r);
          changed = true;
        } else if (before || at >= 0) {
          base[e].delete(r.id);
          if (at >= 0) list.splice(at, 1);
          changed = true;
        }
      }
    }
    since = stepBack(body.serverTime);
    if (changed) render();
  }

  return {
    load, push, retry, poll, captureBoot, noteEdit, signedOut, confirmMassDelete, restoreMassDelete,
    setAsideEdits: readSetAside, dismissSetAside,
    getRecord: async (entity, id) => (await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(id)}`)).record,
    get loaded() { return loaded; },
    get pushing() { return pushing; },
    get massDeletes() { return massDeletes; }
  };
}

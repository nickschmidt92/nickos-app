// NickOS web app sync against the v2 API. No imports, so node tests can run it
// (scripts/v2-sync.test.mjs); cloud-sync.js hands it the login token and the app state.
//
// v1 pushed each entity as a whole array, so a stale copy could delete records. v2 has
// no such write. This works out what changed against the last server copy (`base`) and
// sends one patch per record with the version it was based on. A failed save stays
// local and visible, and nothing here can remove a record from the server: a record
// missing from the app becomes a soft delete, and a suspiciously large number of them
// is refused until Nick taps retry.

export const ENTITIES = ['projects', 'tasks', 'decisions', 'docs', 'blockers', 'reviews'];
const REF_FIELDS = ['projectId', 'parentProject'];
const BATCH = 50;
const MAX_PASSES = 3;
const POLL_OVERLAP_MS = 5000;
export const MASS_DELETE_LIMIT = 20;
const UNSAVED = 'nickos_unsaved';
const BASE = 'nickos_v2_base';
const ORPHAN = 'nickos_v2_orphan';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const copy = (x) => JSON.parse(JSON.stringify(x));
const blank = (v) => v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

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

export function createV2Sync({ apiBase, getToken, getState, storage, fetchImpl, onStatus, render, isBusy = () => false, log = console }) {
  let base = null;
  let writable = null;
  let since = null;
  let pushing = false;
  let again = false;
  let loaded = false;
  let preLoad = null;

  const status = (s, err) => onStatus(s, err || null);
  const hasUnsaved = () => { try { return storage.getItem(UNSAVED) === '1'; } catch (_) { return false; } };

  function markUnsaved() {
    try {
      storage.setItem(UNSAVED, '1');
      storage.setItem(BASE, JSON.stringify(Object.fromEntries(ENTITIES.map((e) => [e, [...base[e].values()]]))));
    } catch (e) { log.error('[v2-sync] could not persist unsaved state:', e); }
  }
  function clearUnsaved() {
    try { storage.removeItem(UNSAVED); storage.removeItem(BASE); } catch (_) {}
  }

  async function call(method, path, body) {
    const token = await getToken();
    const res = await fetchImpl(apiBase + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
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

  const toMaps = (data) => Object.fromEntries(ENTITIES.map((e) => [e, new Map((data[e] || []).map((r) => [r.id, copy(r)]))]));
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
  const entitiesNow = () => { const st = getState(); return JSON.stringify(ENTITIES.map((e) => st[e])); };

  async function load() {
    let setAside = false;
    // Stay red with unsaved work: the red pill is what lets Nick retry if this fails.
    if (!hasUnsaved()) status('syncing');
    // Taken before the wait: a change by the time /all answers is an edit made during load.
    // Kept across failed attempts: edits made during an outage count too.
    if (preLoad === null) preLoad = entitiesNow();
    const body = await call('GET', '/all');
    writable = Object.fromEntries(ENTITIES.map((e) => [e, new Set(body.writable[e] || [])]));
    if (hasUnsaved()) {
      let saved = null;
      try { saved = JSON.parse(storage.getItem(BASE) || 'null'); } catch (_) {}
      if (saved) {
        base = toMaps(saved);
        since = stepBack(body.serverTime);
        loaded = true;
        status('save-failed', 'Unsaved changes from a previous session');
        return;
      }
      try {
        const state = getState();
        storage.setItem(ORPHAN, JSON.stringify(Object.fromEntries(ENTITIES.map((e) => [e, state[e]]))));
      } catch (_) {}
      log.warn('[v2-sync] unsaved edits had no base; local copy kept in', ORPHAN);
      clearUnsaved();
      setAside = true;
    }
    // An empty answer with a full local copy means the wrong target, not an empty life.
    const serverHolds = ENTITIES.some((e) => (body.data[e] || []).length);
    const state = getState();
    if (!serverHolds && ENTITIES.some((e) => (state[e] || []).length)) {
      throw new Error('The server returned no records. Keeping the local copy and not syncing.');
    }
    // push() can't send before a base exists, and applyAll would overwrite the edit, so
    // keep the local copy and say so rather than dropping it silently.
    if (!setAside && entitiesNow() !== preLoad) {
      setAside = true;
      try {
        const st = getState();
        storage.setItem(ORPHAN, JSON.stringify(Object.fromEntries(ENTITIES.map((e) => [e, st[e]]))));
      } catch (_) {}
      log.warn('[v2-sync] edit made during load set aside in', ORPHAN);
    }
    applyAll(body);
    loaded = true;
    preLoad = null;
    if (setAside) status('save-failed', 'Earlier edits were not saved. Please check them and enter them again.');
    else status('signed-in');
    render();
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
    const { record } = await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(made.id)}`);
    // The app now holds exactly what the server stored, as it will after a reload.
    for (const k of Object.keys(item)) if (!(k in record)) delete item[k];
    Object.assign(item, copy(record));
    base[entity].set(record.id, copy(record));
    remapRefs(localId, record.id);
  }

  async function sendUpdates(entity, updates, conflicts, { localWins }) {
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
        if (r.code !== 'VERSION_CONFLICT') throw new Error(`${u.id}: ${r.error}`);
        const { record: server } = await call('GET', `/get?entity=${entity}&id=${encodeURIComponent(u.id)}`);
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

  async function sendDeletes(entity, deletes) {
    for (const d of deletes) {
      try {
        await call('POST', '/delete', {
          entity, id: d.id, expectedVersion: d.expectedVersion,
          idempotencyKey: `web-del-${entity}-${d.id}-v${d.expectedVersion}`
        });
        base[entity].delete(d.id);
      } catch (e) {
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
    let wrote = false;
    // Projects go first, so records pointing at a new project get its real id.
    for (const e of ENTITIES) {
      if (!Array.isArray(state[e])) continue;
      const first = diffEntity(base[e], state[e], writable[e]);
      for (const item of first.creates) { await sendCreate(e, item); wrote = true; }
      const d = diffEntity(base[e], state[e], writable[e]);
      if (d.ignored.length) {
        log.warn('[v2-sync] not writable, not sent:', d.ignored.map((x) => `${x.id}.${x.field}`).join(', '));
        // Say it once: remember the app's value so this isn't a change on every autosave.
        for (const x of d.ignored) base[e].get(x.id)[x.field] = copy(x.value ?? null);
      }
      if (d.deletes.length > MASS_DELETE_LIMIT && !opts.allowMassDelete) {
        throw new Error(`Refusing to delete ${d.deletes.length} ${e} at once. Tap to confirm.`);
      }
      if (d.updates.length) { await sendUpdates(e, d.updates, conflicts, opts); wrote = true; }
      if (d.deletes.length) { await sendDeletes(e, d.deletes); wrote = true; }
    }
    return { conflicts, wrote };
  }

  async function push(opts = {}) {
    if (!loaded) return;
    if (pushing) { again = true; return; }
    pushing = true;
    try {
      do {
        again = false;
        let conflicts = [];
        let settled = false;
        for (let i = 0; i < MAX_PASSES; i++) {
          const r = await pass(opts);
          conflicts = r.conflicts;
          if (conflicts.length) break;
          // Only a pass with nothing left to send proves everything landed.
          if (!r.wrote) { settled = true; break; }
        }
        if (conflicts.length) throw new Error(`Also changed elsewhere: ${conflicts.join('; ')}. Tap to keep yours.`);
        if (!settled) throw new Error('Records kept changing while saving. Tap to try again.');
      } while (again);
      clearUnsaved();
      status('signed-in');
    } catch (e) {
      log.error('[v2-sync] save failed:', e);
      markUnsaved();
      status('save-failed', e.message || String(e));
    } finally {
      pushing = false;
    }
  }

  /** The red pill's tap: Nick has seen the warning, so his copy wins this time. */
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
    await push({ localWins: true, allowMassDelete: true });
  }

  async function poll() {
    if (!loaded || pushing || hasUnsaved() || isBusy()) return;
    const state = getState();
    const edited = () => ENTITIES.some((e) => {
      if (!Array.isArray(state[e])) return false;
      const d = diffEntity(base[e], state[e], writable[e]);
      return d.creates.length || d.updates.length || d.deletes.length;
    });
    // Checked again after each wait: an edit made meanwhile must not be replaced. since
    // stays put, so the next poll fetches the same changes.
    const standDown = () => pushing || hasUnsaved() || isBusy() || edited();
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

  return { load, push, retry, poll, get loaded() { return loaded; }, get pushing() { return pushing; } };
}

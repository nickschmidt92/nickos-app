// Behaviour of the web app's v2 sync, against a small in-memory stand-in for the API
// that enforces the same rules: versions, idempotency keys, writable fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createV2Sync, isNotAuthorized, retryDelayMs, diffEntity, createFields, overlappingFields, resolveBackend, ENTITIES, MASS_DELETE_LIMIT, MASS_CREATE_LIMIT } from '../v2-sync.js';

const WRITABLE = { tasks: ['title', 'status', 'notes', 'projectId', 'effort', 'dueDate'], projects: ['title', 'status'], decisions: ['title', 'why'], docs: ['title'], blockers: ['title', 'status'], reviews: ['title', 'summary', 'followup'] };
// Copied from nickos-v2 src/schema/entities.js. index.html's options are checked against
// this below, and the fake API refuses anything else, as the real one does.
const STATUS = {
  tasks: ['INBOX', 'NEXT', 'IN_PROGRESS', 'WAITING', 'DONE', 'DROPPED', 'COMPLETED'],
  projects: ['ACTIVE', 'PLANNED', 'SOMEDAY', 'COMPLETED', 'DROPPED'],
  decisions: ['DECIDED', 'DONE', 'COMPLETED', 'ACTIVE', 'DROPPED'],
  docs: ['ACTIVE', 'DONE', 'DROPPED'],
  blockers: ['OPEN', 'RESOLVED', 'DROPPED'],
  reviews: ['DONE', 'OPEN', 'DROPPED']
};
const badStatus = (entity, f) => f.status != null && !STATUS[entity].includes(f.status);

const memStore = () => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

function fakeApi(seed = {}) {
  const db = Object.fromEntries(ENTITIES.map((e) => [e, new Map((seed[e] || []).map((r) => [r.id, { versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-01-01T00:00:00.000Z', ...r }]))]));
  const api = { db, keys: new Map(), calls: [], down: false, n: 1000, clock: 1 };
  const stamp = () => new Date(Date.UTC(2026, 10, 5, 0, 0, api.clock++)).toISOString();
  // Through JSON, like a real response, so the app never shares objects with the store.
  const json = (status, body) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
  const update = (u) => {
    if (api.keys.has(u.idempotencyKey)) return { ...api.keys.get(u.idempotencyKey), replayed: true };
    const r = db[u.entity].get(u.id);
    if (!r) return { error: 'missing', code: 'NOT_FOUND', fail: 404 };
    if (r.versionSys !== u.expectedVersion) return { error: 'stale', code: 'VERSION_CONFLICT', fail: 409 };
    for (const k of Object.keys(u.patch)) if (!WRITABLE[u.entity].includes(k)) return { error: `bad ${k}`, code: 'VALIDATION', fail: 400 };
    if (badStatus(u.entity, u.patch)) return { error: `${u.entity}.status must be one of the list, got ${JSON.stringify(u.patch.status)}`, code: 'VALIDATION', fail: 400 };
    Object.assign(r, u.patch, { versionSys: r.versionSys + 1, updatedAtSys: stamp() });
    const out = { id: u.id, versionSys: r.versionSys };
    api.keys.set(u.idempotencyKey, out);
    return out;
  };
  api.fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname; const body = init.body ? JSON.parse(init.body) : null;
    api.calls.push(`${init.method} ${path}`);
    assert.match(init.headers.Authorization, /^Bearer /);
    if (api.down) throw new Error('offline');
    if (path === '/all') return json(200, { data: Object.fromEntries(ENTITIES.map((e) => [e, [...db[e].values()].filter((r) => r.lifecycleSys === 'LIVE')])), writable: WRITABLE, serverTime: stamp() });
    if (path === '/get') { const r = db[u.searchParams.get('entity')].get(u.searchParams.get('id')); return r ? json(200, { record: r }) : json(404, { error: 'none' }); }
    if (path === '/changes') { const since = u.searchParams.get('since'); return json(200, { hasMore: false, serverTime: stamp(), data: Object.fromEntries(ENTITIES.map((e) => [e, [...db[e].values()].filter((r) => r.updatedAtSys > since)])) }); }
    if (path === '/add') {
      if (api.keys.has(body.idempotencyKey)) return json(200, { ...api.keys.get(body.idempotencyKey), replayed: true });
      const prefix = { tasks: 'T', projects: 'P', decisions: 'D', docs: 'DOC', blockers: 'B', reviews: 'R' }[body.entity];
      for (const k of Object.keys(body.fields)) if (!WRITABLE[body.entity].includes(k)) return json(400, { error: `bad ${k}`, code: 'VALIDATION' });
      if (badStatus(body.entity, body.fields)) return json(400, { error: 'bad status', code: 'VALIDATION' });
      const id = `${prefix}-${api.n++}`;
      db[body.entity].set(id, { ...body.fields, id, versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: stamp() });
      api.keys.set(body.idempotencyKey, { id, versionSys: 1 });
      return json(200, { id, versionSys: 1 });
    }
    if (path === '/batchUpdate') {
      const results = body.updates.map((x) => { const r = update(x); return r.fail ? { ok: false, id: x.id, code: r.code, error: r.error } : { ok: true, ...r }; });
      return json(results.every((r) => r.ok) ? 200 : 207, { results });
    }
    if (path === '/delete') {
      const r = db[body.entity].get(body.id);
      if (r.versionSys !== body.expectedVersion) return json(409, { error: 'stale', code: 'VERSION_CONFLICT' });
      Object.assign(r, { lifecycleSys: 'DELETED', versionSys: r.versionSys + 1, updatedAtSys: stamp() });
      return json(200, { id: body.id, versionSys: r.versionSys });
    }
    return json(404, { error: 'no route' });
  };
  return api;
}

async function setup(seed, opts = {}) {
  const api = fakeApi(seed);
  const state = opts.state || {};
  const storage = opts.storage || memStore();
  const statuses = [];
  let renders = 0;
  const logs = { warn: [], error: [] };
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage, fetchImpl: api.fetchImpl,
    onStatus: (s, e) => statuses.push([s, e]), render: () => { renders++; }, isBusy: opts.isBusy,
    log: { warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.join(' ')) }
  });
  if (opts.preload) await opts.preload({ api, state, storage });
  await sync.load();
  return { api, state, storage, sync, statuses, logs, last: () => statuses.at(-1), renders: () => renders };
}
const T = (n, o = {}) => ({ id: `T-${n}`, title: `t${n}`, status: 'NEXT', ...o });
const writes = (api) => api.calls.filter((c) => c.startsWith('POST'));

test('load: replaces the app state with the server copy and goes green', async () => {
  const s = await setup({ tasks: [T(1)] });
  assert.equal(s.state.tasks[0].title, 't1');
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.renders(), 1);
});

test('no change, no writes: the 30-second autosave costs nothing', async () => {
  const s = await setup({ tasks: [T(1)] });
  await s.sync.push(); await s.sync.push();
  assert.deepEqual(writes(s.api), []);
});

test('an edit made during load is sent, not overwritten', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const state = { tasks: [{ ...T(1), versionSys: 1 }] };
  const storage = memStore();
  const statuses = [];
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage,
    fetchImpl: (...a) => { if (String(a[0]).endsWith('/all') && state.tasks[0].title === 't1') state.tasks[0].title = 'typed during load'; return api.fetchImpl(...a); },
    onStatus: (s, e) => statuses.push([s, e]), render: () => {},
    log: { warn: () => {}, error: () => {} }
  });
  await sync.load();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(api.db.tasks.get('T-1').title, 'typed during load');
  assert.equal(state.tasks[0].title, 'typed during load');
  assert.equal(storage.getItem('nickos_v2_pending'), null);
});

test('a load with no edit during it stays green and sets nothing aside', async () => {
  const s = await setup({ tasks: [T(1)] }, { state: { tasks: [T(1)] } });
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.storage.getItem('nickos_v2_orphan') ?? null, null);
});

test('push before load does nothing, so a boot race cannot delete anything', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const sync = createV2Sync({ apiBase: 'https://a', getToken: async () => 't', getState: () => ({ tasks: [] }), storage: memStore(), fetchImpl: api.fetchImpl, onStatus() {}, render() {} });
  await sync.push();
  assert.deepEqual(api.calls, []);
});

test('edit: sends only the changed field with the version it was based on', async () => {
  const s = await setup({ tasks: [T(1, { notes: 'keep' })] });
  s.state.tasks[0].title = 'edited';
  await s.sync.push();
  const r = s.api.db.tasks.get('T-1');
  assert.equal(r.title, 'edited');
  assert.equal(r.notes, 'keep');
  assert.equal(r.versionSys, 2);
  assert.equal(s.last()[0], 'signed-in');
  s.state.tasks[0].title = 'again';
  await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1').versionSys, 3);
});

test('a read-only field the app stamps is not sent, and does not block the rest', async () => {
  const s = await setup({ projects: [{ id: 'P-1', title: 'p', status: 'ACTIVE', updated: 'old' }] });
  s.state.projects[0].updated = 'now';
  s.state.projects[0].title = 'renamed';
  await s.sync.push();
  assert.equal(s.api.db.projects.get('P-1').title, 'renamed');
  assert.equal(s.api.db.projects.get('P-1').updated, 'old');
  assert.match(s.logs.warn.join(), /P-1\.updated/);
  assert.equal(s.last()[0], 'signed-in');
  const warned = s.logs.warn.length;
  await s.sync.push();
  assert.equal(s.logs.warn.length, warned, 'warned again on the next autosave');
});

test('create: the server assigns the id, and read-only and blank fields stay out', async () => {
  const s = await setup({});
  s.state.tasks.push({ id: 'T-ABCDE', title: 'new', status: 'NEXT', effort: 'S', deps: '', created: '', occurrences: 0, dueDate: '' });
  await s.sync.push();
  const made = s.state.tasks[0];
  assert.equal(made.id, 'T-1000');
  const stored = s.api.db.tasks.get('T-1000');
  assert.equal(stored.effort, 'S');
  for (const k of ['deps', 'created', 'occurrences', 'dueDate']) assert.ok(!(k in stored), k);
  assert.equal(stored.versionSys, 1, 'a create must not be followed by a needless update');
  await s.sync.push();
  assert.equal(s.api.db.tasks.size, 1);
  assert.equal(s.api.db.tasks.get('T-1000').versionSys, 1);
});

test('create: a task pointing at a new project gets the real project id', async () => {
  const s = await setup({});
  s.state.projects.push({ id: 'P-LOCAL', title: 'proj', status: 'ACTIVE' });
  s.state.tasks.push({ id: 'T-LOCAL', title: 'child', status: 'NEXT', projectId: 'P-LOCAL' });
  await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1001').projectId, 'P-1000');
  assert.equal(s.state.tasks[0].projectId, 'P-1000');
});

test('create: a review with no id is saved once', async () => {
  const s = await setup({});
  s.state.reviews.push({ title: 'Weekly review', summary: 's', followup: 'f' });
  await s.sync.push(); await s.sync.push();
  assert.equal(s.api.db.reviews.size, 1);
});

test('create retried after a failure replays instead of duplicating', async () => {
  const s = await setup({});
  const real = s.api.fetchImpl;
  let dropped = false;
  // The server takes the create but the response is lost on the /get that follows.
  s.api.fetchImpl = async (url, init) => {
    if (!dropped && url.includes('/get')) { dropped = true; throw new Error('offline'); }
    return real(url, init);
  };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => s.state, storage: s.storage, fetchImpl: (...a) => s.api.fetchImpl(...a), onStatus() {}, render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  s.state.tasks = [{ id: 'T-RETRY', title: 'once', status: 'NEXT' }];
  await sync.push();
  await sync.retry();
  assert.equal(s.api.db.tasks.size, 1);
});

test('delete: removing a record from the app is a soft delete on the server', async () => {
  const s = await setup({ tasks: [T(1), T(2)] });
  s.state.tasks = s.state.tasks.filter((t) => t.id !== 'T-1');
  await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1').lifecycleSys, 'DELETED');
  assert.equal(s.api.db.tasks.get('T-1').title, 't1');
  assert.equal(s.api.db.tasks.get('T-2').lifecycleSys, 'LIVE');
});

test('mass delete: a retry tap never approves it, only the explicit confirmation does', async () => {
  const many = Array.from({ length: MASS_DELETE_LIMIT + 1 }, (_, i) => T(i));
  const s = await setup({ tasks: many });
  s.state.tasks = [];
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /Refusing to delete 21 tasks/);
  assert.ok([...s.api.db.tasks.values()].every((r) => r.lifecycleSys === 'LIVE'));
  await s.sync.retry();
  await s.sync.retry();
  assert.ok([...s.api.db.tasks.values()].every((r) => r.lifecycleSys === 'LIVE'));
  assert.equal(s.last()[0], 'save-failed');
  assert.equal(s.sync.massDeletes[0].count, 21);
  assert.equal(s.sync.massDeletes[0].titles[0], 't0');
  await s.sync.confirmMassDelete();
  assert.ok([...s.api.db.tasks.values()].every((r) => r.lifecycleSys === 'DELETED'));
  assert.equal(s.last()[0], 'signed-in');
});

test('mass delete: declining puts the records back and goes green with nothing deleted', async () => {
  const many = Array.from({ length: MASS_DELETE_LIMIT + 1 }, (_, i) => T(i));
  const s = await setup({ tasks: many });
  s.state.tasks = [];
  await s.sync.retry();
  s.sync.restoreMassDelete();
  assert.equal(s.state.tasks.length, 21);
  await s.sync.retry();
  assert.equal(s.last()[0], 'signed-in');
  assert.ok([...s.api.db.tasks.values()].every((r) => r.lifecycleSys === 'LIVE'));
  assert.deepEqual(writes(s.api), []);
});

test('mass delete refusal still sends the other edits', async () => {
  const many = Array.from({ length: MASS_DELETE_LIMIT + 1 }, (_, i) => T(i));
  const s = await setup({ tasks: many, blockers: [{ id: 'B-1', title: 'b', status: 'OPEN' }] });
  s.state.tasks = [];
  s.state.blockers[0].title = 'edited';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.equal(s.api.db.blockers.get('B-1').title, 'edited');
});

test('an entity missing from the app is left alone, never read as "all deleted"', async () => {
  const s = await setup({ tasks: [T(1)] });
  delete s.state.tasks;
  await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1').lifecycleSys, 'LIVE');
});

test('conflict, different fields: the edit is reapplied and the other change survives', async () => {
  const s = await setup({ tasks: [T(1, { notes: 'orig' })] });
  Object.assign(s.api.db.tasks.get('T-1'), { notes: 'from claude', versionSys: 2 });
  s.state.tasks[0].title = 'mine';
  await s.sync.push();
  const r = s.api.db.tasks.get('T-1');
  assert.equal(r.title, 'mine');
  assert.equal(r.notes, 'from claude');
  assert.equal(s.state.tasks[0].notes, 'from claude');
  assert.equal(s.last()[0], 'signed-in');
});

test('conflict, same field: nothing is overwritten, it goes red, and the tap keeps Nick\'s copy', async () => {
  const s = await setup({ tasks: [T(1)] });
  Object.assign(s.api.db.tasks.get('T-1'), { title: 'from claude', versionSys: 2 });
  s.state.tasks[0].title = 'mine';
  await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1').title, 'from claude');
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /T-1 \(title\)/);
  assert.equal(s.storage.getItem('nickos_unsaved'), '1');
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-1').title, 'mine');
  assert.equal(s.storage.getItem('nickos_unsaved'), null);
});

test('offline: the edit stays local and red, then lands on retry', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.api.down = true;
  s.state.tasks[0].title = 'offline edit';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  s.api.down = false;
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-1').title, 'offline edit');
  assert.equal(s.last()[0], 'signed-in');
});

test('a refused field goes red and names the record', async () => {
  const s = await setup({ tasks: [T(1)] });
  const real = s.api.fetchImpl;
  s.api.fetchImpl = async (u, i) => (u.includes('/batchUpdate') ? { ok: true, status: 207, json: async () => ({ results: [{ ok: false, id: 'T-1', code: 'VALIDATION', error: 'bad status' }] }) } : real(u, i));
  const statuses = [];
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => s.state, storage: memStore(), fetchImpl: (...a) => s.api.fetchImpl(...a), onStatus: (a, b) => statuses.push([a, b]), render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  s.state.tasks[0].title = 'x';
  await sync.push();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  assert.match(statuses.at(-1)[1], /T-1: bad status/);
});

test('reload with unsaved edits: the local copy survives and is retried from its own base', async () => {
  const a = await setup({ tasks: [T(1), T(2)] });
  a.api.down = true;
  a.state.tasks[0].title = 'unsaved';
  await a.sync.push();
  a.api.down = false;

  const statuses = [];
  const state = { tasks: a.state.tasks };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: a.storage, fetchImpl: a.api.fetchImpl, onStatus: (x, y) => statuses.push([x, y]), render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  assert.equal(state.tasks[0].title, 'unsaved');
  await sync.retry();
  assert.equal(a.api.db.tasks.get('T-1').title, 'unsaved');
  assert.equal(a.api.db.tasks.get('T-2').lifecycleSys, 'LIVE');
});

test('reload with unsaved edits but no base: nothing is written and the local copy is set aside', async () => {
  const storage = memStore();
  storage.setItem('nickos_unsaved', '1');
  const s = await setup({ tasks: [T(1)] }, { storage, state: { tasks: [{ id: 'T-1', title: 'stale' }], projects: [] } });
  assert.deepEqual(writes(s.api), []);
  assert.equal(s.state.tasks[0].title, 't1');
  assert.match(storage.getItem('nickos_v2_orphan'), /stale/);
  assert.equal(storage.getItem('nickos_unsaved'), null);
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /not saved/);
});

test('an edit made while the first load failed is sent once the load works', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const state = { tasks: [{ ...T(1), versionSys: 1 }] };
  const storage = memStore();
  const statuses = [];
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage, fetchImpl: api.fetchImpl,
    onStatus: (s, e) => statuses.push([s, e]), render: () => {}, log: { warn: () => {}, error: () => {} }
  });
  api.down = true;
  await assert.rejects(() => sync.load());
  state.tasks[0].title = 'typed during the outage';
  sync.noteEdit();
  assert.equal(storage.getItem('nickos_v2_pending'), '1');
  api.down = false;
  await sync.load();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(api.db.tasks.get('T-1').title, 'typed during the outage');
});

test('poll: an edit made while the request is out is not replaced, and the change is not skipped', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const state = { tasks: [T(1)] };
  let hook = null;
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage: memStore(),
    fetchImpl: (url, init) => {
      if (hook && String(url).includes('/changes')) {
        const h = hook; hook = null; h();
        return Promise.resolve(new Response(JSON.stringify({
          hasMore: false, serverTime: new Date().toISOString(),
          data: { tasks: [{ ...T(1, { title: 'from elsewhere' }), versionSys: 2, lifecycleSys: 'LIVE' }] }
        }), { status: 200 }));
      }
      return api.fetchImpl(url, init);
    },
    onStatus: () => {}, render: () => {}, log: { warn: () => {}, error: () => {} }
  });
  await sync.load();
  hook = () => { state.tasks[0].title = 'typing'; };
  await sync.poll();
  assert.equal(state.tasks[0].title, 'typing');
  assert.equal(writes(api).length, 0);
});

test('unsaved work with the server down at startup: stays red, and the tap loads then saves', async () => {
  const a = await setup({ tasks: [T(1)] });
  a.api.down = true;
  a.state.tasks[0].title = 'unsaved';
  await a.sync.push();
  const statuses = [];
  const state = { tasks: a.state.tasks };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: a.storage, fetchImpl: a.api.fetchImpl, onStatus: (x, y) => statuses.push([x, y]), render() {}, log: { warn() {}, error() {} } });
  await assert.rejects(sync.load(), /offline/);
  assert.ok(!statuses.some(([s]) => s === 'syncing'), 'must not leave the red state');
  await sync.retry();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  a.api.down = false;
  await sync.retry();
  assert.equal(a.api.db.tasks.get('T-1').title, 'unsaved');
  assert.equal(statuses.at(-1)[0], 'signed-in');
});

test('an edit that never lands because others keep writing stays red, not green', async () => {
  const s = await setup({ tasks: [T(1)] });
  const real = s.api.fetchImpl;
  // Another writer changes a different field right before each of our updates.
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => s.state, storage: s.storage, onStatus: (a, b) => s.statuses.push([a, b]), render() {}, log: { warn() {}, error() {} },
    fetchImpl: async (u, i) => {
      if (u.includes('/batchUpdate')) { const r = s.api.db.tasks.get('T-1'); r.versionSys++; r.notes = `other ${r.versionSys}`; }
      return real(u, i);
    } });
  await sync.load();
  s.state.tasks[0].title = 'mine';
  await sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /kept changing/);
  assert.equal(s.storage.getItem('nickos_unsaved'), '1');
  assert.notEqual(s.api.db.tasks.get('T-1').title, 'mine');
});

test('an empty server never wipes a full local copy, and an empty start still works', async () => {
  const state = { tasks: [T(1)] };
  const api = fakeApi({});
  const sync = createV2Sync({ apiBase: 'https://a', getToken: async () => 't', getState: () => state, storage: memStore(), fetchImpl: api.fetchImpl, onStatus() {}, render() {} });
  await assert.rejects(sync.load(), /no records/);
  assert.equal(state.tasks.length, 1);
  await sync.push();
  assert.deepEqual(writes(api), []);
  const fresh = await setup({});
  assert.equal(fresh.last()[0], 'signed-in');
});

test('poll: picks up another writer\'s edit, add and delete, and only then re-renders', async () => {
  const s = await setup({ tasks: [T(1), T(2)] });
  const before = s.renders();
  await s.sync.poll();
  assert.equal(s.renders(), before);
  Object.assign(s.api.db.tasks.get('T-1'), { title: 'by claude', versionSys: 2, updatedAtSys: '2026-12-01T00:00:00.000Z' });
  Object.assign(s.api.db.tasks.get('T-2'), { lifecycleSys: 'DELETED', versionSys: 2, updatedAtSys: '2026-12-01T00:00:00.000Z' });
  s.api.db.tasks.set('T-3', { ...T(3), versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-12-01T00:00:00.000Z' });
  await s.sync.poll();
  assert.deepEqual(s.state.tasks.map((t) => t.id).sort(), ['T-1', 'T-3']);
  assert.equal(s.state.tasks.find((t) => t.id === 'T-1').title, 'by claude');
  assert.equal(s.renders(), before + 1);
  await s.sync.push();
  assert.deepEqual(writes(s.api), []);
});

test('poll: a truncated change list means a full reload, never skipping what it did not get', async () => {
  const s = await setup({ tasks: [T(1)] });
  const real = s.api.fetchImpl;
  s.api.db.tasks.set('T-2', { ...T(2), versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-01-01T00:00:00.000Z' });
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => s.state, storage: memStore(), onStatus() {}, render() {}, log: { warn() {}, error() {} },
    fetchImpl: async (u, i) => (u.includes('/changes') ? { ok: true, status: 200, json: async () => ({ hasMore: true, serverTime: '2026-12-01T00:00:00.000Z', data: {} }) } : real(u, i)) });
  s.api.db.tasks.delete('T-2');
  await sync.load();
  s.api.db.tasks.set('T-2', { ...T(2), versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-01-01T00:00:00.000Z' });
  await sync.poll();
  assert.deepEqual(s.state.tasks.map((t) => t.id).sort(), ['T-1', 'T-2']);
});

test('poll: stands down during a local edit, an open form or unsaved work', async () => {
  let busy = false;
  const s = await setup({ tasks: [T(1)] }, { isBusy: () => busy });
  const count = () => s.api.calls.filter((c) => c.includes('/changes')).length;
  busy = true; await s.sync.poll(); busy = false;
  assert.equal(count(), 0);
  s.state.tasks[0].title = 'typing';
  await s.sync.poll();
  assert.equal(count(), 0);
  await s.sync.push();
  await s.sync.poll();
  assert.equal(count(), 1);
});

test('pure helpers', () => {
  const w = new Set(['title']);
  const base = new Map([['A', { id: 'A', title: 'x', versionSys: 4 }]]);
  assert.deepEqual(diffEntity(base, [{ id: 'A', title: 'y', versionSys: 4 }], w).updates, [{ id: 'A', patch: { title: 'y' }, expectedVersion: 4 }]);
  assert.deepEqual(diffEntity(base, [], w).deletes, [{ id: 'A', expectedVersion: 4 }]);
  assert.deepEqual(createFields({ title: 'x', other: 'y', blank: '' }, new Set(['title', 'blank'])), { title: 'x' });
  assert.deepEqual(overlappingFields({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 3, b: 3 }), ['a']);
  assert.deepEqual(overlappingFields({ a: 1 }, { a: 3 }, { a: 3 }), []);
});

test('backend: v1 by default; the dev override works on localhost and nowhere else', () => {
  const s = memStore();
  s.setItem('nickos_backend_dev', JSON.stringify({ mode: 'v2', apiBase: 'http://localhost:8787', devToken: 'x' }));
  assert.equal(resolveBackend({ mode: 'v1' }, 'nickschmidt92.github.io', s).mode, 'v1');
  assert.equal(resolveBackend({ mode: 'v1' }, 'nickschmidt92.github.io', s).devToken, undefined);
  assert.equal(resolveBackend({ mode: 'v1' }, 'localhost', s).mode, 'v2');
  assert.equal(resolveBackend({ mode: 'v2', apiBase: 'https://x' }, 'nickschmidt92.github.io', s).apiBase, 'https://x');
  assert.equal(resolveBackend(undefined, 'nickschmidt92.github.io', memStore()).mode, 'v1');
});

test('the shipped config points at the v2 API root, and the service worker caches the new module', () => {
  const root = new URL('../', import.meta.url);
  assert.match(readFileSync(new URL('firebase-config.js', root), 'utf8'), /backend\s*=\s*\{\s*mode:\s*'v2',\s*apiBase:\s*'https:\/\/[^'\/]+'\s*\}/);
  assert.match(readFileSync(new URL('service-worker.js', root), 'utf8'), /'\.\/v2-sync\.js\?v=\d+'/);
});

// ── Edits survive the app closing (B-0127) ───────────────────────────────────────

const session = (api, state, storage, statuses = []) => createV2Sync({
  apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage,
  fetchImpl: (...a) => api.fetchImpl(...a), onStatus: (s, e) => statuses.push([s, e]), render: () => {},
  log: { warn: () => {}, error: () => {} }
});
const reopen = (storage, local) => copyJson(local);
const copyJson = (x) => JSON.parse(JSON.stringify(x));

test('app opened with the load failing, edit, closed, reopened online: the edit is sent', async () => {
  const api = fakeApi({ tasks: [T(1), T(2)] });
  const storage = memStore();
  const first = { tasks: copyJson([...api.db.tasks.values()]) };
  const a = session(api, first, storage);
  a.captureBoot();
  api.down = true;
  await assert.rejects(() => a.load());
  first.tasks[0].title = 'edited offline';
  await a.push();
  assert.equal(storage.getItem('nickos_v2_pending'), '1');
  // Reopen: the app boots from its saved local copy, which holds the edit.
  api.down = false;
  const second = reopen(storage, first);
  const statuses = [];
  const b = session(api, second, storage, statuses);
  b.captureBoot();
  await b.load();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(api.db.tasks.get('T-1').title, 'edited offline');
  assert.equal(second.tasks.find((t) => t.id === 'T-1').title, 'edited offline');
  assert.equal(storage.getItem('nickos_v2_pending'), null);
  assert.equal(storage.getItem('nickos_v2_base'), null);
});

test('tab closed while the save is in flight: reopening finishes it, exactly once', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const first = { tasks: [] };
  const a = session(api, first, storage);
  await a.load();
  first.tasks[0].title = 'edit';
  const realFetch = api.fetchImpl;
  // The request never answers, and the tab is gone.
  api.fetchImpl = () => new Promise(() => {});
  a.push();
  await new Promise((r) => setImmediate(r));
  assert.equal(storage.getItem('nickos_v2_pending'), '1', 'recorded before the send finished');
  api.fetchImpl = realFetch;
  const second = copyJson(first);
  const statuses = [];
  const b = session(api, second, storage, statuses);
  b.captureBoot();
  await b.load();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(api.db.tasks.get('T-1').title, 'edit');
  assert.equal(api.db.tasks.get('T-1').versionSys, 2);
});

test('a save that landed but whose answer was lost replays instead of writing twice', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const first = { tasks: [] };
  const a = session(api, first, storage);
  await a.load();
  first.tasks[0].title = 'edit';
  const realFetch = api.fetchImpl;
  api.fetchImpl = (...args) => {
    if (String(args[0]).endsWith('/batchUpdate')) { realFetch(...args); return new Promise(() => {}); }
    return realFetch(...args);
  };
  a.push();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(api.db.tasks.get('T-1').versionSys, 2);
  api.fetchImpl = realFetch;
  const second = copyJson(first);
  const b = session(api, second, storage);
  b.captureBoot();
  await b.load();
  assert.equal(api.db.tasks.get('T-1').versionSys, 2, 'no second write');
  assert.equal(second.tasks[0].versionSys, 2);
});

test('edit while signed out, then sign in: the edit is sent', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const state = { tasks: [] };
  const statuses = [];
  const s = session(api, state, storage, statuses);
  await s.load();
  s.signedOut();
  state.tasks[0].title = 'edited signed out';
  s.noteEdit(); // cloud-sync's save wrapper runs this even with no user
  await s.load();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(api.db.tasks.get('T-1').title, 'edited signed out');
  assert.equal(state.tasks[0].title, 'edited signed out');
});

test('recovering an edit never treats a stale local copy as deletions or new records', async () => {
  const api = fakeApi({ tasks: [T(1), T(2)] });
  const storage = memStore();
  // The local copy never saw T-3 and still has T-9, which the server no longer has live.
  const local = { tasks: [{ ...T(1), versionSys: 1 }, { ...T(2), versionSys: 1 }, { ...T(9), versionSys: 1 }] };
  api.db.tasks.set('T-3', { ...T(3), versionSys: 1, lifecycleSys: 'LIVE' });
  const s = session(api, local, storage);
  s.captureBoot();
  local.tasks[0].title = 'real edit';
  s.noteEdit();
  await s.load();
  assert.equal(api.db.tasks.get('T-1').title, 'real edit');
  assert.equal(api.db.tasks.get('T-2').lifecycleSys, 'LIVE');
  assert.equal(api.db.tasks.has('T-9'), false, 'no record re-created from the stale copy');
  assert.deepEqual(local.tasks.map((t) => t.id).sort(), ['T-1', 'T-2', 'T-3'], 'caught up with the server afterwards');
});

test('an edit made while a save is in flight is still sent, with no red pill', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.state.tasks[0].title = 'one';
  const p = s.sync.push();
  s.state.tasks[0].notes = 'two';
  await s.sync.push();
  await p;
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.api.db.tasks.get('T-1').title, 'one');
  assert.equal(s.api.db.tasks.get('T-1').notes, 'two');
});

test('a new id-less record has its id saved locally before the first send', async () => {
  const api = fakeApi({});
  const storage = memStore();
  const state = { tasks: [] };
  let savedIds = null;
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => state, storage,
    fetchImpl: (...a) => { if (String(a[0]).endsWith('/add')) assert.ok(savedIds?.[0], 'saved first'); return api.fetchImpl(...a); },
    onStatus: () => {}, render: () => {}, log: { warn: () => {}, error: () => {} },
    saveLocal: () => { savedIds = state.tasks.map((t) => t.id); }
  });
  await sync.load();
  state.tasks.push({ title: 'new', status: 'NEXT' });
  await sync.push();
  assert.match(savedIds[0], /^LOCAL-/);
  assert.equal(api.db.tasks.size, 1);
});

test('a lost /add answer then a reload creates one record, not two', async () => {
  const api = fakeApi({});
  const storage = memStore();
  const first = { tasks: [] };
  let persisted = null;
  const a = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => first, storage,
    fetchImpl: (...args) => api.fetchImpl(...args), onStatus: () => {}, render: () => {}, log: { warn: () => {}, error: () => {} },
    saveLocal: () => { persisted = copyJson(first); }
  });
  await a.load();
  first.tasks.push({ title: 'new', status: 'NEXT' });
  const realFetch = api.fetchImpl;
  api.fetchImpl = (...args) => {
    if (String(args[0]).endsWith('/add')) { realFetch(...args); return new Promise(() => {}); }
    return realFetch(...args);
  };
  a.push();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(api.db.tasks.size, 1);
  api.fetchImpl = realFetch;
  const b = session(api, persisted, storage);
  b.captureBoot();
  await b.load();
  assert.equal(api.db.tasks.size, 1);
  assert.equal(persisted.tasks.length, 1);
  assert.match(persisted.tasks[0].id, /^T-/);
});

// ── One bad record doesn't stop the rest (B-0126) ────────────────────────────────

test('a rejected status names the record and every other edit is still sent', async () => {
  const s = await setup({ tasks: [T(1), T(2)], blockers: [{ id: 'B-1', title: 'b', status: 'OPEN' }] });
  s.state.tasks[0].status = 'TODAY';
  s.state.tasks[1].title = 'good task edit';
  s.state.blockers[0].title = 'good blocker edit';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /T-1/);
  assert.equal(s.api.db.tasks.get('T-1').status, 'NEXT');
  assert.equal(s.api.db.tasks.get('T-2').title, 'good task edit');
  assert.equal(s.api.db.blockers.get('B-1').title, 'good blocker edit');
  // Corrected, the tap clears it.
  s.state.tasks[0].status = 'IN_PROGRESS';
  await s.sync.retry();
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.api.db.tasks.get('T-1').status, 'IN_PROGRESS');
});

test('a rejected new record stays local, red, and blocks nothing else', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.state.tasks.push({ title: 'bad new', status: 'TODAY' });
  s.state.tasks[0].title = 'good edit';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /bad new/);
  assert.equal(s.api.db.tasks.get('T-1').title, 'good edit');
  assert.equal(s.api.db.tasks.size, 1);
});

test('nothing is saved pointing at a project that failed to create', async () => {
  const s = await setup({ tasks: [T(1)] });
  const project = { id: 'LOCAL-p', title: 'p', status: 'ON_HOLD' };
  s.state.projects = [project];
  s.state.tasks.push({ id: 'LOCAL-t', title: 'child', status: 'NEXT', projectId: 'LOCAL-p' });
  s.state.tasks[0].projectId = 'LOCAL-p';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.equal(s.api.db.tasks.size, 1, 'child not created');
  assert.equal(s.api.db.tasks.get('T-1').projectId, undefined, 'no dangling reference');
});

test('a network failure still stops the push and goes red', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.state.tasks[0].title = 'x';
  s.api.down = true;
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /offline/);
  assert.equal(s.storage.getItem('nickos_unsaved'), '1');
});

test('index.html offers and writes only statuses the schema accepts', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const forms = { taskStatus: 'tasks', projectStatus: 'projects', decisionStatus: 'decisions', blockerStatus: 'blockers' };
  for (const [id, entity] of Object.entries(forms)) {
    const m = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
    assert.ok(m, id);
    const values = [...m[1].matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
    assert.ok(values.length > 1, id);
    for (const v of values) {
      if (v === '' && entity === 'decisions') continue; // saved as null, and decisions.status is optional
      assert.ok(STATUS[entity].includes(v), `${id} offers ${JSON.stringify(v)}`);
    }
  }
  for (const m of html.matchAll(/(?:batchChangeStatus|triageAction)\('([A-Z_]+)'\)/g)) {
    if (m[1] === 'DELETE' || m[1] === 'DEFER') continue;
    assert.ok(STATUS.tasks.includes(m[1]), `an action writes ${m[1]}`);
  }
  assert.doesNotMatch(html, /d\.status\.toLowerCase\(\)\}">\$\{d\.status\}<\/span>\s*(?!`)/, 'a decision with no status must not throw');
});

test('the retry tap reaches a visible confirmation, and the failure text is on the pill', () => {
  const src = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
  assert.match(src, /v2\.massDeletes\.length/);
  assert.match(src, /window\.confirm\(/);
  assert.match(src, /escapeHtml\(cloud\.lastSaveError\)/);
  assert.doesNotMatch(src, /title="\$\{\(cloud\.lastSaveError/);
  assert.match(readFileSync(new URL('../v2-sync.js', import.meta.url), 'utf8'), /async function retry[\s\S]*?await push\(\{ consent \}\);/);
});

test('sync waits for the local copy before it can load or sign out', () => {
  const src = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
  assert.match(src, /async function startV2\(\) \{[^}]*\}?[\s\S]{0,120}?await localCopyReady;\s*try \{\s*await v2\.load\(\);/);
  assert.match(src, /localCopyReady\.then\(\(\) => v2\.signedOut\(\)\)/);
});

test('signing out with a failed save keeps the base that edit was made against', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.state.tasks[0].title = 'x';
  s.api.down = true;
  await s.sync.push();
  const savedBase = s.storage.getItem('nickos_v2_base');
  s.sync.signedOut();
  s.state.tasks[0].notes = 'more';
  s.sync.noteEdit();
  assert.equal(s.storage.getItem('nickos_v2_base'), savedBase);
  s.api.down = false;
  await s.sync.load();
  assert.equal(s.last()[0], 'save-failed');
  await s.sync.retry();
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.api.db.tasks.get('T-1').title, 'x');
  assert.equal(s.api.db.tasks.get('T-1').notes, 'more');
});

test('a pending edit whose base is unreadable is set aside and flagged, not overwritten', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  storage.setItem('nickos_v2_pending', '1');
  storage.setItem('nickos_v2_base', '{broken');
  const state = { tasks: [{ ...T(1), title: 'local edit', versionSys: 1 }] };
  const statuses = [];
  const s = session(api, state, storage, statuses);
  await s.load();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  assert.match(storage.getItem('nickos_v2_orphan'), /local edit/);
  assert.deepEqual(api.calls.filter((c) => c.startsWith('POST')), []);
  assert.equal(storage.getItem('nickos_v2_pending'), null);
});


test('sync starts only after index.html says the local copy is loaded', () => {
  const src = readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const code = src.slice(src.indexOf('const localCopyReady'), src.indexOf('let pollTimer'));
  assert.doesNotMatch(code, /readyState/);
  assert.match(code, /nickosLocalCopyLoaded/);
  const boot = html.slice(html.indexOf("addEventListener('DOMContentLoaded'"));
  assert.ok(boot.indexOf('loadFromLocalStorage();') < boot.indexOf('window.nickosLocalCopyLoaded = true'));
});

test('an empty boot copy with a full local copy sends no creates at all', async () => {
  const api = fakeApi({ tasks: [T(1)], projects: Array.from({ length: 30 }, (_, i) => ({ id: `P-${i}`, title: `p${i}`, status: 'ACTIVE' })) });
  const state = { tasks: [], projects: [] };
  const statuses = [];
  const s = session(api, state, memStore(), statuses);
  s.captureBoot(); // the bug: taken before the local copy was loaded
  state.projects = Array.from({ length: 30 }, (_, i) => ({ id: `P-${i}`, title: `p${i}`, status: 'ACTIVE' }));
  await s.load();
  assert.deepEqual(api.calls.filter((c) => c === 'POST /add'), []);
  assert.equal(api.db.projects.size, 30);
  assert.equal(statuses.at(-1)[0], 'save-failed');
  assert.match(statuses.at(-1)[1], /Refusing to create 30 projects/);
  await s.retry();
  assert.deepEqual(api.calls.filter((c) => c === 'POST /add'), []);
});

test('a normal number of new records is still created', async () => {
  const s = await setup({ tasks: [T(1)] });
  for (let i = 0; i < MASS_CREATE_LIMIT; i++) s.state.tasks.push({ title: `new ${i}`, status: 'NEXT' });
  await s.sync.push();
  assert.equal(s.api.calls.filter((c) => c === 'POST /add').length, MASS_CREATE_LIMIT);
  assert.equal(s.last()[0], 'signed-in');
});

test('a second set-aside keeps the first, and only records that differ are stored', async () => {
  const api = fakeApi({ tasks: [T(1), T(2)] });
  const storage = memStore();
  for (const title of ['first edit', 'second edit']) {
    storage.setItem('nickos_v2_pending', '1');
    storage.setItem('nickos_v2_base', '{broken');
    const state = { tasks: [{ ...T(1), title, versionSys: 1 }, { ...T(2), versionSys: 1, lifecycleSys: 'LIVE' }] };
    await session(api, state, storage, []).load();
  }
  const s = session(api, { tasks: [] }, storage, []);
  const list = s.setAsideEdits();
  assert.equal(list.length, 2);
  assert.match(JSON.stringify(list[0].data), /second edit/);
  assert.match(JSON.stringify(list[1].data), /first edit/);
  assert.ok(list.every((x) => x.data.tasks.every((r) => r.id !== 'T-2' || r.title !== 't2')));
});

test('a set-aside entry stored by the old build is still readable and can be dismissed', async () => {
  const storage = memStore();
  storage.setItem('nickos_v2_orphan', JSON.stringify({ tasks: [{ id: 'T-9', title: 'old format' }] }));
  const s = session(fakeApi({}), { tasks: [] }, storage, []);
  assert.match(JSON.stringify(s.setAsideEdits()), /old format/);
  s.dismissSetAside(0);
  assert.equal(storage.getItem('nickos_v2_orphan'), null);
});

test('when storage is full, the oldest set-aside goes first and nothing throws', async () => {
  const inner = memStore();
  const storage = { ...inner, setItem: (k, v) => { if (k === 'nickos_v2_orphan' && v.length > 700) throw new Error('quota'); inner.setItem(k, v); }, getItem: inner.getItem, removeItem: inner.removeItem };
  const api = fakeApi({ tasks: [T(1)] });
  for (let i = 0; i < 4; i++) {
    inner.setItem('nickos_v2_pending', '1');
    inner.setItem('nickos_v2_base', '{broken');
    await session(api, { tasks: [{ ...T(1), title: `edit ${i}`, versionSys: 1 }] }, storage, []).load();
  }
  const list = session(api, { tasks: [] }, storage, []).setAsideEdits();
  assert.ok(list.length >= 1);
  assert.match(JSON.stringify(list[0].data), /edit 3/);
});

test('an edit that conflicts with a record archived elsewhere is set aside, not reapplied', async () => {
  const s = await setup({ tasks: [T(1)] });
  const r = s.api.db.tasks.get('T-1');
  r.lifecycleSys = 'ARCHIVED';
  r.versionSys += 1;
  s.state.tasks[0].title = 'my edit';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /set aside/);
  assert.equal(s.state.tasks.length, 0);
  assert.notEqual(r.title, 'my edit');
  assert.match(JSON.stringify(s.sync.setAsideEdits()), /my edit/);
  await s.sync.retry();
  assert.equal(s.last()[0], 'signed-in');
  assert.deepEqual(writes(s.api).filter((c) => c.includes('delete')), []);
});

test('a failed load retries with growing waits, and only a rejected login stops retrying', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(retryDelayMs), [15000, 30000, 60000, 120000, 240000, 300000, 300000]);
  assert.equal(isNotAuthorized({ status: 401 }), true);
  assert.equal(isNotAuthorized({ status: 403 }), true);
  for (const s of [undefined, 500, 503, 429]) assert.equal(isNotAuthorized({ status: s }), false);
});

// The server stored the first attempt, so a replay holds nothing from the later one.
async function lostCreateThenEdit(edit) {
  const api = fakeApi({});
  const state = { tasks: [] };
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: memStore(),
    fetchImpl: (...args) => api.fetchImpl(...args), onStatus: () => {}, render: () => {}, log: { warn: () => {}, error: () => {} }
  });
  await sync.load();
  const real = api.fetchImpl;
  let lost = false;
  api.fetchImpl = async (url, init) => {
    if (!lost && url.includes('/get')) { lost = true; throw new Error('offline'); }
    return real(url, init);
  };
  state.tasks.push({ title: 'first', status: 'NEXT', notes: 'keep or clear' });
  await sync.push();
  edit(state.tasks[0]);
  await sync.retry();
  assert.equal(api.db.tasks.size, 1, 'one record, not two');
  return { local: state.tasks[0], server: [...api.db.tasks.values()][0], api };
}

test('an edit made before a lost create is retried reaches the server', async () => {
  const { local, server } = await lostCreateThenEdit((t) => { t.title = 'edited'; });
  assert.equal(server.title, 'edited');
  assert.equal(local.title, 'edited');
  assert.equal(local.versionSys, server.versionSys);
});

test('a field cleared before a lost create is retried is cleared on the server', async () => {
  const { local, server } = await lostCreateThenEdit((t) => { delete t.notes; });
  assert.ok(server.notes == null);
  assert.ok(local.notes == null);
});

test('a lost create retried with no edit sends no update', async () => {
  const { server, api } = await lostCreateThenEdit(() => {});
  assert.equal(server.versionSys, 1);
  assert.ok(!api.calls.some((c) => String(c.path || c).includes('batchUpdate')));
});

// ── DF-18 (P4): the tap keeps Nick's copy only for the conflicts it showed him ──────────
// Ported from the DEFECT tests in edit/web-reliability-tests (reliability-concurrency).

/** An agent (plugin / V2 MCP) writing through the API with the version it just read. */
async function agentEdit(api, entity, id, patch) {
  const cur = api.db[entity].get(id);
  const res = await api.fetchImpl('https://api.test/batchUpdate', {
    method: 'POST', headers: { Authorization: 'Bearer agent' },
    body: JSON.stringify({ updates: [{ entity, id, patch, expectedVersion: cur.versionSys, idempotencyKey: `agent-${id}-${cur.versionSys}` }] })
  });
  const body = await res.json();
  assert.equal(body.results[0].ok, true, 'fixture: the agent write itself must land');
  return body.results[0].versionSys;
}

test('DF-18: the tap does not overwrite an agent edit that landed after the conflict Nick was shown', async () => {
  const s = await setup({ tasks: [T(1)] });
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'IN_PROGRESS' });
  s.state.tasks[0].status = 'WAITING';
  await s.sync.push();
  assert.match(s.last()[1], /T-1 \(status\)/);
  const shownAt = s.api.db.tasks.get('T-1').versionSys;
  // Before Nick taps, the agent closes the task: an edit Nick never saw.
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'DONE', notes: 'RESOLVED by agent: root cause fixed in PR #51' });
  assert.equal(s.api.db.tasks.get('T-1').versionSys, shownAt + 1);
  await s.sync.retry();
  const r = s.api.db.tasks.get('T-1');
  assert.equal(r.status, 'DONE');
  assert.equal(r.notes, 'RESOLVED by agent: root cause fixed in PR #51');
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /Changed elsewhere again since you saw it: T-1 \(status\)\. Review before retrying/);
  // The second tap is consent to the version it now shows.
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-1').status, 'WAITING');
  assert.equal(s.api.db.tasks.get('T-1').notes, 'RESOLVED by agent: root cause fixed in PR #51');
  assert.equal(s.last()[0], 'signed-in');
});

test('DF-18: unsaved edits from an earlier session name the conflict before any overwrite', async () => {
  const a = await setup({ tasks: [T(1)] });
  a.api.down = true;
  a.state.tasks[0].status = 'WAITING';
  await a.sync.push();
  a.api.down = false;
  await agentEdit(a.api, 'tasks', 'T-1', { status: 'DONE' });
  const statuses = [];
  const state = { tasks: a.state.tasks };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: a.storage, fetchImpl: a.api.fetchImpl, onStatus: (x, y) => statuses.push([x, y]), render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  await sync.retry();
  assert.equal(a.api.db.tasks.get('T-1').status, 'DONE', 'nothing about T-1 had been shown, so the first tap must not overwrite it');
  assert.match(statuses.at(-1)[1], /T-1 \(status\)/);
  await sync.retry();
  assert.equal(a.api.db.tasks.get('T-1').status, 'WAITING');
  assert.equal(statuses.at(-1)[0], 'signed-in');
});

test('DF-18: the tap does not override a conflict on a different record that was never shown', async () => {
  const s = await setup({ tasks: [T(1), T(2)] });
  await agentEdit(s.api, 'tasks', 'T-1', { title: 'agent title' });
  s.state.tasks[0].title = 'nick title';
  await s.sync.push();
  assert.match(s.last()[1], /T-1 \(title\)/);
  assert.doesNotMatch(s.last()[1], /T-2/);
  s.state.tasks[1].status = 'WAITING';
  await agentEdit(s.api, 'tasks', 'T-2', { status: 'DONE' });
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-2').status, 'DONE');
  assert.equal(s.api.db.tasks.get('T-1').title, 'nick title', 'the conflict Nick was shown is kept his way in the same tap');
  assert.match(s.last()[1], /Also changed elsewhere: T-2 \(status\)/);
  assert.doesNotMatch(s.last()[1], /T-1/);
});

test('DF-18: consent covers only the fields shown; a newly overlapping field re-prompts', async () => {
  const s = await setup({ tasks: [T(1, { notes: 'orig' })] });
  await agentEdit(s.api, 'tasks', 'T-1', { title: 'agent title', notes: 'agent notes' });
  s.state.tasks[0].title = 'nick title';
  await s.sync.push();
  assert.match(s.last()[1], /T-1 \(title\)/);
  s.state.tasks[0].notes = 'nick notes'; // edited after the warning; the agent changed it too
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-1').notes, 'agent notes');
  assert.equal(s.api.db.tasks.get('T-1').title, 'agent title');
  assert.match(s.last()[1], /T-1 \(title, notes\)/);
});

test('DF-18: a tap after a pure network failure replays exactly once, with the same key and version', async () => {
  const s = await setup({ tasks: [T(1)] });
  const real = s.api.fetchImpl;
  const sent = [];
  let lose = true;
  // The server stores the update but the reply never arrives.
  s.api.fetchImpl = async (url, init) => {
    if (url.includes('/batchUpdate')) {
      sent.push(JSON.parse(init.body).updates.map((u) => [u.idempotencyKey, u.expectedVersion]));
      const res = await real(url, init);
      if (lose) { lose = false; throw new Error('connection lost after send'); }
      return res;
    }
    return real(url, init);
  };
  const statuses = [];
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => s.state, storage: s.storage, fetchImpl: (...a) => s.api.fetchImpl(...a), onStatus: (x, y) => statuses.push([x, y]), render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  s.state.tasks[0].title = 'once';
  await sync.push();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  await sync.retry();
  assert.equal(statuses.at(-1)[0], 'signed-in');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'the retry resends the same idempotency key and expected version');
  const r = s.api.db.tasks.get('T-1');
  assert.equal(r.title, 'once');
  assert.equal(r.versionSys, 2, 'applied once, the resend was a replay');
});

test('DF-18: a tap after a network failure never overrides a same-field edit made meanwhile', async () => {
  const s = await setup({ tasks: [T(1)] });
  s.api.down = true;
  s.state.tasks[0].status = 'WAITING';
  await s.sync.push();
  assert.match(s.last()[1], /offline/);
  s.api.down = false;
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'DONE' });
  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-1').status, 'DONE');
  assert.match(s.last()[1], /T-1 \(status\)/);
});

test('DF-18: confirming a mass delete does not override a conflict that was never shown', async () => {
  const many = Array.from({ length: MASS_DELETE_LIMIT + 1 }, (_, i) => T(i));
  const s = await setup({ tasks: many, blockers: [{ id: 'B-1', title: 'b', status: 'OPEN' }] });
  s.state.tasks = [];
  await s.sync.push();
  assert.match(s.last()[1], /Refusing to delete 21 tasks/);
  s.state.blockers[0].status = 'RESOLVED';
  await agentEdit(s.api, 'blockers', 'B-1', { status: 'DROPPED' });
  await s.sync.confirmMassDelete();
  assert.ok([...s.api.db.tasks.values()].every((r) => r.lifecycleSys === 'DELETED'));
  assert.equal(s.api.db.blockers.get('B-1').status, 'DROPPED');
  assert.match(s.last()[1], /B-1 \(status\)/);
});

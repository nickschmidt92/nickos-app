// RELIABILITY — a stale web client against newer agent edits (v2-sync.js).
//
// The harness below (fakeApi, setup) is copied from scripts/v2-sync.test.mjs, which does
// not export it. The fake API enforces v2's rules: versions, idempotency keys, writable
// fields. Copied rather than imported so this file cannot be broken by edits there.
//
// What is under test is the audit's residual risk R4: the red pill's tap ("retry")
// runs push({ localWins: true }) (v2-sync.js:606-617), and with localWins the overlap
// check is skipped for EVERY record in the pass (v2-sync.js:453). The desired
// behaviour (audit §11): a newer non-web edit to the same field is never overwritten
// without Nick having been shown THAT edit. Tests named "DEFECT:" fail today on purpose.
import { test } from 'node:test';

// A DEFECT test reproduces a known, still-open defect and is EXPECTED to fail until it is fixed.
// It runs and reports as a failing `todo`, so the defect stays visible without turning the
// gate / CI red and hiding real regressions (review R2, 2026-11-10). When the fix lands,
// change `defect(` back to `test(` in the same commit.
const defect = (name, fn) => test(name, { todo: 'known defect — reproduced on purpose; see 09 DF register' }, fn);
import assert from 'node:assert/strict';
import { createV2Sync, ENTITIES } from '../v2-sync.js';

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
const conflictText = (s) => s.statuses.filter(([st]) => st === 'save-failed').map(([, m]) => m).join(' || ');

// ─────────────────────────────────────────────────────────── 9. localWins

test('baseline: a same-field conflict goes red, names the field, and overwrites nothing until the tap', async () => {
  const s = await setup({ tasks: [T(1)] });
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'DONE', notes: 'agent: fixed in abc123' });
  s.state.tasks[0].status = 'IN_PROGRESS';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  assert.match(s.last()[1], /T-1 \(status\)/);
  assert.equal(s.api.db.tasks.get('T-1').status, 'DONE', 'the agent\'s resolution stands until Nick decides');
});

defect('DEFECT: the tap overwrites an agent edit that landed AFTER the conflict Nick was shown', async () => {
  const s = await setup({ tasks: [T(1)] });
  // Conflict #1: Nick is shown "T-1 (status)" against the agent's IN_PROGRESS.
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'IN_PROGRESS' });
  s.state.tasks[0].status = 'WAITING';
  await s.sync.push();
  assert.match(s.last()[1], /T-1 \(status\)/);
  const shownAt = s.api.db.tasks.get('T-1').versionSys;

  // Before Nick taps, the agent closes the task with a resolution — an edit Nick never saw.
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'DONE', notes: 'RESOLVED by agent: root cause fixed in PR #51' });
  assert.equal(s.api.db.tasks.get('T-1').versionSys, shownAt + 1);

  await s.sync.retry(); // "Tap to keep yours" — consent given for the conflict at version `shownAt`
  const r = s.api.db.tasks.get('T-1');
  assert.equal(r.status, 'DONE',
    `the tap was consent to override version ${shownAt}, but it silently overwrote version ${shownAt + 1}'s ` +
    `DONE with "${r.status}" — the agent's close was never shown to Nick (v2-sync.js:453 skips the overlap check under localWins)`);
  assert.equal(r.notes, 'RESOLVED by agent: root cause fixed in PR #51', 'a field Nick never edited must survive regardless');
});

defect('DEFECT: unsaved edits from an earlier session overwrite a newer agent edit on the first tap, with no field named', async () => {
  // Session 1: Nick sets T-1 to WAITING offline; it stays red and unsaved.
  const a = await setup({ tasks: [T(1)] });
  a.api.down = true;
  a.state.tasks[0].status = 'WAITING';
  await a.sync.push();
  a.api.down = false;

  // Days later an agent closes T-1.
  await agentEdit(a.api, 'tasks', 'T-1', { status: 'DONE' });

  // Session 2 loads: the pill says only "Unsaved changes from a previous session".
  const statuses = [];
  const state = { tasks: a.state.tasks };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: a.storage, fetchImpl: a.api.fetchImpl, onStatus: (x, y) => statuses.push([x, y]), render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  assert.equal(statuses.at(-1)[0], 'save-failed');
  const shown = statuses.map(([, m]) => m).join(' || ');
  await sync.retry();
  const r = a.api.db.tasks.get('T-1');
  assert.ok(r.status === 'DONE' || /T-1 \(status\)/.test(shown),
    `the agent's DONE was overwritten with "${r.status}" and the only message Nick ever saw was "${shown}" — ` +
    'no field-level warning that someone else had changed status');
});

defect('DEFECT: the tap also overrides a conflict on a DIFFERENT record that was never shown', async () => {
  const s = await setup({ tasks: [T(1), T(2)] });
  // A shown conflict on T-1 makes the pill red.
  await agentEdit(s.api, 'tasks', 'T-1', { title: 'agent title' });
  s.state.tasks[0].title = 'nick title';
  await s.sync.push();
  assert.match(s.last()[1], /T-1 \(title\)/);
  assert.doesNotMatch(s.last()[1], /T-2/);

  // Before the tap: Nick edits T-2 and an agent changes the same field of T-2.
  s.state.tasks[1].status = 'WAITING';
  await agentEdit(s.api, 'tasks', 'T-2', { status: 'DONE' });

  await s.sync.retry();
  assert.equal(s.api.db.tasks.get('T-2').status, 'DONE',
    'T-2 never appeared in any conflict message, yet the tap overwrote the agent\'s DONE: localWins is pass-wide, not per shown conflict');
});

// ───────────────────────────────────────── 10. newer server records preserved

test('a web edit to one record never touches a newer agent edit on another', async () => {
  const s = await setup({ tasks: [T(1), T(2, { notes: 'orig' })] });
  await agentEdit(s.api, 'tasks', 'T-2', { notes: 'agent wrote this' });
  s.state.tasks[0].title = 'edited by nick';
  await s.sync.push();
  assert.equal(s.last()[0], 'signed-in');
  assert.equal(s.api.db.tasks.get('T-1').title, 'edited by nick');
  const t2 = s.api.db.tasks.get('T-2');
  assert.equal(t2.notes, 'agent wrote this');
  assert.equal(t2.versionSys, 2, 'no web write reached T-2');
});

test('a stale offline copy, retried: agent edits to other fields and agent-created records survive', async () => {
  const s = await setup({ tasks: [T(1, { notes: 'orig' })] });
  s.api.down = true;
  s.state.tasks[0].title = 'offline title';
  await s.sync.push();
  assert.equal(s.last()[0], 'save-failed');
  s.api.down = false;

  // While Nick was offline an agent edited notes on T-1 and created T-NEW.
  await agentEdit(s.api, 'tasks', 'T-1', { notes: 'agent notes' });
  s.api.db.tasks.set('T-500', { id: 'T-500', title: 'agent made', status: 'NEXT', versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-11-05T01:00:00.000Z' });

  await s.sync.retry(); // localWins, but no overlapping field
  const t1 = s.api.db.tasks.get('T-1');
  assert.equal(t1.title, 'offline title');
  assert.equal(t1.notes, 'agent notes', 'the agent\'s field survives the stale client\'s retry');
  assert.equal(s.api.db.tasks.get('T-500').lifecycleSys, 'LIVE', 'a record the stale copy never saw is not read as a delete');
  assert.ok(!s.api.calls.includes('POST /delete'));
  assert.equal(s.last()[0], 'signed-in');
});

test('reload with unsaved edits: a newer agent edit to a different field survives', async () => {
  const a = await setup({ tasks: [T(1, { notes: 'orig' })] });
  a.api.down = true;
  a.state.tasks[0].title = 'unsaved title';
  await a.sync.push();
  a.api.down = false;
  await agentEdit(a.api, 'tasks', 'T-1', { notes: 'agent resolution' });

  const state = { tasks: a.state.tasks };
  const sync = createV2Sync({ apiBase: 'https://api.test', getToken: async () => 't', getState: () => state, storage: a.storage, fetchImpl: a.api.fetchImpl, onStatus() {}, render() {}, log: { warn() {}, error() {} } });
  await sync.load();
  await sync.retry();
  const r = a.api.db.tasks.get('T-1');
  assert.equal(r.title, 'unsaved title');
  assert.equal(r.notes, 'agent resolution');
});

test('an ordinary push (no tap) never overwrites a same-field agent edit, even across repeated autosaves', async () => {
  const s = await setup({ tasks: [T(1)] });
  await agentEdit(s.api, 'tasks', 'T-1', { status: 'DONE' });
  s.state.tasks[0].status = 'WAITING';
  for (let i = 0; i < 3; i++) await s.sync.push();
  assert.equal(s.api.db.tasks.get('T-1').status, 'DONE');
  assert.match(conflictText(s), /T-1 \(status\)/);
});

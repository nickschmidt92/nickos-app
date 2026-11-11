// DF-19 / DF-20 (P7): the pill says "Synced" only after the server acks, and every local
// module is pinned with the release's ?v= and precached by the service worker.
//
// Ported from edit/web-reliability-tests @35bbcc8 (scripts/reliability-cache.test.mjs):
// its harness (fake v2 API, index.html's own local-copy functions run in a vm, and a
// service-worker runtime with in-memory caches) is copied verbatim, with the two DEFECT
// tests for DF-19 and DF-20 as normal tests. Nothing here touches a real browser,
// network or Firebase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createV2Sync, ENTITIES } from '../v2-sync.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const swSource = read('service-worker.js');
const cloudSource = read('cloud-sync.js');

// ---------------------------------------------------------------------------
// Harness: a fake v2 API (versions, idempotency keys, writable fields), a storage that
// survives "reloads", and a page built from index.html's own local-copy functions.
// ---------------------------------------------------------------------------

const WRITABLE = { tasks: ['title', 'status', 'notes', 'projectId', 'dueDate'], projects: ['title', 'status'], decisions: ['title', 'why', 'status'], docs: ['title'], blockers: ['title', 'status', 'resolution'], reviews: ['title'] };

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

function fakeApi(seed = {}) {
  const db = Object.fromEntries(ENTITIES.map((e) => [e, new Map((seed[e] || []).map((r) => [r.id, { versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: '2026-01-01T00:00:00.000Z', ...r }]))]));
  const api = { db, keys: new Map(), calls: [], down: false, n: 1000, clock: 1, holds: new Map(), dropReply: new Set() };
  const stamp = () => new Date(Date.UTC(2026, 10, 10, 0, 0, api.clock++)).toISOString();
  const json = (status, body) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
  // Server-side edit, as another device would make it.
  api.serverEdit = (entity, id, patch) => { const r = db[entity].get(id); Object.assign(r, patch, { versionSys: r.versionSys + 1, updatedAtSys: stamp() }); };
  const update = (u) => {
    if (api.keys.has(u.idempotencyKey)) return { ...api.keys.get(u.idempotencyKey), replayed: true };
    const r = db[u.entity].get(u.id);
    if (!r) return { error: 'missing', code: 'NOT_FOUND', fail: 404 };
    if (r.versionSys !== u.expectedVersion) return { error: 'stale', code: 'VERSION_CONFLICT', fail: 409 };
    for (const k of Object.keys(u.patch)) if (!WRITABLE[u.entity].includes(k)) return { error: `bad ${k}`, code: 'VALIDATION', fail: 400 };
    Object.assign(r, u.patch, { versionSys: r.versionSys + 1, updatedAtSys: stamp() });
    const out = { id: u.id, versionSys: r.versionSys };
    api.keys.set(u.idempotencyKey, out);
    return out;
  };
  const handle = (path, u, body) => {
    if (path === '/all') return json(200, { data: Object.fromEntries(ENTITIES.map((e) => [e, [...db[e].values()].filter((r) => r.lifecycleSys === 'LIVE')])), writable: WRITABLE, serverTime: stamp() });
    if (path === '/get') { const r = db[u.searchParams.get('entity')].get(u.searchParams.get('id')); return r ? json(200, { record: r }) : json(404, { error: 'none' }); }
    if (path === '/changes') { const since = u.searchParams.get('since'); return json(200, { hasMore: false, serverTime: stamp(), data: Object.fromEntries(ENTITIES.map((e) => [e, [...db[e].values()].filter((r) => r.updatedAtSys > since)])) }); }
    if (path === '/add') {
      if (api.keys.has(body.idempotencyKey)) return json(200, { ...api.keys.get(body.idempotencyKey), replayed: true });
      const prefix = { tasks: 'T', projects: 'P', decisions: 'D', docs: 'DOC', blockers: 'B', reviews: 'R' }[body.entity];
      for (const k of Object.keys(body.fields)) if (!WRITABLE[body.entity].includes(k)) return json(400, { error: `bad ${k}`, code: 'VALIDATION' });
      const id = `${prefix}-${api.n++}`;
      db[body.entity].set(id, { ...body.fields, id, versionSys: 1, lifecycleSys: 'LIVE', updatedAtSys: stamp() });
      api.keys.set(body.idempotencyKey, { id, versionSys: 1 });
      return json(200, { id, versionSys: 1 });
    }
    if (path === '/batchUpdate') {
      const results = body.updates.map((x) => { const r = update(x); return r.fail ? { ok: false, id: x.id, code: r.code, error: r.error } : { ok: true, ...r }; });
      return json(results.every((r) => r.ok) ? 200 : 207, { results });
    }
    return json(404, { error: 'no route' });
  };
  api.fetchImpl = async (url, init = {}) => {
    const u = new URL(url); const path = u.pathname; const body = init.body ? JSON.parse(init.body) : null;
    api.calls.push(`${init.method} ${path}`);
    if (api.down) throw new Error('offline');
    // A held request has reached the server's door but not been processed yet.
    if (api.holds.has(path)) await api.holds.get(path).promise;
    const res = handle(path, u, body);
    // The server did the work, but the answer never came back (tab closed, network drop).
    if (api.dropReply.has(path)) throw new Error('connection lost after send');
    return res;
  };
  return api;
}

// index.html's own local-copy functions, run against a storage that outlives the page.
const lift = (from, to) => { const a = html.indexOf(from); assert.ok(a >= 0, `index.html: ${from}`); return html.slice(a, html.indexOf(to, a)); };
const LOCAL_COPY_SRC = lift('function saveToLocalStorage()', 'function resetLocalStorage()');
const emptyAppState = () => ({ tasks: [], projects: [], decisions: [], docs: [], blockers: [], reviews: [], currentPage: 'home', taskView: 'list', taskFilters: { status: null } });

/**
 * One page load: fresh appState (index.html boots its arrays EMPTY), loadFromLocalStorage,
 * captureBoot, then a new sync instance's load(). Returns handles to drive edits.
 */
async function openPage(api, storage, { load = true } = {}) {
  const ctx = vm.createContext({ appState: emptyAppState(), localStorage: storage, window: {}, console: { error() {}, log() {} } });
  vm.runInContext(LOCAL_COPY_SRC, ctx);
  ctx.loadFromLocalStorage();
  const statuses = [];
  const logs = [];
  const sync = createV2Sync({
    apiBase: 'https://api.test', getToken: async () => 'tok', getState: () => ctx.appState, storage, fetchImpl: api.fetchImpl,
    onStatus: (s, e) => statuses.push([s, e]), render: () => {}, saveLocal: () => ctx.saveToLocalStorage(),
    log: { warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) }
  });
  sync.captureBoot();
  const page = {
    ctx, sync, statuses, logs,
    get state() { return ctx.appState; },
    last: () => statuses.at(-1)?.[0],
    task: (id) => ctx.appState.tasks.find((t) => t.id === id),
    // What the patched saveToLocalStorage in cloud-sync.js does: save locally, note, push.
    edit(fn) { fn(ctx.appState); ctx.saveToLocalStorage(); sync.noteEdit(); return sync.push(); },
    loaded: null
  };
  if (load) page.loaded = await sync.load().then(() => null, (e) => e);
  return page;
}
const T = (n, o = {}) => ({ id: `T-${n}`, title: `t${n}`, status: 'NEXT', ...o });
const posts = (api) => api.calls.filter((c) => c.startsWith('POST'));
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// DF-19: status while an edit is in flight.
// ---------------------------------------------------------------------------

test('reconnect: offline edits are never green, and stay red until the server acks them', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const a = await openPage(api, storage);
  api.down = true;
  await a.edit((s) => { s.tasks[0].title = 'offline 1'; });
  await a.edit((s) => { s.tasks[0].notes = 'offline 2'; });
  const sinceEdit = a.statuses.slice(2).map((s) => s[0]);
  // The first edit shows "Saving…" until its send fails; after that the pill stays red.
  assert.deepEqual(sinceEdit, ['saving', 'save-failed', 'save-failed'], `statuses after the offline edits: ${sinceEdit}`);
  api.down = false;
  await a.sync.retry();
  assert.equal(api.db.tasks.get('T-1').title, 'offline 1');
  assert.equal(api.db.tasks.get('T-1').notes, 'offline 2');
  assert.equal(a.last(), 'signed-in');
});

test('DF-19: an edit in flight is shown "saving", and "Synced" only after the server acks it', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const p = await openPage(api, storage);
  const hold = deferred();
  api.holds.set('/batchUpdate', hold);
  const done = p.edit((s) => { s.tasks[0].title = 'in flight'; });
  await tick(); await tick();
  assert.ok(api.calls.includes('POST /batchUpdate'), 'the update is in flight');
  assert.equal(api.db.tasks.get('T-1').title, 't1', 'and the server has not stored it');
  try {
    assert.equal(p.last(), 'saving', 'the pill must not say Synced while the edit is unacknowledged');
  } finally {
    hold.resolve();
    await done;
  }
  assert.equal(api.db.tasks.get('T-1').title, 'in flight');
  assert.equal(p.last(), 'signed-in', 'green once acked');
});

test('DF-19: a send that fails goes from saving to red, never through green', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const p = await openPage(api, storage);
  api.dropReply.add('/batchUpdate');
  await p.edit((s) => { s.tasks[0].title = 'lost reply'; });
  assert.deepEqual(p.statuses.slice(2).map((s) => s[0]), ['saving', 'save-failed']);
});

test('DF-19: a save with nothing to send does not flash "saving"', async () => {
  const api = fakeApi({ tasks: [T(1)] });
  const storage = memStore();
  const p = await openPage(api, storage);
  const before = p.statuses.length;
  await p.sync.push();
  assert.deepEqual(p.statuses.slice(before).map((s) => s[0]), ['signed-in']);
});

test('DF-19: the pill renders "saving" as amber "Saving…", not as Synced', () => {
  const block = cloudSource.slice(cloudSource.indexOf("case 'saving':"), cloudSource.indexOf("case 'signed-in':"));
  assert.match(block, /Saving…/);
  assert.doesNotMatch(block, /<span>Synced|#10b981/);
});

// ---------------------------------------------------------------------------
// (3) Stale PWA client: service worker cache version vs pinned scripts.
// ---------------------------------------------------------------------------

const swVersion = swSource.match(/const CACHE_VERSION = 'nickos-v(\d+)'/)[1];
const SHELL = vm.runInNewContext(`(${swSource.match(/const SHELL = (\[[^\]]*\])/)[1]})`);

// Every same-origin script the page loads: index.html <script src>, and every relative
// import in those modules (followed transitively).
function pageScriptGraph() {
  const found = new Set();
  const queue = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => !/^https?:/.test(s));
  while (queue.length) {
    const spec = queue.shift().replace(/^\.\//, '');
    if (found.has(spec)) continue;
    found.add(spec);
    const file = spec.split('?')[0];
    if (!/\.m?js$/.test(file) || !fs.existsSync(new URL(`../${file}`, import.meta.url))) continue;
    for (const m of read(file).matchAll(/^\s*(?:import|export)\b[^'"]*?from\s*["'](\.[^"']+)["']/gm)) queue.push(m[1]);
    for (const m of read(file).matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) queue.push(m[1]);
  }
  return [...found];
}

test('every script the page loads is precached by the service worker under the exact same URL (pin included)', () => {
  const shell = new Set(SHELL.map((s) => s.replace(/^\.\//, '')));
  const graph = pageScriptGraph();
  assert.ok(graph.includes(`cloud-sync.js?v=${swVersion}`) && graph.includes(`v2-sync.js?v=${swVersion}`), `graph: ${graph}`);
  const missing = graph.filter((s) => !shell.has(s));
  assert.deepEqual(missing, [], 'loaded by the page but not in SHELL (offline start would break, or a stale copy would be served)');
  // Every pinned URL in SHELL carries CACHE_VERSION's number, and nothing pins an old one.
  for (const s of SHELL) {
    const v = s.match(/\?v=(\d+)/);
    if (v) assert.equal(v[1], swVersion, `${s} is pinned to v${v[1]} but CACHE_VERSION is nickos-v${swVersion}`);
  }
  for (const m of [...html.matchAll(/\?v=(\d+)/g), ...cloudSource.matchAll(/\?v=(\d+)/g)]) assert.equal(m[1], swVersion);
  // Every SHELL file exists in the repo, or cache.addAll rejects and the new SW never installs.
  for (const s of SHELL) {
    const file = s.replace(/^\.\//, '').split('?')[0] || 'index.html';
    assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), `SHELL lists ${s}, which does not exist`);
  }
});

// A service-worker runtime: in-memory CacheStorage, a fake network, and event dispatch.
function swRuntime({ source = swSource, network, caches: existing } = {}) {
  const ORIGIN = 'https://app.test';
  const abs = (u) => new URL(typeof u === 'string' ? u : u.url, `${ORIGIN}/`).href;
  const store = existing || new Map(); // name -> Map(url -> body)
  const resp = (body, url) => ({ body, url, clone() { return resp(body, url); } });
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const c = store.get(name);
      return {
        async addAll(list) {
          const got = await Promise.all(list.map(async (u) => [abs(u), await net(abs(u))]));
          for (const [k, r] of got) c.set(k, r.body);
        },
        async put(req, r) { c.set(abs(req), r.body); },
        async match(req) { return c.has(abs(req)) ? resp(c.get(abs(req)), abs(req)) : undefined; }
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) { for (const c of store.values()) if (c.has(abs(req))) return resp(c.get(abs(req)), abs(req)); return undefined; }
  };
  const state = { offline: false, netHits: [] };
  async function net(url) {
    state.netHits.push(url);
    if (state.offline) throw new TypeError('Failed to fetch');
    // Static hosting (GitHub Pages) ignores the query string: ?v= only changes the cache key.
    const path = new URL(url).pathname.replace(/^\//, '');
    if (!(path in network)) throw new Error(`404 ${path}`);
    return resp(network[path], url);
  }
  const handlers = {};
  const self = { addEventListener: (t, h) => { handlers[t] = h; }, skipWaiting() {}, clients: { claim() {} } };
  vm.runInNewContext(source, { self, caches, fetch: (r) => net(abs(r)), location: { origin: ORIGIN }, URL, Promise, console });
  const lifecycle = async (type) => { const waits = []; handlers[type]({ waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  return {
    store, state,
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    async request(url, { navigate = false } = {}) {
      let out = null;
      const ev = { request: { url: abs(url), method: 'GET', mode: navigate ? 'navigate' : 'no-cors' }, respondWith: (p) => { out = p; } };
      handlers.fetch(ev);
      if (!out) return net(abs(url));
      const r = await out;
      await tick();
      return r;
    }
  };
}

// A deployed site: every SHELL file with content tagged by its release.
function site(release, extra = {}) {
  const files = { '': `<html>${release}</html>`, 'index.html': `<html>${release}</html>`, 'manifest.json': `{"r":"${release}"}`, 'icon.svg': `<svg>${release}</svg>`, 'merge-by-id.js': `/* merge ${release} */`, 'firebase-config.js': `/* config ${release} */` };
  for (const s of SHELL) { const k = s.replace(/^\.\//, '').split('?')[0]; if (!(k in files)) files[k] = `/* ${k} ${release} */`; }
  return { ...files, ...extra };
}
const OLD = String(Number(swVersion) - 1);
const oldSource = swSource.replaceAll(`nickos-v${swVersion}`, `nickos-v${OLD}`).replaceAll(`?v=${swVersion}`, `?v=${OLD}`);

test('SW update: install precaches the whole shell under the new version; activate deletes every old cache', async () => {
  const store = new Map();
  // A phone that ran the previous release: its shell is cached under the old name.
  const old = swRuntime({ source: oldSource, network: site('old'), caches: store });
  await old.install(); await old.activate();
  store.set('some-stray-cache', new Map([['https://app.test/x', 'x']]));
  assert.deepEqual([...store.keys()].sort(), [`nickos-v${OLD}`, 'some-stray-cache'].sort());
  // New release deployed; the browser installs and activates the new SW.
  const fresh = swRuntime({ network: site('new'), caches: store });
  await fresh.install();
  const newCache = store.get(`nickos-v${swVersion}`);
  assert.ok(newCache, 'new cache created on install');
  for (const s of SHELL) assert.ok(newCache.has(new URL(s, 'https://app.test/').href), `precached ${s}`);
  await fresh.activate();
  assert.deepEqual([...store.keys()], [`nickos-v${swVersion}`], 'old caches deleted on activate');
  // Offline after the update: the old shell is gone, the new one is served.
  fresh.state.offline = true;
  assert.equal((await fresh.request('./index.html', { navigate: true })).body, '<html>new</html>');
  assert.equal((await fresh.request(`./v2-sync.js?v=${swVersion}`)).body, '/* v2-sync.js new */');
});

test('SW: navigations are network-first (a new deploy shows on the next open) and fall back to the cache offline', async () => {
  const net = site('r1');
  const sw = swRuntime({ network: net });
  await sw.install(); await sw.activate();
  net['index.html'] = '<html>r2</html>';
  assert.equal((await sw.request('./index.html', { navigate: true })).body, '<html>r2</html>', 'online: network wins over the cached shell');
  sw.state.offline = true;
  assert.equal((await sw.request('./index.html', { navigate: true })).body, '<html>r2</html>', 'offline: the copy refreshed by the last navigation');
  assert.equal((await sw.request('./some/deep/link', { navigate: true })).body, '<html>r2</html>', 'offline deep link falls back to index.html');
});

test('stale PWA, new page under the OLD service worker: pinned scripts come from the network, never the old cache', async () => {
  // Between deploy and the new SW activating, the old SW still controls the page. The new
  // index.html (network-first) asks for cloud-sync.js?v=<new>, which the old cache lacks.
  const store = new Map();
  const old = swRuntime({ source: oldSource, network: site('old'), caches: store });
  await old.install(); await old.activate();
  const deployed = site('new');
  const underOld = swRuntime({ source: oldSource, network: deployed, caches: store });
  assert.equal((await underOld.request('./index.html', { navigate: true })).body, '<html>new</html>');
  for (const s of SHELL.filter((x) => /\?v=/.test(x))) {
    assert.equal((await underOld.request(s)).body, deployed[s.replace(/^\.\//, '').split('?')[0]], `${s} paired with the new page`);
  }
});

// The service worker live before this change (v23): it precached both modules unpinned.
const LIVE_V23_SW = `const CACHE_VERSION = 'nickos-v23';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg', './cloud-sync.js?v=23', './v2-sync.js?v=23', './merge-by-id.js', './firebase-config.js'];
${swSource.slice(swSource.indexOf("self.addEventListener('install'"))}`;

test('DF-20: a new page under the OLD service worker gets the NEW merge-by-id.js / firebase-config.js (pinned modules)', async () => {
  // merge-by-id.js and firebase-config.js used to be imported WITHOUT a pin and are
  // cache-first, so a new cloud-sync.js could be paired with the previous release's copies.
  // firebase-config.js holds `backend` (v1/v2 + apiBase): the B-0129 "old code writes to the
  // wrong place" class. The new page must ask for URLs no older cache can answer.
  for (const source of [oldSource, LIVE_V23_SW]) {
    const store = new Map();
    const old = swRuntime({ source, network: site('old'), caches: store });
    await old.install(); await old.activate();
    const deployed = site('new');
    const underOld = swRuntime({ source, network: deployed, caches: store });
    const got = {};
    for (const f of ['merge-by-id.js', 'firebase-config.js']) {
      const spec = cloudSource.match(new RegExp(`from "(\\./${f.replace('.', '\\.')}\\?v=\\d+)"`));
      assert.ok(spec, `cloud-sync.js imports ${f} pinned`);
      got[f] = (await underOld.request(spec[1])).body;
    }
    assert.deepEqual(got, { 'merge-by-id.js': deployed['merge-by-id.js'], 'firebase-config.js': deployed['firebase-config.js'] },
      'the new cloud-sync.js was paired with the previous release\'s modules');
  }
});

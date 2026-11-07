// cloud-sync.js imports Firebase from a CDN, so it can't be loaded under node.
// Assert on the source text instead (same approach as getactive.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const src = readFileSync(new URL('cloud-sync.js', root), 'utf8');
const sw = readFileSync(new URL('service-worker.js', root), 'utf8');

const pushBody = src.slice(src.indexOf('async pushLocalState()'), src.indexOf('window.nickosCloud = cloud'));
const renderBody = src.slice(src.indexOf('function renderAuthUI()'), src.lastIndexOf('renderAuthUI();\n'));

test('pushLocalState failure sets save-failed, records the error and re-renders', () => {
  const catchBlock = pushBody.slice(pushBody.indexOf('catch (e)'));
  assert.match(catchBlock, /cloud\.status\s*=\s*'save-failed'/);
  assert.match(catchBlock, /cloud\.lastSaveError\s*=/);
  assert.match(catchBlock, /renderAuthUI\(\)/);
});

test('pushLocalState success restores signed-in and re-renders', () => {
  const tryBlock = pushBody.slice(0, pushBody.indexOf('catch (e)'));
  assert.match(tryBlock, /cloud\.status\s*=\s*'signed-in'/);
  assert.match(tryBlock, /renderAuthUI\(\)/);
});

test('test-only failure hook runs before setDoc', () => {
  const hook = pushBody.indexOf('window.__nickosTestFailSave');
  assert.ok(hook > -1);
  assert.ok(hook < pushBody.indexOf('await setDoc('));
});

test('renderAuthUI has a save-failed pill that retries on click', () => {
  const idx = renderBody.indexOf("case 'save-failed'");
  assert.ok(idx > -1);
  const caseBlock = renderBody.slice(idx, renderBody.indexOf('break;', idx));
  assert.ok(caseBlock.includes('Not saved'));
  assert.ok(caseBlock.includes('tap to retry'));
  assert.ok(caseBlock.includes('#ef4444'));
  assert.ok(renderBody.includes("host.onclick = () => { if (cloud.status === 'save-failed' && !cloud.pushing) cloud.retryUnsaved(); };"));
});

test("service worker cache version is 'nickos-v21' and precaches merge-by-id.js", () => {
  assert.match(sw, /CACHE_VERSION\s*=\s*'nickos-v21'/);
  assert.match(sw, /const SHELL = \[[^\]]*'\.\/merge-by-id\.js'/);
});

const authBody = src.slice(src.indexOf('onAuthStateChanged(auth'), src.indexOf('getRedirectResult(auth)'));

test('snapshot handler bails out on save-failed before applying remote state', () => {
  const g = authBody.indexOf('if (hasUnsaved()) {');
  assert.ok(g > -1);
  assert.ok(g < authBody.indexOf('applyRemoteState(remote)'));
  assert.ok(g < authBody.indexOf('onSnapshot(stateRef, async (snap) => {') + 300);
  const guard = authBody.slice(g, authBody.indexOf('return;', g));
  assert.match(guard, /suppressNextRemote = false/);
  assert.match(guard, /cloud\.status = 'save-failed'/);
});

test("auth handler does not set 'syncing' unconditionally", () => {
  assert.match(authBody, /if \(cloud\.status !== 'save-failed'\) cloud\.status = 'syncing'/);
  assert.doesNotMatch(authBody, /^\s*cloud\.status = 'syncing'/m);
});

test("first-sign-in branch does not set 'signed-in' after the push", () => {
  const i = authBody.indexOf('await cloud.pushLocalState()');
  assert.ok(i > -1);
  const rest = authBody.slice(i, authBody.indexOf('return;', i));
  assert.doesNotMatch(rest, /cloud\.status\s*=/);
});

test('nickos_unsaved is set on failure, cleared on success and read at module start', () => {
  const catchBlock = pushBody.slice(pushBody.indexOf('catch (e)'));
  const tryBlock = pushBody.slice(0, pushBody.indexOf('catch (e)'));
  assert.match(catchBlock, /localStorage\.setItem\('nickos_unsaved', '1'\)/);
  assert.match(tryBlock, /localStorage\.removeItem\('nickos_unsaved'\)/);
  assert.match(src, /localStorage\.getItem\('nickos_unsaved'\) === '1'[\s\S]{0,80}cloud\.status = 'save-failed'/);
});

test('in-flight guard: cloud.pushing set during push and checked on tap', () => {
  assert.match(pushBody, /cloud\.pushing = true/);
  assert.match(pushBody, /finally \{\s*cloud\.pushing = false/);
  assert.match(renderBody, /!cloud\.pushing/);
});

test('hasUnsaved reads nickos_unsaved inside a try block', () => {
  const fn = src.slice(src.indexOf('function hasUnsaved()'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /try \{[^}]*localStorage\.getItem\('nickos_unsaved'\)/);
  assert.match(body, /cloud\.status === 'save-failed'/);
});

test('snapshot error callback keeps save-failed when unsaved', () => {
  const e = authBody.slice(authBody.indexOf("snapshot error:"));
  assert.match(e, /if \(!hasUnsaved\(\)\) cloud\.status = 'error'/);
});

test('module-start read of nickos_unsaved is inside a try block', () => {
  assert.match(src, /try \{\s*if \(localStorage\.getItem\('nickos_unsaved'\) === '1'\)/);
});

// ── F1: a stale unsaved local copy must never be pushed wholesale ──────────────

const patchBody = src.slice(src.indexOf('(function patchSaveWhenReady()'));
const retryBody = src.slice(src.indexOf('async retryUnsaved()'), src.indexOf('window.nickosCloud = cloud'));

test('wrapped save path checks hasUnsaved() before pushing', () => {
  const wrapped = patchBody.slice(patchBody.indexOf('function patched('), patchBody.indexOf('__cloudPatched = true'));
  const g = wrapped.indexOf('if (hasUnsaved()) return r;');
  assert.ok(g > -1, 'no hasUnsaved guard in the wrapped save');
  assert.ok(g < wrapped.indexOf('cloud.pushLocalState()'));
});

test('getDocFromServer is imported from the same Firestore SDK module as setDoc and onSnapshot', () => {
  const imp = src.match(/import \{([^}]*)\} from "https:\/\/www\.gstatic\.com\/firebasejs\/10\.13\.2\/firebase-firestore\.js"/);
  assert.ok(imp);
  for (const name of ['getDocFromServer', 'setDoc', 'onSnapshot']) assert.match(imp[1], new RegExp(`\\b${name}\\b`));
});

test('cloud-sync imports mergeById from ./merge-by-id.js', () => {
  assert.match(src, /import \{ mergeById \} from "\.\/merge-by-id\.js";/);
});

test('retryUnsaved reads the server (not the cache) before pushing, and merges by id', () => {
  assert.ok(retryBody.length > 0, 'retryUnsaved missing');
  const get = retryBody.indexOf('await getDocFromServer(');
  const push = retryBody.indexOf('await cloud.pushLocalState()');
  assert.ok(get > -1 && push > -1);
  assert.ok(get < push, 'getDocFromServer must come before the push');
  // Plain getDoc falls back to the IndexedDB cache offline: a stale merge base.
  assert.doesNotMatch(retryBody, /\bgetDoc\(/);
  const merge = retryBody.indexOf('mergeById(');
  assert.ok(merge > get && merge < push);
  assert.match(retryBody, /ENTITY_KEYS\.forEach/);
  assert.ok(retryBody.indexOf('applyRemoteState(') > get && retryBody.indexOf('applyRemoteState(') < push);
});

test('retryUnsaved: server-read failure stays save-failed with lastSaveError and returns before the push', () => {
  const c = retryBody.slice(retryBody.indexOf('await getDocFromServer('));
  const catchBlock = c.slice(c.indexOf('catch (e)'), c.indexOf('return;') + 'return;'.length);
  assert.match(catchBlock, /cloud\.lastSaveError\s*=/);
  assert.match(catchBlock, /cloud\.status\s*=\s*'save-failed'/);
  assert.match(catchBlock, /renderAuthUI\(\)/);
  assert.ok(c.indexOf('return;') < c.indexOf('await cloud.pushLocalState()'));
});

test('retryUnsaved holds the in-flight guard across the whole retry', () => {
  assert.ok(retryBody.indexOf('cloud.pushing = true') < retryBody.indexOf('await getDocFromServer('));
  assert.match(retryBody, /finally \{\s*cloud\.pushing = false/);
});

test('the page reloads when a new service worker takes over, but not over a form', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const body = html.slice(html.indexOf("'serviceWorker' in navigator"));
  assert.match(body, /addEventListener\('controllerchange'/);
  assert.match(body, /if \(!hadController\)/);
  assert.match(body, /modal-overlay\.active/);
  assert.match(body, /visibilityState === 'visible'.*\n?.*reg\.update/);
});

test('v2 Offline retries the load, not sign-in, and a rejected login has its own message', () => {
  assert.match(renderBody, /v2 && cloud\.user \? 'cloud-retry-btn' : 'cloud-signin-btn'/);
  assert.match(renderBody, /case 'not-authorized':/);
  assert.match(renderBody, /Not authorized/);
  assert.match(src, /if \(!isNotAuthorized\(e\)\) loadRetryTimer = setTimeout\(startV2/);
  assert.match(src, /addEventListener\('online', retryLoadNow\)/);
});

test('an older tab stops saving when a newer one opens', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.match(html, /new BroadcastChannel\('nickos_tabs'\)/);
  assert.match(html, /function saveToLocalStorage\(\) \{\s*if \(window\.nickosTabLocked\) return;/);
  assert.match(src, /isBusy: \(\) => Boolean\(window\.nickosTabLocked/);
});

test('sign-in opens a popup first: a redirect comes back signed out on iPhone Safari (B-0135)', () => {
  const body = src.slice(src.indexOf('async signIn()'), src.indexOf("console.error('[cloud-sync] sign-in failed:'"));
  const popup = body.indexOf('await signInWithPopup(auth, appleProvider)');
  const fallback = body.indexOf("e?.code !== 'auth/popup-blocked'");
  const redirect = body.indexOf('await signInWithRedirect(auth, appleProvider)');
  assert.ok(popup > -1 && popup < fallback && fallback < redirect, 'popup, then redirect only if the popup is blocked');
  assert.ok(!body.includes('isMobileSafari'));
});

test('the red pill offers a way out on v2, and that button does not also trigger a retry (T-01704)', () => {
  assert.match(renderBody, /v2 && cloud\.user && cloud\.status === 'save-failed'.*Set aside and reload/);
  assert.match(renderBody, /cloud-setaside-reload-btn'\);\n\s*if \(reloadEl\) reloadEl\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); setAsideAndReload\(\); \}\)/);
});

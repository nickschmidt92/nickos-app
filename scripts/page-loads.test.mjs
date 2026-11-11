// The app is one inline script: a single syntax error stops the whole page, and tests that
// lift out one function never notice. A duplicate const nearly shipped this way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('every inline script in index.html compiles', () => {
  assert.ok(inline.length >= 1);
  for (const code of inline) assert.doesNotThrow(() => new vm.Script(code));
});

test('the page, its scripts and the service worker agree on one script version', () => {
  const sw = fs.readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  const cloud = fs.readFileSync(new URL('../cloud-sync.js', import.meta.url), 'utf8');
  const version = sw.match(/CACHE_VERSION = 'nickos-v(\d+)'/)[1];
  assert.ok(html.includes(`src="cloud-sync.js?v=${version}"`), 'index.html');
  assert.ok(cloud.includes(`"./v2-sync.js?v=${version}"`), 'cloud-sync.js');
  assert.ok(sw.includes(`'./cloud-sync.js?v=${version}'`) && sw.includes(`'./v2-sync.js?v=${version}'`), 'SHELL');
  // DF-20: the two modules cloud-sync.js imports are pinned too, or an old cache serves them.
  for (const f of ['merge-by-id.js', 'firebase-config.js']) {
    assert.ok(cloud.includes(`"./${f}?v=${version}"`), `cloud-sync.js imports ${f}`);
    assert.ok(sw.includes(`'./${f}?v=${version}'`), `SHELL has ${f}`);
  }
});

test('a phone has a New Task button that is always on screen, and the pill covers nothing (T-01715)', () => {
  assert.match(html, /id="mobile-new-task"[^>]*onclick="openTaskModal\(\)"/);
  const phone = html.slice(html.indexOf('PHONE LAYOUT'));
  assert.match(phone, /\.page-container \{ padding-top: 56px; \}/);
  assert.match(phone, /\.mobile-new-task \{ display: flex; \}/);
});

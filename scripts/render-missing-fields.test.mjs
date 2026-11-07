// A v2 record can have no priority or status (T-01506 has no priority). render() clears the
// page before it builds it, so one throw here leaves the whole page blank.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('no render path calls a string method on a badge field without guarding it', () => {
  const unguarded = html.split('\n').filter((line) =>
    /\$\{(\w+)\.(priority|status)\.toLowerCase\(\)\}/.test(line) &&
    !/\$\{(\w+)\.(priority|status) \? `/.test(line));
  assert.deepEqual(unguarded, []);
});

test('task search does not assume a title', () => {
  assert.doesNotMatch(html, /\bt\.title\.toLowerCase\(\)/);
});

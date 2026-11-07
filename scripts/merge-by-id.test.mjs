// mergeById is the pure core of cloud.retryUnsaved(): a stale local copy must
// never delete records that exist only on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeById } from '../merge-by-id.js';

test('server-only items are kept', () => {
  assert.deepEqual(mergeById([{ id: 'T-1' }], [{ id: 'T-1' }, { id: 'T-2', title: 'from API' }]),
    [{ id: 'T-1' }, { id: 'T-2', title: 'from API' }]);
});

test('same id on both sides: the local item wins', () => {
  assert.deepEqual(mergeById([{ id: 'T-1', title: 'local' }], [{ id: 'T-1', title: 'server' }]),
    [{ id: 'T-1', title: 'local' }]);
});

test('local-only items are kept', () => {
  assert.deepEqual(mergeById([{ id: 'T-9' }], []), [{ id: 'T-9' }]);
});

test('local items without an id are kept', () => {
  assert.deepEqual(mergeById([{ title: 'no id' }], [{ id: 'T-1' }]), [{ title: 'no id' }, { id: 'T-1' }]);
});

test('order is local first, then server-only in server order', () => {
  const local = [{ id: 'T-3' }, { title: 'x' }, { id: 'T-1', v: 'L' }];
  const server = [{ id: 'T-5' }, { id: 'T-1', v: 'S' }, { id: 'T-4' }];
  assert.deepEqual(mergeById(local, server), [{ id: 'T-3' }, { title: 'x' }, { id: 'T-1', v: 'L' }, { id: 'T-5' }, { id: 'T-4' }]);
});

test('non-array inputs are treated as empty', () => {
  assert.deepEqual(mergeById(undefined, [{ id: 'T-1' }]), [{ id: 'T-1' }]);
  assert.deepEqual(mergeById([{ id: 'T-1' }], undefined), [{ id: 'T-1' }]);
});

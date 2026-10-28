// Pure merge used by cloud.retryUnsaved() in cloud-sync.js. No imports, so node
// tests can load it (scripts/merge-by-id.test.mjs).
//
// Why: the app pushes each entity as a wholesale array, so pushing a stale local
// copy deletes every record that exists only on the server (e.g. tasks added via
// the API while this device had unsaved edits). Merging first keeps them.
//
// Rules: every local item is kept, in local order (local wins on a shared id,
// items without an id are kept); then every server item whose id is absent
// locally is appended, in server order.
export function mergeById(localArr, serverArr) {
  const local = Array.isArray(localArr) ? localArr : [];
  const server = Array.isArray(serverArr) ? serverArr : [];
  const localIds = new Set(local.filter((x) => x && x.id != null).map((x) => x.id));
  const serverOnly = server.filter((x) => !(x && x.id != null && localIds.has(x.id)));
  return [...local, ...serverOnly];
}

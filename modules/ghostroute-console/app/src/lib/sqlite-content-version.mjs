// Process-local cache invalidation, independent of history size or application tables.
const connections = new WeakMap();
let nextConnection = 0;

export function sqliteContentVersion(db) {
  let state = connections.get(db);
  if (!state) {
    state = { id: ++nextConnection, changes: db.prepare('select total_changes() as changes') };
    connections.set(db, state);
  }
  // data_version sees commits from other connections; total_changes sees our own
  // row writes; schema_version also catches local DDL with no changed rows.
  return [state.id, db.pragma('data_version', { simple: true }),
    db.pragma('schema_version', { simple: true }), state.changes.get().changes].join(':');
}

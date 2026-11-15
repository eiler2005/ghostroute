// Existing versions must not request a SQLite writer lock during page startup.
export function recordSchemaVersions(db, versions, appliedAt) {
  const exists = db.prepare('select 1 from schema_migrations where version = ?');
  const insert = db.prepare('insert or ignore into schema_migrations(version, applied_at) values (?, ?)');
  for (const version of versions) {
    if (!exists.get(version)) insert.run(version, appliedAt);
  }
}

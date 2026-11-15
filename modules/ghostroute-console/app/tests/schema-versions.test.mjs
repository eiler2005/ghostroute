import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { recordSchemaVersions } from '../src/lib/schema-versions.mjs';
import { ensureConsoleSchema } from '../scripts/lib/normalize.mjs';

test('recent intelligence lists use time indexes rather than sorting the full history', () => {
  const db = new Database(':memory:');
  try {
    ensureConsoleSchema(db);
    for (const [table, field, index] of [
      ['decision_candidates', 'updated_at_utc', 'idx_decision_candidates_updated'],
      ['destination_enrichment', 'last_seen', 'idx_destination_enrichment_last_seen'],
    ]) {
      const plan = db.prepare(`explain query plan select * from ${table} order by ${field} desc limit 200`).all();
      assert.ok(plan.some(row => row.detail.includes(index)));
      assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
    }
  } finally { db.close(); }
});

test('current migration versions remain readable while the collector owns the writer lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-schema-'));
  const first = new Database(path.join(dir, 'test.db'));
  let reader;
  try {
    first.pragma('journal_mode = WAL');
    first.exec('create table schema_migrations(version integer primary key, applied_at text)');
    recordSchemaVersions(first, [16], 'original');
    reader = new Database(path.join(dir, 'test.db'), { timeout: 1 });
    first.exec('begin immediate');
    assert.doesNotThrow(() => recordSchemaVersions(reader, [16], 'unchanged'));
    first.exec('rollback');
    assert.equal(reader.prepare('select applied_at from schema_migrations where version=16').get().applied_at, 'original');
    recordSchemaVersions(reader, [17], 'new');
    assert.equal(reader.prepare('select count(*) as count from schema_migrations').get().count, 2);
  } finally { reader?.close(); first.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

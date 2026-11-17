import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sqliteContentVersion } from '../src/lib/sqlite-content-version.mjs';

test('content version sees external committed updates without table counts or timestamp changes', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'console-version-'));
  const file = path.join(folder, 'test.db');
  const writer = new Database(file);
  writer.pragma('journal_mode = WAL');
  writer.exec("create table evidence(id integer primary key, payload text); insert into evidence values(1, 'before')");
  const reader = new Database(file, { readonly: true });
  try {
    const before = sqliteContentVersion(reader);
    assert.equal(sqliteContentVersion(reader), before);
    writer.exec("begin; update evidence set payload='after' where id=1");
    assert.equal(sqliteContentVersion(reader), before, 'uncommitted writes are not visible');
    writer.exec('commit');
    assert.notEqual(sqliteContentVersion(reader), before);
    assert.equal(reader.prepare('select count(*) n from evidence').get().n, 1);
  } finally { reader.close(); writer.close(); fs.rmSync(folder, { recursive: true }); }
});

test('content version catches same-connection writes and schema changes', () => {
  const db = new Database(':memory:');
  try {
    db.exec('create table evidence(value integer)');
    const empty = sqliteContentVersion(db);
    db.exec('insert into evidence values(1)');
    const written = sqliteContentVersion(db);
    assert.notEqual(written, empty);
    db.exec('alter table evidence add column note text');
    const changedSchema = sqliteContentVersion(db);
    assert.notEqual(changedSchema, written);
    assert.equal(sqliteContentVersion(db), changedSchema);
  } finally { db.close(); }
});

test('reopened or distinct connections cannot reuse another connection cache token', () => {
  const first = new Database(':memory:');
  const second = new Database(':memory:');
  try { assert.notEqual(sqliteContentVersion(first), sqliteContentVersion(second)); }
  finally { first.close(); second.close(); }
});

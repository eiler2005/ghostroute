#!/usr/bin/env node
import path from "node:path";
import Database from "better-sqlite3";

const appDir = path.resolve(import.meta.dirname, "..");
const moduleDir = path.resolve(appDir, "..");
const dataDir = process.env.GHOSTROUTE_CONSOLE_DATA_DIR || path.resolve(moduleDir, "data");
const dbFile = path.join(dataDir, "ghostroute.db");
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

const pageSize = Number(db.pragma("page_size", { simple: true }) || 0);
const pageCount = Number(db.pragma("page_count", { simple: true }) || 0);
const tables = db
  .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
  .all()
  .map((row) => row.name);

console.log(`database=${dbFile}`);
console.log(`total_bytes=${pageSize * pageCount}`);
console.log("table_rows:");
for (const table of tables) {
  const count = db.prepare(`select count(*) as count from ${table}`).get().count;
  console.log(`${table} ${count}`);
}
db.close();

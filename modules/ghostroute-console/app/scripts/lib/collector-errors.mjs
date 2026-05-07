import path from "node:path";
import Database from "better-sqlite3";
import { ensureConsoleSchema } from "./normalize.mjs";

export function recordCollectorError({ dataDir, type, command, args = [], error, sample = "" }) {
  let db = null;
  try {
    db = new Database(path.join(dataDir, "ghostroute.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 10000");
    ensureConsoleSchema(db);
    const now = new Date().toISOString();
    const run = db
      .prepare("insert into collector_runs(started_at, finished_at, ok_count, error_count) values (?, ?, 0, 1)")
      .run(now, now);
    db.prepare(
      "insert into collector_errors(run_id, type, collected_at, command, message, output_sample) values (?, ?, ?, ?, ?, ?)"
    ).run(
      Number(run.lastInsertRowid),
      type,
      now,
      [command, ...args].join(" "),
      error?.message || String(error || "unknown collector error"),
      sample || String(error?.stdout || error?.stderr || error?.message || error || "").slice(0, 1000)
    );
  } catch (recordError) {
    console.error(`failed to record collector error: ${recordError.message}`);
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort close.
    }
  }
}

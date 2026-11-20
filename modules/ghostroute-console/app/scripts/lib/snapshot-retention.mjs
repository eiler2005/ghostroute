import fs from "node:fs";
import path from "node:path";

export const SNAPSHOT_ARCHIVE_HOURS = 6;

function latestSnapshots(db) {
  return db.prepare("select distinct type from snapshots").all().map(({ type }) =>
    db.prepare("select id,path from snapshots where type=? order by collected_at desc,id desc limit 1").get(type));
}

export function pruneSnapshotPayloads(db, now = new Date().toISOString()) {
  const latest = latestSnapshots(db);
  if (!latest.length) return 0;
  const cutoff = new Date(Date.parse(now) - SNAPSHOT_ARCHIVE_HOURS * 3600000).toISOString();
  const update = db.prepare(`update snapshots set payload_json='' where id in (
    select id from snapshots where payload_json!='' and type!='traffic_summary' and collected_at < ?
      and id not in (${latest.map(() => "?").join(",")}) limit 10)`);
  let total = 0, changed;
  do {
    changed = update.run(cutoff, ...latest.map(row => row.id)).changes;
    total += changed;
  } while (changed);
  return total;
}

export function pruneSnapshotFiles(db, snapshotDir, now = new Date().toISOString()) {
  if (!fs.existsSync(snapshotDir)) return 0;
  const keep = new Set(latestSnapshots(db).map(row => path.basename(row.path)));
  const cutoff = Date.parse(now) - SNAPSHOT_ARCHIVE_HOURS * 3600000;
  let deleted = 0;
  for (const name of fs.readdirSync(snapshotDir)) {
    if (!name.endsWith(".json") || keep.has(name)) continue;
    const file = path.join(snapshotDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      fs.unlinkSync(file);
      deleted++;
    }
  }
  return deleted;
}

export function pruneSnapshotMetadata(db, cutoff) {
  const latest = latestSnapshots(db);
  if (!latest.length) return 0;
  return db.prepare(`delete from snapshots where collected_at < ?
    and id not in (${latest.map(() => "?").join(",")})`)
    .run(cutoff, ...latest.map(row => row.id)).changes;
}

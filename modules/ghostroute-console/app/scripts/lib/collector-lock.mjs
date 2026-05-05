import fs from "node:fs";
import path from "node:path";

export function acquireSharedCollectorLock(dataDir, owner) {
  const lockFile = path.join(dataDir, "collector-writer.lock");
  const maxAgeMs = Math.max(600000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 180) * 1000 * 2);
  try {
    const stat = fs.statSync(lockFile);
    if (Date.now() - stat.mtimeMs > maxAgeMs) fs.unlinkSync(lockFile);
  } catch {
    // No existing shared collector lock.
  }

  let fd = null;
  try {
    fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, `${owner} ${process.pid} ${new Date().toISOString()}\n`);
  } catch {
    console.log(`${owner} skipped: another collector writer is active`);
    process.exit(0);
  }

  process.on("exit", () => {
    try {
      if (fd !== null) fs.closeSync(fd);
      fs.unlinkSync(lockFile);
    } catch {
      // Best-effort lock cleanup.
    }
  });
}

import fs from "node:fs";
import path from "node:path";

const activeReleases = new Set();
let cleanupHandlersInstalled = false;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseActiveLocks() {
  for (const release of [...activeReleases]) release();
}

function installCleanupHandlers() {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;
  process.once("exit", releaseActiveLocks);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      releaseActiveLocks();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function parseLockPid(content) {
  for (const token of content.trim().split(/\s+/)) {
    const pid = Number(token);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return 0;
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pruneStaleLock(lockFile, maxAgeMs) {
  let stat = null;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return;
  }

  let pid = 0;
  try {
    pid = parseLockPid(fs.readFileSync(lockFile, "utf8"));
  } catch {
    // Fall back to mtime if the lock content cannot be read.
  }

  const lockAgeMs = Date.now() - stat.mtimeMs;
  const pidLooksDead = pid > 0 && (pid === process.pid || !pidIsAlive(pid));
  const contentHasNoPid = pid <= 0;
  if (!pidLooksDead && !(contentHasNoPid && lockAgeMs > maxAgeMs)) return;

  try {
    fs.unlinkSync(lockFile);
  } catch {
    // Another collector may have raced and removed/recreated the lock.
  }
}

export function acquireCollectorLock(lockFile, owner, maxAgeMs, options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs || 0));
  const retryMs = Math.max(50, Number(options.retryMs || 500));
  const deadline = Date.now() + waitMs;

  let fd = null;
  while (fd === null) {
    pruneStaleLock(lockFile, maxAgeMs);
    try {
      fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, `${owner} ${process.pid} ${new Date().toISOString()}\n`);
    } catch {
      if (Date.now() >= deadline) return null;
      sleepMs(Math.min(retryMs, Math.max(0, deadline - Date.now())));
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeReleases.delete(release);
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      // Best-effort lock cleanup.
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // Best-effort lock cleanup.
    }
  };

  activeReleases.add(release);
  installCleanupHandlers();
  return release;
}

export function acquireSharedCollectorLock(dataDir, owner) {
  const lockFile = path.join(dataDir, "collector-writer.lock");
  const maxAgeMs = Math.max(600000, Number(process.env.GHOSTROUTE_COLLECT_TIMEOUT_SECONDS || 900) * 1000 * 2);
  const waitMs = Math.max(0, Number(process.env.GHOSTROUTE_COLLECTOR_WRITER_LOCK_WAIT_SECONDS || 120) * 1000);
  const release = acquireCollectorLock(lockFile, owner, maxAgeMs, { waitMs });
  if (!release) {
    console.log(`${owner} skipped: another collector writer is active`);
    process.exit(0);
  }
  return release;
}

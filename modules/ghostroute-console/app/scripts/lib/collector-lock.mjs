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

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${boot}:${start}`;
  } catch {
    return null;
  }
}

function lockOwnerChanged(lockFile, content, pid) {
  const recorded = content.match(/identity=(\S+)/)?.[1];
  const current = processIdentity(pid);
  if (recorded && current) return recorded !== current;
  // Upgrade legacy PID-only locks without treating an unrelated reused PID as an owner.
  const scripts = {
    "collector.lock": ["collect-once.mjs", "repair-aggregates.mjs"],
    "light-collector.lock": ["collect-light-once.mjs"],
    "live-collector.lock": ["collect-live-once.mjs"],
    "collector-writer.lock": ["collect-once.mjs", "collect-light-once.mjs", "collect-live-once.mjs", "repair-aggregates.mjs"],
  }[path.basename(lockFile)];
  if (!recorded && scripts) {
    try {
      return !fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").some(arg => scripts.includes(path.basename(arg)));
    } catch { /* Non-Linux hosts retain PID-based compatibility. */ }
  }
  return false;
}

function pruneStaleLock(lockFile, maxAgeMs) {
  let stat = null;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return;
  }

  let pid = 0;
  let content = "";
  try {
    content = fs.readFileSync(lockFile, "utf8");
    pid = parseLockPid(content);
  } catch {
    // Fall back to mtime if the lock content cannot be read.
  }

  const lockAgeMs = Date.now() - stat.mtimeMs;
  const pidLooksDead = pid > 0 && (pid === process.pid || !pidIsAlive(pid) || lockOwnerChanged(lockFile, content, pid));
  const contentHasNoPid = pid <= 0;
  if (!pidLooksDead && !(contentHasNoPid && lockAgeMs > maxAgeMs)) return;

  try {
    if (fs.readFileSync(lockFile, "utf8") === content) fs.unlinkSync(lockFile);
  } catch {
    // Another collector may have raced and removed/recreated the lock.
  }
}

export function acquireCollectorLock(lockFile, owner, maxAgeMs, options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs || 0));
  const retryMs = Math.max(50, Number(options.retryMs || 500));
  const deadline = Date.now() + waitMs;

  let fd = null;
  let lockContent = "";
  while (fd === null) {
    pruneStaleLock(lockFile, maxAgeMs);
    try {
      fd = fs.openSync(lockFile, "wx");
      lockContent = `${owner} ${process.pid} ${new Date().toISOString()} identity=${processIdentity(process.pid) || "unavailable"}\n`;
      fs.writeFileSync(fd, lockContent);
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
      if (fs.readFileSync(lockFile, "utf8") === lockContent) fs.unlinkSync(lockFile);
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
    process.exit(75);
  }
  return release;
}

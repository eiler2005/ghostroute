import path from "node:path";

export function repoRoot() {
  return process.env.GHOSTROUTE_CONSOLE_REPO_ROOT
    ? path.resolve(process.env.GHOSTROUTE_CONSOLE_REPO_ROOT)
    : path.resolve(process.cwd(), "../../..");
}

export function dataDir() {
  if (process.env.GHOSTROUTE_CONSOLE_DATA_DIR) {
    return path.resolve(process.env.GHOSTROUTE_CONSOLE_DATA_DIR);
  }
  if (process.env.NODE_ENV === "production") {
    return "/data";
  }
  return path.resolve(process.cwd(), "..", "data");
}

export function snapshotsDir() {
  return path.join(dataDir(), "snapshots");
}

export function dbPath() {
  return path.join(dataDir(), "ghostroute.db");
}

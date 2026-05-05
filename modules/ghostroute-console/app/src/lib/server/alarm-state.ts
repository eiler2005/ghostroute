import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dataDir, repoRoot } from "./paths";

export type AlarmState = {
  version: number;
  updated_at: string;
  alarms: Record<string, {
    status?: string;
    actor?: string;
    updated_at?: string;
    snoozed_until?: string;
    note?: string;
  }>;
};

export type AlarmStateResult = {
  ok: boolean;
  state: AlarmState;
  source: "router" | "file" | "console-cache" | "empty";
  warning?: string;
};

function emptyState(): AlarmState {
  return { version: 1, updated_at: new Date().toISOString(), alarms: {} };
}

function cacheFile() {
  return path.join(dataDir(), "alarm-state-cache.json");
}

function commandPath() {
  return path.join(repoRoot(), "modules/ghostroute-console/bin/alarm-state");
}

function parseState(value: string): AlarmState {
  const parsed = JSON.parse(value || "{}");
  return {
    version: Number(parsed.version || 1),
    updated_at: String(parsed.updated_at || new Date().toISOString()),
    alarms: parsed.alarms && typeof parsed.alarms === "object" ? parsed.alarms : {},
  };
}

function writeCache(state: AlarmState) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(cacheFile(), JSON.stringify(state, null, 2));
}

function readCache(): AlarmState | null {
  try {
    return parseState(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return null;
  }
}

function snoozedUntil(op: string, minutes = 60) {
  return op === "snooze" ? new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString() : "";
}

function runLocal(op: string, id = "", minutes = 60) {
  return execFileSync(commandPath(), ["--json", op, id, String(minutes), snoozedUntil(op, minutes)], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}

function runRemote(op: string, id = "", minutes = 60) {
  const host = process.env.GHOSTROUTE_READONLY_SSH_HOST;
  const user = process.env.GHOSTROUTE_READONLY_SSH_USER || "ghostroute_readonly";
  const key = process.env.GHOSTROUTE_READONLY_SSH_KEY_PATH || process.env.SSH_KEY_PATH || "/ssh/id_ed25519";
  const remoteRoot = process.env.GHOSTROUTE_READONLY_REMOTE_ROOT || "/opt/router_configuration";
  if (!host) throw new Error("GHOSTROUTE_READONLY_SSH_HOST is required for alarm state ssh mode");
  const remoteCommand = [
    path.posix.join(remoteRoot, "modules/ghostroute-console/bin/alarm-state"),
    "--json",
    op,
    id,
    String(minutes),
    snoozedUntil(op, minutes),
  ].join(" ");
  return execFileSync("ssh", [
    "-i",
    key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "UserKnownHostsFile=/tmp/ghostroute-known-hosts",
    `${user}@${host}`,
    remoteCommand,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
}

function runCommand(op: string, id = "", minutes = 60) {
  const mode = process.env.GHOSTROUTE_ALARM_STATE_MODE || "disabled";
  if (mode === "ssh") return { stdout: runRemote(op, id, minutes), source: "router" as const };
  if (mode === "file" || mode === "local") return { stdout: runLocal(op, id, minutes), source: "file" as const };
  throw new Error("alarm state command is disabled");
}

export function readAlarmState(): AlarmStateResult {
  try {
    const result = runCommand("get");
    const state = parseState(result.stdout);
    writeCache(state);
    return { ok: true, state, source: result.source === "router" ? "router" : "file" };
  } catch (error: any) {
    const cached = readCache();
    if (cached) {
      return {
        ok: false,
        state: cached,
        source: "console-cache",
        warning: String(error?.stderr || error?.message || error).slice(0, 300),
      };
    }
    return {
      ok: false,
      state: emptyState(),
      source: "empty",
      warning: String(error?.stderr || error?.message || error).slice(0, 300),
    };
  }
}

export function writeAlarmState(op: "ack" | "snooze" | "open", id: string, minutes = 60): AlarmStateResult {
  try {
    const result = runCommand(op, id, minutes);
    const state = parseState(result.stdout);
    writeCache(state);
    return { ok: true, state, source: result.source === "router" ? "router" : "file" };
  } catch (error: any) {
    return {
      ok: false,
      state: readCache() || emptyState(),
      source: "console-cache",
      warning: String(error?.stderr || error?.message || error).slice(0, 300),
    };
  }
}

function snoozeExpired(value?: string) {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts <= Date.now();
}

export function overlayAlarmState<T extends Record<string, any>>(rows: T[], stateResult: AlarmStateResult): Array<T & Record<string, any>> {
  return rows.map((row) => {
    const overlay = stateResult.state.alarms[String(row.id)] || {};
    const status = overlay.status === "snoozed" && snoozeExpired(overlay.snoozed_until)
      ? "open"
      : overlay.status || row.status || "open";
    return {
      ...row,
      status,
      snoozed_until: status === "snoozed" ? overlay.snoozed_until || row.snoozed_until || "" : "",
      state_source: stateResult.source,
      state_warning: stateResult.warning || "",
      operator_actor: overlay.actor || "",
      operator_updated_at: overlay.updated_at || "",
      operator_note: overlay.note || "",
    };
  });
}

export function alarmStatusMatches(row: Record<string, any>, status = "all") {
  const normalized = String(row.status || "open").toLowerCase();
  if (status === "all") return true;
  if (status === "active") return normalized === "open" || normalized === "warn" || normalized === "crit" || normalized === "review";
  return normalized === status.toLowerCase();
}

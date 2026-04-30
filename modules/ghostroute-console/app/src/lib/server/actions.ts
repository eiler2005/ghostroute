import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { dataDir } from "./paths";
import { buildConsoleModel } from "./selectors";
import { recordAudit, recordOpsRun, setNotificationSetting, updateNotification, upsertCatalogReview } from "./store";

function actionDir() {
  const dir = path.join(dataDir(), "actions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function jsonBody(value: unknown) {
  return JSON.stringify(value || {}, null, 2);
}

function confirmation(count: number) {
  return `APPLY CATALOG ${count}`;
}

export function reviewCatalog(domain: string, decision: string, reason = "") {
  if (!domain) throw new Error("domain is required");
  if (!["approve", "reject"].includes(decision)) throw new Error("decision must be approve or reject");
  const id = upsertCatalogReview(domain, decision, reason);
  recordAudit("catalog.review", domain, "recorded", `${decision}: ${domain}`, { domain, decision, reason, review_id: id });
  return { id, domain, decision, reason };
}

export function catalogDryRun() {
  const model = buildConsoleModel();
  const approved = model.catalogReviews.filter((row) => row.decision === "approve");
  const rejected = model.catalogReviews.filter((row) => row.decision === "reject");
  const diff = [
    "# GhostRoute catalog dry-run",
    "",
    ...approved.map((row) => `+ ipset=/${row.domain}/STEALTH_DOMAINS`),
    ...rejected.map((row) => `# rejected ${row.domain}: ${row.reason || "no reason"}`),
  ].join("\n");
  const phrase = confirmation(approved.length);
  recordAudit("catalog.dry-run", "catalog", "ok", `${approved.length} approved, ${rejected.length} rejected`, { approved, rejected, phrase });
  return { approved_count: approved.length, rejected_count: rejected.length, confirmation_phrase: phrase, diff };
}

export function catalogApply(typedConfirmation: string) {
  const dryRun = catalogDryRun();
  if (typedConfirmation !== dryRun.confirmation_phrase) {
    recordAudit("catalog.apply", "catalog", "rejected", "confirmation mismatch", { expected: dryRun.confirmation_phrase });
    return { ok: false, status: "confirmation_required", confirmation_phrase: dryRun.confirmation_phrase };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(actionDir(), `catalog-apply-${stamp}.patch.txt`);
  fs.writeFileSync(file, dryRun.diff);
  recordAudit("catalog.apply", "catalog", "prepared", "prepared catalog patch; no router deploy executed", { file, dryRun }, file);
  return { ok: true, status: "prepared", rollback_ref: file, message: "Patch prepared in Console data dir; router deploy remains manual." };
}

export function catalogRollback(rollbackRef: string) {
  recordAudit("catalog.rollback", rollbackRef || "catalog", "prepared", "rollback requested; no router deploy executed", { rollback_ref: rollbackRef });
  return { ok: true, status: "prepared", rollback_ref: rollbackRef, message: "Rollback recorded; runtime remains unchanged." };
}

export function saveNotificationSettings(settings: Record<string, unknown>) {
  for (const [key, value] of Object.entries(settings)) {
    setNotificationSetting(key, value);
  }
  recordAudit("notifications.settings", "notifications", "saved", "notification settings updated", Object.keys(settings));
  return { ok: true, settings };
}

export function ackNotification(id: number) {
  updateNotification(id, "acknowledged");
  recordAudit("notifications.ack", String(id), "ok", "notification acknowledged", { id });
  return { ok: true, id, status: "acknowledged" };
}

export function snoozeNotification(id: number, minutes = 60) {
  const until = new Date(Date.now() + Math.max(1, minutes) * 60000).toISOString();
  updateNotification(id, "snoozed", until);
  recordAudit("notifications.snooze", String(id), "ok", `notification snoozed until ${until}`, { id, until });
  return { ok: true, id, status: "snoozed", snoozed_until: until };
}

export function testNotification() {
  recordAudit("notifications.test", "notifications", "dry-run", "notification test recorded; no secret values exposed", {});
  return { ok: true, status: "dry-run", message: "Notification test recorded. Delivery uses env/config secrets when configured." };
}

export function runOpsAction(action: string) {
  if (action === "rerun-collect") {
    const result = spawnSync("node", [path.join(process.cwd(), "scripts/collect-once.mjs")], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 180000,
      env: process.env,
    });
    const ok = result.status === 0;
    recordOpsRun(action, ok ? "ok" : "failed", ok ? "collector finished" : "collector failed", {
      stdout: String(result.stdout || "").slice(0, 4000),
      stderr: String(result.stderr || "").slice(0, 4000),
      status: result.status,
    });
    return { ok, status: ok ? "ok" : "failed", output: String(result.stdout || result.stderr || "").slice(0, 4000) };
  }
  if (action === "refresh-reports") {
    recordOpsRun(action, "prepared", "reports refresh recorded; snapshots remain factual source", {});
    return { ok: true, status: "prepared" };
  }
  if (action === "restart-collector") {
    recordOpsRun(action, "manual-required", "restart collector requires container supervisor; no process killed by UI", {});
    return { ok: true, status: "manual-required", message: "Restart recorded; container supervisor action remains manual." };
  }
  recordOpsRun(action, "disabled", "action disabled by safety gate", {});
  return { ok: false, status: "disabled" };
}

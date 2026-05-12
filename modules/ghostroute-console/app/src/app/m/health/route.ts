import { getConsolePageSummary } from "@/lib/server/selectors/health";

export const dynamic = "force-dynamic";

const MOBILE_PAGE_SIZE = 10;
const MOBILE_MAX_PAGE_SIZE = 25;

function scalar(value: string | null) {
  return value || "";
}

function intParam(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mobilePageSize(value: string | null) {
  return Math.min(MOBILE_MAX_PAGE_SIZE, Math.max(1, intParam(value, MOBILE_PAGE_SIZE)));
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function compactJson(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactText(value: unknown, limit = 260) {
  const text = compactJson(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}...`;
}

function shortDateTime(value?: string | number | Date) {
  if (!value) return "n/a";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return `${pick("day")}.${pick("month")} ${pick("hour")}:${pick("minute")}:${pick("second")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function minutesSince(value?: string) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.round((Date.now() - time) / 60000));
}

function statusTone(status?: string) {
  const normalized = String(status || "unknown").toLowerCase();
  if (["ok", "healthy", "pass", "passed", "fresh", "n/a"].includes(normalized)) return "ok";
  if (["critical", "crit", "fail", "failed", "down"].includes(normalized)) return "critical";
  if (["warning", "warn", "stale", "degraded", "attention", "review"].includes(normalized)) return "warning";
  return "unknown";
}

function alarmTone(row: Record<string, any>) {
  return statusTone(row.severity || row.status || row.risk);
}

function alarmMatchesStatus(row: Record<string, any>, status: string) {
  const normalized = String(status || "active").toLowerCase();
  const rowStatus = String(row.status || "open").toLowerCase();
  if (normalized === "all") return true;
  if (normalized === "active") return ["open", "active", "warn", "warning", "critical", "review"].includes(rowStatus);
  return rowStatus === normalized;
}

function isControlMachineOnlyGate(row: Record<string, any>) {
  return String(row.id || "").startsWith("vps_edge_") && String(row.evidence || "").includes("ansible_or_vault=missing");
}

function displayDeployGateCheck(row: Record<string, any>) {
  if (!isControlMachineOnlyGate(row)) return row;
  return {
    ...row,
    status: "N/A",
    summary: String(row.summary || "").replace(/^Deploy gate failed:\s*/i, "") || "Control-machine-only check not available inside Console collector",
    suggested_action: "Run the deploy gate from the GhostRoute control machine with Vault access.",
  };
}

function deployGateStatus(rows: Array<Record<string, any>>, fallback?: string) {
  const visibleRows = rows.map(displayDeployGateCheck);
  if (visibleRows.some((row) => row.status === "CRIT")) return "CRIT";
  if (visibleRows.some((row) => row.status === "WARN")) return "WARN";
  if (visibleRows.some((row) => row.status === "OK")) return "OK";
  return fallback || "UNKNOWN";
}

function makeHref(path: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function rowCard(row: Record<string, any>, tone: string, title: string, meta: string, body: string, extra = "") {
  return `<article class="row tone-${escapeHtml(tone)}">
    <div class="row-head"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(meta)}</span></div>
    <p>${escapeHtml(body)}</p>
    ${extra ? `<small>${escapeHtml(extra)}</small>` : ""}
  </article>`;
}

function styles() {
  return `<style>
    :root { color-scheme: dark; --bg:#07111f; --panel:#10243a; --panel2:#0c1b2d; --line:#294663; --text:#eef5ff; --muted:#aebed2; --blue:#63a8ff; --green:#62e795; --yellow:#ffc65f; --red:#ff7d7d; }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: 14px; }
    a { color: #9fc7ff; text-decoration: none; }
    .shell { max-width: 760px; margin: 0 auto 28px; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .brand strong { display: block; font-size: 20px; line-height: 1.1; }
    .brand span, .muted, small { color: var(--muted); }
    .desktop { border: 1px solid var(--line); border-radius: 12px; padding: 9px 11px; background: #0c1a2b; }
    .nav { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0 12px; }
    .nav a { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 8px 11px; color: var(--muted); background: #0b1728; }
    .nav a.active { color: var(--blue); border-color: #2f75bf; background: #0f2947; }
    .status-strip, .summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .status-strip div, .summary span, .card, .hero { border: 1px solid var(--line); border-radius: 14px; background: linear-gradient(180deg, var(--panel), var(--panel2)); padding: 12px; }
    .status-strip span, .summary span { color: var(--muted); font-size: 12px; }
    .status-strip strong, .summary b { display: block; margin-top: 4px; font-size: 15px; color: var(--text); overflow-wrap: anywhere; }
    .hero { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 0; font-size: 20px; }
    p { margin: 7px 0 0; color: var(--muted); line-height: 1.35; overflow-wrap: anywhere; }
    .badge { flex: 0 0 auto; border: 1px solid var(--line); border-radius: 999px; padding: 5px 8px; color: var(--muted); font-weight: 800; font-size: 12px; }
    .tone-ok .badge, .tone-ok .row-head span, .status-ok { color: var(--green); border-color: #2d8d60; }
    .tone-warning .badge, .tone-warning .row-head span, .status-warning { color: var(--yellow); border-color: #a87822; }
    .tone-critical .badge, .tone-critical .row-head span, .status-critical { color: var(--red); border-color: #a94b4b; }
    .tone-unknown .badge, .tone-unknown .row-head span, .status-unknown { color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
    .card-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .filter { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; margin-bottom: 10px; }
    input, select, button { min-width: 0; border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: #081626; color: var(--text); font: inherit; }
    button { color: #9fc7ff; font-weight: 800; }
    .row { border-top: 1px solid rgba(127, 162, 197, .24); padding: 10px 0; }
    .row:first-child { border-top: 0; }
    .row-head { display: flex; justify-content: space-between; gap: 10px; }
    .row-head strong { min-width: 0; overflow-wrap: anywhere; }
    .row-head span { flex: 0 0 auto; font-weight: 800; }
    .row small { display: block; margin-top: 6px; overflow-wrap: anywhere; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .meta span { border-top: 1px solid rgba(127, 162, 197, .22); padding-top: 8px; color: var(--muted); }
    .meta b { display: block; color: var(--text); margin-top: 3px; overflow-wrap: anywhere; }
    .pagination { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; color: var(--muted); }
    .pagination a, .pagination span.nav-disabled { border: 1px solid var(--line); border-radius: 10px; padding: 7px 9px; margin-left: 5px; }
    .empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 12px; padding: 14px; }
    @media (max-width: 520px) { body { padding: 10px; } .status-strip, .summary, .cards, .meta { grid-template-columns: 1fr; } .filter { grid-template-columns: 1fr; } h1 { font-size: 25px; } }
  </style>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = scalar(url.searchParams.get("status")) || "active";
  const search = scalar(url.searchParams.get("search")).toLowerCase();
  const page = intParam(url.searchParams.get("page"), 1);
  const pageSize = mobilePageSize(url.searchParams.get("pageSize"));
  const summaryRecord = getConsolePageSummary("health_mobile");
  const summary = summaryRecord?.payload || null;
  const statusCards = Array.isArray(summary?.statusCards) ? summary.statusCards : [];
  const allAlarms = Array.isArray(summary?.alarms) ? summary.alarms : [];
  const searchedAlarms = search
    ? allAlarms.filter((row: Record<string, any>) => compactJson(row).toLowerCase().includes(search))
    : allAlarms;
  const filteredAlarms = searchedAlarms.filter((row: Record<string, any>) => alarmMatchesStatus(row, status));
  const alarmStart = (page - 1) * pageSize;
  const alarmRows = filteredAlarms.slice(alarmStart, alarmStart + pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredAlarms.length / pageSize));
  const critical = Number(summary?.alarmCounts?.critical || allAlarms.filter((row: Record<string, any>) => row.severity === "critical").length);
  const warning = Number(summary?.alarmCounts?.warning || allAlarms.filter((row: Record<string, any>) => row.severity === "warning").length);
  const active = Number(summary?.alarmCounts?.active ?? allAlarms.length);
  const checks = Array.isArray(summary?.health?.checks) ? summary.health.checks : [];
  const deployGateSnapshot = summary?.deployGate || null;
  const deployGateChecks = Array.isArray(deployGateSnapshot?.checks) ? deployGateSnapshot.checks.map(displayDeployGateCheck) : [];
  const deployStatus = deployGateStatus(deployGateChecks, deployGateSnapshot?.status || "UNKNOWN");
  const leakSnapshot = summary?.leaks || null;
  const newest = Object.values(summary?.snapshotTimes || {}).filter(Boolean).sort().pop() as string | undefined;
  const freshnessMinutes = minutesSince(newest);
  const freshnessStatus = freshnessMinutes === null ? "empty" : freshnessMinutes > 75 ? "stale" : "fresh";
  const overall = statusCards.some((row: Record<string, any>) => statusTone(row.status) === "critical")
    ? "Attention"
    : allAlarms.length > 0
      ? "Review"
      : "OK";
  const pageInfo = `Showing ${filteredAlarms.length === 0 ? 0 : alarmStart + 1}-${Math.min(filteredAlarms.length, alarmStart + pageSize)} of ${filteredAlarms.length}`;
  const prevHref = makeHref("/m/health", { status, search, page: Math.max(1, page - 1), pageSize });
  const nextHref = makeHref("/m/health", { status, search, page: Math.min(totalPages, page + 1), pageSize });

  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex,nofollow">
    <title>Health Center - GhostRoute Console</title>
    ${styles()}
  </head>
  <body>
    <main class="shell">
      <header class="top">
        <div class="brand"><strong>GhostRoute Console</strong><span>Mobile health</span></div>
        <a class="desktop" href="/health?desktop=1">Desktop version</a>
      </header>
      <nav class="nav" aria-label="Mobile Console navigation">
        <a href="/m">Home</a><a href="/m/traffic">Flows</a><a href="/m/dns">DNS</a><a href="/m/clients">Clients</a><a class="active" href="/m/health">Health</a><a href="/m/live">Live</a><a href="/m/catalog">Catalog</a>
      </nav>
      <section class="status-strip">
        <div><span>Freshness</span><strong>${freshnessMinutes === null ? "snapshots n/a" : freshnessMinutes === 0 ? "fresh now" : `${freshnessMinutes}m ago`}</strong></div>
        <div><span>Traffic</span><strong>${escapeHtml(summary?.snapshotTimes?.traffic_summary ? shortDateTime(summary.snapshotTimes.traffic_summary) : "n/a")}</strong></div>
        <div><span>Summary</span><strong>${escapeHtml(summaryRecord?.rebuilt_at ? shortDateTime(summaryRecord.rebuilt_at) : "n/a")}</strong></div>
      </section>
      <section class="hero tone-${statusTone(overall)}">
        <div><h1>Health Center</h1><p>Remote triage view for system status, collector freshness and actionable alarms.</p></div>
        <span class="badge">${escapeHtml(overall)}</span>
      </section>
      <section class="summary">
        <span>Critical <b>${critical}</b></span><span>Warnings <b>${warning}</b></span><span>Open signals <b>${active}</b></span>
      </section>
      ${!summary ? `<section class="card"><div class="empty">No prepared health summary yet.</div></section>` : ""}
      <section class="cards" aria-label="Health status summary">
        ${statusCards.map((card: Record<string, any>) => `<article class="card tone-${statusTone(card.status)}"><span class="muted">${escapeHtml(card.label || "Status")}</span><h2>${escapeHtml(card.status || "UNKNOWN")}</h2><p>${escapeHtml(card.detail || "not observed")}</p></article>`).join("")}
      </section>
      <section class="card">
        <div class="card-title"><h2>Alarm Center</h2><span class="muted">${filteredAlarms.length} ${escapeHtml(status)} alarms</span></div>
        <form class="filter" action="/m/health" method="get">
          <input name="search" value="${escapeHtml(scalar(url.searchParams.get("search")))}" placeholder="Search alarms">
          <select name="status">
            ${["active", "open", "acknowledged", "snoozed", "all"].map((item) => `<option value="${item}"${item === status ? " selected" : ""}>${item === "acknowledged" ? "Acked" : item[0].toUpperCase() + item.slice(1)}</option>`).join("")}
          </select>
          <button type="submit">Apply</button>
        </form>
        ${alarmRows.length === 0 ? `<div class="empty">No alarm rows.</div>` : alarmRows.map((row: Record<string, any>) => rowCard(row, alarmTone(row), row.title || "Alarm", row.severity || row.status || "info", row.evidence || "no evidence attached", row.suggested_action ? compactText(row.suggested_action, 220) : "")).join("")}
        <div class="pagination"><span>${pageInfo}</span><div>${page > 1 ? `<a href="${escapeHtml(prevHref)}">Prev</a>` : `<span class="nav-disabled">Prev</span>`}<strong> ${page} / ${totalPages} </strong>${page < totalPages ? `<a href="${escapeHtml(nextHref)}">Next</a>` : `<span class="nav-disabled">Next</span>`}</div></div>
      </section>
      <section class="card">
        <div class="card-title"><h2>Deploy Gate</h2><span class="badge status-${statusTone(deployStatus)}">${escapeHtml(deployStatus)}</span></div>
        ${!deployGateSnapshot ? `<div class="empty">No deploy-gate snapshot.</div>` : `<div class="meta"><span>mode <b>${escapeHtml(deployGateSnapshot.mode || "unknown")}</b></span><span>duration <b>${escapeHtml(deployGateSnapshot.estimated_duration || "n/a")}</b></span><span>generated <b>${escapeHtml(deployGateSnapshot.generated_at ? shortDateTime(deployGateSnapshot.generated_at) : "n/a")}</b></span></div>${deployGateChecks.map((row: Record<string, any>) => rowCard(row, statusTone(row.status), row.component ? `${row.component} / ${row.id}` : row.id || "deploy check", row.status || "UNKNOWN", compactText(row.summary || "no summary", 220), row.suggested_action ? compactText(row.suggested_action, 220) : "")).join("")}`}
      </section>
      <section class="card">
        <div class="card-title"><h2>Health Center</h2><span class="muted">${checks.length} probes</span></div>
        ${checks.length === 0 ? `<div class="empty">No factual health checks.</div>` : checks.map((row: Record<string, any>) => rowCard(row, statusTone(row.status), row.label || row.probe || "probe", row.status || "UNKNOWN", compactText(row.message || row.evidence_json || row.evidence || "not observed", 220), row.suggested_action ? compactText(row.suggested_action, 220) : "")).join("")}
      </section>
      <section class="card">
        <div class="card-title"><h2>Leak-check evidence</h2><span class="badge status-${statusTone(leakSnapshot?.overall)}">${escapeHtml(leakSnapshot?.overall || "UNKNOWN")}</span></div>
        ${!leakSnapshot ? `<div class="empty">No leak-check snapshot.</div>` : `<div class="meta"><span>signals <b>${Number(leakSnapshot.leakSignals || 0)}</b></span><span>evidence <b>${Number(leakSnapshot.evidenceRows || (leakSnapshot.evidence || []).length)}</b></span><span>confidence <b>${escapeHtml(leakSnapshot.confidence || "unknown")}</b></span></div>${(leakSnapshot.evidence || []).map((row: Record<string, any>) => rowCard(row, "unknown", row.probe || "evidence", "observed", compactText(row.evidence || row.message || "not observed", 240))).join("")}`}
      </section>
      <section class="card">
        <div class="card-title"><h2>Freshness</h2><span class="status-${statusTone(freshnessStatus)}">${escapeHtml(freshnessStatus)}</span></div>
        <div class="meta"><span>latest <b>${freshnessMinutes === null ? "n/a" : `${freshnessMinutes}m ago`}</b></span><span>summary <b>${escapeHtml(summaryRecord?.rebuilt_at ? shortDateTime(summaryRecord.rebuilt_at) : "n/a")}</b></span><span>threshold <b>75m</b></span><span>open signals <b>${active}</b></span></div>
      </section>
    </main>
  </body>
  </html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

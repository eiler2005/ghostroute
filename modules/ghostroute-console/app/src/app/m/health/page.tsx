import { MobileShell } from "@/components/MobileShell";
import { shortDateTime } from "@/components/Widgets";
import { getConsolePageSummary } from "@/lib/server/selectors/health";
import { buildLightweightShellModel } from "@/lib/server/selectors/shell";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";
import { Pagination, scalar, mobilePageSize } from "../mobile-ui";

function statusTone(status?: string) {
  const normalized = String(status || "unknown").toLowerCase();
  if (["ok", "healthy", "pass", "passed", "fresh"].includes(normalized)) return "ok";
  if (["critical", "crit", "fail", "failed", "down"].includes(normalized)) return "critical";
  if (["warning", "warn", "stale", "degraded", "attention", "review"].includes(normalized)) return "warning";
  return "unknown";
}

function alarmTone(row: Record<string, any>) {
  return statusTone(row.severity || row.status || row.risk);
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
  return `${text.slice(0, limit - 1)}…`;
}

function alarmMatchesStatus(row: Record<string, any>, status: string) {
  const normalized = String(status || "active").toLowerCase();
  const rowStatus = String(row.status || "open").toLowerCase();
  if (normalized === "all") return true;
  if (normalized === "active") return ["open", "active", "warn", "warning", "critical", "review"].includes(rowStatus);
  return rowStatus === normalized;
}

export default async function MobileHealthPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const page = Math.max(1, Number.parseInt(scalar(params.page) || "1", 10) || 1);
  const pageSize = mobilePageSize(scalar(params.pageSize));
  const status = scalar(params.status) || "active";
  const summaryRecord = getConsolePageSummary("health_mobile");
  const summary = summaryRecord?.payload || null;
  const summaryAlarms = Array.isArray(summary?.alarms) ? summary.alarms : [];
  const filteredAlarms: Array<Record<string, any>> = summaryAlarms.filter((row: Record<string, any>) => alarmMatchesStatus(row, status));
  const alarmStart = (page - 1) * pageSize;
  const alarms = {
    rows: filteredAlarms.slice(alarmStart, alarmStart + pageSize),
    total: filteredAlarms.length,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(filteredAlarms.length / pageSize)),
  };
  const model = buildLightweightShellModel(filters, {
    alerts: summaryAlarms,
    statusCards: Array.isArray(summary?.statusCards) ? summary.statusCards : undefined,
  });
  const critical = Number(summary?.alarmCounts?.critical || summaryAlarms.filter((row: Record<string, any>) => row.severity === "critical").length);
  const warning = Number(summary?.alarmCounts?.warning || summaryAlarms.filter((row: Record<string, any>) => row.severity === "warning").length);
  const checks = Array.isArray(summary?.health?.checks) ? summary.health.checks : [];
  const deployGateSnapshot = summary?.deployGate || null;
  const deployGateChecks = (deployGateSnapshot?.checks || []).map(displayDeployGateCheck);
  const deployStatus = deployGateStatus(deployGateChecks, deployGateSnapshot?.status || "UNKNOWN");
  const leakSnapshot = summary?.leaks || null;
  const overall = model.statusCards.some((row) => statusTone(row.status) === "critical")
    ? "Attention"
    : model.alerts.length > 0
      ? "Review"
      : "OK";

  return (
    <MobileShell active="/m/health" model={model} filters={filters} desktopPath="/health">
      <section className={`mobile-health-hero mobile-health-${statusTone(overall)}`}>
        <div>
          <h1>Health Center</h1>
          <p>Remote triage view for system status, collector freshness and actionable alarms.</p>
        </div>
        <strong>{overall}</strong>
      </section>

      <section className="mobile-health-summary">
        <span>Critical <b>{critical}</b></span>
        <span>Warnings <b>{warning}</b></span>
        <span>Open signals <b>{summary?.alarmCounts?.active ?? model.alerts.length}</b></span>
        <span>Freshness <b>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m`}</b></span>
      </section>

      {!summary ? (
        <section className="mobile-flat-card">
          <div className="mobile-empty">No prepared health summary yet.</div>
        </section>
      ) : null}

      <section className="mobile-status-card-grid" aria-label="Health status summary">
        {model.statusCards.map((card) => (
          <div className={`mobile-status-card mobile-health-${statusTone(card.status)}`} key={card.label}>
            <span>{card.label}</span>
            <strong>{card.status || "UNKNOWN"}</strong>
            <small>{card.detail || "not observed"}</small>
          </div>
        ))}
      </section>

      <section className="mobile-flat-card">
        <div className="mobile-flat-title">
          <h2>Alarm Center</h2>
          <span>{alarms.total} {status} alarms</span>
        </div>
        <form className="mobile-filter mobile-filter-grid" action="/m/health">
          <input name="search" defaultValue={filters.search || ""} placeholder="Search alarms" />
          <select name="status" defaultValue={status}>
            <option value="active">Active</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acked</option>
            <option value="snoozed">Snoozed</option>
            <option value="all">All</option>
          </select>
          <button type="submit">Apply</button>
        </form>
        {alarms.rows.length === 0 ? (
          <div className="mobile-empty">No alarm rows.</div>
        ) : (
          <div className="mobile-health-list">
            {alarms.rows.map((row) => (
              <div className={`mobile-alarm-row mobile-health-${alarmTone(row)}`} key={row.id || `${row.source}-${row.title}`}>
                <div className="mobile-alarm-head">
                  <strong>{row.title || "Alarm"}</strong>
                  <span>{row.severity || row.status || "info"}</span>
                </div>
                <div className="mobile-alarm-meta">
                  <span>{row.source || "console"}</span>
                  <span>{row.status || "open"}</span>
                </div>
                <p>{compactText(row.evidence || "no evidence attached")}</p>
                {row.suggested_action ? <small>{compactText(row.suggested_action, 220)}</small> : null}
              </div>
            ))}
          </div>
        )}
        <Pagination basePath="/m/health" page={alarms.page} pageSize={alarms.pageSize} total={alarms.total} totalPages={alarms.totalPages} extraParams={{ status }} />
      </section>

      <section className="mobile-flat-card">
        <div className="mobile-flat-title">
          <h2>Deploy Gate</h2>
          <span className={`mobile-inline-status mobile-health-${statusTone(deployStatus)}`}>{deployStatus}</span>
        </div>
        {!deployGateSnapshot ? (
          <div className="mobile-empty">No deploy-gate snapshot.</div>
        ) : (
          <>
            <div className="mobile-compact-meta">
              <span>mode <b>{deployGateSnapshot.mode || "unknown"}</b></span>
              <span>duration <b>{deployGateSnapshot.estimated_duration || "n/a"}</b></span>
              <span>generated <b>{deployGateSnapshot.generated_at ? shortDateTime(deployGateSnapshot.generated_at) : "n/a"}</b></span>
            </div>
            <div className="mobile-health-list">
              {deployGateChecks.map((row: Record<string, any>) => (
                <div className={`mobile-alarm-row mobile-health-${statusTone(row.status)}`} key={row.id || row.summary}>
                  <div className="mobile-alarm-head">
                    <strong>{row.component ? `${row.component} / ${row.id}` : row.id || "deploy check"}</strong>
                    <span>{row.status || "UNKNOWN"}</span>
                  </div>
                  <p>{compactText(row.summary || "no summary", 220)}</p>
                  {row.evidence ? <small>{compactText(row.evidence, 220)}</small> : null}
                  {row.suggested_action ? <small>{compactText(row.suggested_action, 220)}</small> : null}
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="mobile-flat-card">
        <div className="mobile-flat-title">
          <h2>Health Center</h2>
          <span>{checks.length} probes</span>
        </div>
        {checks.length === 0 ? (
          <div className="mobile-empty">No factual health checks.</div>
        ) : (
          <div className="mobile-health-list">
            {checks.map((row: Record<string, any>, idx: number) => (
              <div className={`mobile-health-row mobile-health-${statusTone(row.status)}`} key={`${row.label || row.probe || "check"}-${idx}`}>
                <div className="mobile-health-main">
                  <strong>{row.label || row.probe || "probe"}</strong>
                  <small>{compactText(row.message || row.evidence_json || row.evidence || "not observed", 220)}</small>
                  {row.evidence ? <em>{compactText(row.evidence, 260)}</em> : null}
                </div>
                <span>{row.status || "UNKNOWN"}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mobile-flat-card">
        <div className="mobile-flat-title">
          <h2>Leak-check evidence</h2>
          <span className={`mobile-inline-status mobile-health-${statusTone(leakSnapshot?.overall)}`}>{leakSnapshot?.overall || "UNKNOWN"}</span>
        </div>
        {!leakSnapshot ? (
          <div className="mobile-empty">No leak-check snapshot.</div>
        ) : (
          <>
            <div className="mobile-compact-meta">
              <span>signals <b>{leakSnapshot.leakSignals || 0}</b></span>
              <span>evidence <b>{leakSnapshot.evidenceRows || (leakSnapshot.evidence || []).length}</b></span>
              <span>confidence <b>{leakSnapshot.confidence || "unknown"}</b></span>
            </div>
            <div className="mobile-health-list">
              {(leakSnapshot.evidence || []).map((row: Record<string, any>, idx: number) => (
                <div className="mobile-health-row mobile-health-unknown" key={`${row.probe || "evidence"}-${idx}`}>
                  <div className="mobile-health-main">
                    <strong>{row.probe || "evidence"}</strong>
                    <small>{compactText(row.evidence || row.message || "not observed", 240)}</small>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="mobile-flat-card">
        <div className="mobile-flat-title">
          <h2>Freshness</h2>
          <span>{model.freshnessStatus}</span>
        </div>
        <div className="mobile-compact-meta">
          <span>latest <b>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m ago`}</b></span>
          <span>summary <b>{summaryRecord?.rebuilt_at ? shortDateTime(summaryRecord.rebuilt_at) : "n/a"}</b></span>
          <span>threshold <b>{model.staleThresholdMinutes || 75}m</b></span>
          <span>open signals <b>{model.alerts.length}</b></span>
        </div>
      </section>
    </MobileShell>
  );
}

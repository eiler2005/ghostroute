import { ConsoleShell } from "@/components/ConsoleShell";
import { AlarmActions } from "@/components/AlarmActions";
import { EmptyState, RawEvidence, shortDateTime, StatusBadge } from "@/components/Widgets";
import { buildHealthModel, listAlarmEvents } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
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
    suggested_action: "Run the deploy gate from the GhostRoute control machine with Vault access. Console marks this row N/A because the VPS collector is intentionally readonly.",
  };
}

function displayDeployGateStatus(rows: Array<Record<string, any>>, fallback?: string) {
  const visibleRows = rows.map(displayDeployGateCheck);
  if (visibleRows.some((row) => row.status === "CRIT")) return "CRIT";
  if (visibleRows.some((row) => row.status === "WARN")) return "WARN";
  if (visibleRows.some((row) => row.status === "OK")) return "OK";
  return fallback || "UNKNOWN";
}

export default async function HealthPage({ searchParams }: { searchParams?: SearchParams }) {
  const rawParams: Record<string, string | string[] | undefined> = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(searchParams);
  const model = buildHealthModel(filters);
  const alarmStatus = scalar(rawParams.status) || "active";
  const alarmPage = listAlarmEvents({ page: 1, pageSize: 50, filters, status: alarmStatus });
  const alarms = alarmPage.rows;
  const critical = alarms.filter((row) => row.severity === "critical");
  const warnings = alarms.filter((row) => row.severity === "warning" || row.severity === "review");
  const info = alarms.filter((row) => row.severity === "info");
  const stateWarning = alarms.find((row) => row.state_warning)?.state_warning || "";
  const checks = [
    ...(model.snapshots.health?.payload?.checks || []),
    ...(model.snapshots.leaks?.payload?.checks || []),
  ];
  const deployGateSnapshot = model.snapshots.deploy_gate?.payload;
  const deployGateChecks = (deployGateSnapshot?.checks || []).map(displayDeployGateCheck);
  const leakSnapshot = model.snapshots.leaks?.payload;
  return (
    <ConsoleShell active="/health" model={model} filters={filters}>
      <div className="grid cards" style={{ marginBottom: 14 }}>
        {model.statusCards.map((card) => (
          <section className="card" key={card.label}>
            <h3>{card.label}</h3>
            <StatusBadge value={card.status} />
            <p>{card.detail}</p>
          </section>
        ))}
      </div>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div>
            <h2>Alarm Center</h2>
            <p>Critical, Warning и Info события с evidence и suggested action.</p>
          </div>
          <div className="button-row">
            {["active", "open", "acknowledged", "snoozed", "all"].map((value) => (
              <a className={`muted-button ${alarmStatus === value ? "primary" : ""}`} href={`/health?status=${value}`} key={value}>{value}</a>
            ))}
          </div>
        </div>
        <p className="subtle">{alarmPage.total} signals; state source: {alarms[0]?.state_source || "n/a"}{stateWarning ? `; sync warning: ${stateWarning}` : ""}</p>
        <div className="grid three alarm-summary" style={{ marginBottom: 14 }}>
          <section><span>Critical</span><strong>{critical.length}</strong></section>
          <section><span>Warning</span><strong>{warnings.length}</strong></section>
          <section><span>Info</span><strong>{info.length}</strong></section>
        </div>
        {alarms.length === 0 ? (
          <EmptyState title="Нет активных alarm events" />
        ) : (
          <table className="table alarm-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Source</th>
                <th>Event</th>
                <th>Evidence</th>
                <th>Suggested action</th>
                <th>Status</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {alarms.map((row) => (
                <tr key={row.id}>
                  <td><span className={`badge severity-${String(row.severity || "warning").toLowerCase()}`}>{row.severity}</span></td>
                  <td>{row.source || "snapshot"}</td>
                  <td>{row.title}</td>
                  <td>{row.evidence || "n/a"}</td>
                  <td>{row.suggested_action || "Review source evidence before changing runtime state."}</td>
                  <td><StatusBadge value={row.status || "open"} /></td>
                  <td>
                    <span className="subtle">{row.state_source || "derived"}</span>
                    {row.snoozed_until ? <small className="block-detail">until {shortDateTime(row.snoozed_until)}</small> : null}
                    {row.operator_updated_at ? <small className="block-detail">updated {shortDateTime(row.operator_updated_at)}</small> : null}
                  </td>
                  <td><AlarmActions id={row.id} status={row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" style={{ marginBottom: 14 }}>
        <div className="toolbar">
          <div>
            <h2>Deploy Gate</h2>
            <p>Pre-deploy canary for managed Wi-Fi, VPS edge and Channel A/B/C.</p>
          </div>
          <StatusBadge value={displayDeployGateStatus(deployGateChecks, deployGateSnapshot?.overall_status || "UNKNOWN")} />
        </div>
        {!deployGateSnapshot ? (
          <EmptyState title="Нет deploy-gate snapshot" />
        ) : (
          <>
            <p className="subtle">
              mode: {deployGateSnapshot.mode || "unknown"}; estimated: {deployGateSnapshot.estimated_duration || "n/a"}; generated: {shortDateTime(deployGateSnapshot.generated_at)}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Evidence</th>
                  <th>Suggested action</th>
                </tr>
              </thead>
              <tbody>
                {deployGateChecks.map((row: any) => (
                  <tr key={row.id || row.summary}>
                    <td>{row.component ? `${row.component} / ${row.id}` : row.id}</td>
                    <td><StatusBadge value={row.status} /></td>
                    <td>{row.summary}</td>
                    <td>{row.evidence || "n/a"}</td>
                    <td>{row.suggested_action || "Review gate evidence before deploy."}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
      <section className="card">
        <div className="toolbar">
          <h2>Health Center</h2>
          <span className="subtle">Router / VPS / Reality / DNS / leaks</span>
        </div>
        {checks.length === 0 ? (
          <EmptyState title="Нет фактических health checks" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Probe</th>
                <th>Status</th>
                <th>Message</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((row: any, idx: number) => (
                <tr key={idx}>
                  <td>{row.label || row.probe}</td>
                  <td><StatusBadge value={row.status} /></td>
                  <td>{row.message}</td>
                  <td>{typeof row.evidence === "string" ? row.evidence : JSON.stringify(row.evidence_json || row.evidence || {})}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <div className="grid two" style={{ marginTop: 14 }}>
        <section className="card">
          <h2>Leak-check evidence</h2>
          {!leakSnapshot ? (
            <EmptyState title="Нет leak-check snapshot" />
          ) : (
            <div className="detail-list">
              <div className="detail-row"><span>Overall</span><strong>{leakSnapshot.overall || "UNKNOWN"}</strong></div>
              <div className="detail-row"><span>Leak signals</span><strong>{(leakSnapshot.leaks || []).length}</strong></div>
              <div className="detail-row"><span>Evidence rows</span><strong>{(leakSnapshot.evidence || []).length}</strong></div>
              <div className="detail-row"><span>Confidence</span><strong>{leakSnapshot.confidence || "unknown"}</strong></div>
            </div>
          )}
          <RawEvidence value={{ checks, leakSnapshot }} />
        </section>
        <aside className="card">
          <h2>Freshness</h2>
          <div className="detail-list">
            <div className="detail-row"><span>Latest snapshot</span><strong>{model.freshnessMinutes === null ? "n/a" : `${model.freshnessMinutes}m ago`}</strong></div>
            <div className="detail-row"><span>Stale alert threshold</span><strong>30m</strong></div>
            <div className="detail-row"><span>Open signals</span><strong>{model.alerts.length}</strong></div>
          </div>
        </aside>
      </div>
    </ConsoleShell>
  );
}

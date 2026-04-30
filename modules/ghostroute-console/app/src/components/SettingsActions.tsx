"use client";

import { useState } from "react";

export function SettingsActions() {
  const [output, setOutput] = useState("");

  async function post(url: string, body: Record<string, any> = {}) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setOutput(JSON.stringify(await response.json(), null, 2));
  }

  return (
    <div className="grid two" style={{ marginTop: 14 }}>
      <section className="card">
        <h2>Controlled ops actions</h2>
        <p>Actions are explicit and audited. Router deploy/runtime mutations remain disabled unless separately reviewed.</p>
        <div className="button-row" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="muted-button" type="button" onClick={() => post("/api/actions/ops", { action: "rerun-collect" })}>Re-run collect</button>
          <button className="muted-button" type="button" onClick={() => post("/api/actions/ops", { action: "refresh-reports" })}>Refresh reports</button>
          <button className="muted-button" type="button" onClick={() => post("/api/actions/ops", { action: "restart-collector" })}>Restart collector</button>
        </div>
      </section>
      <section className="card">
        <h2>Notification actions</h2>
        <p>Secrets stay in env/config. UI stores only thresholds and delivery flags.</p>
        <div className="button-row" style={{ justifyContent: "flex-start", marginTop: 12 }}>
          <button className="muted-button" type="button" onClick={() => post("/api/notifications/settings", { telegram_enabled: true, email_enabled: false, quota_warning_pct: 80, quota_critical_pct: 100, stale_minutes: 30 })}>Save defaults</button>
          <button className="muted-button" type="button" onClick={() => post("/api/notifications/test")}>Test notification</button>
        </div>
      </section>
      {output ? <section className="card"><h2>Action result</h2><pre className="codebox">{output}</pre></section> : null}
    </div>
  );
}

"use client";

import { useState } from "react";

export function CatalogReviewPanel({ candidates }: { candidates: Array<Record<string, any>> }) {
  const [domain, setDomain] = useState(candidates[0]?.domain || "");
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [dryRun, setDryRun] = useState<Record<string, any> | null>(null);
  const [status, setStatus] = useState("");

  async function review(decision: string) {
    const response = await fetch("/api/actions/catalog/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domain, decision, reason }),
    });
    setStatus(JSON.stringify(await response.json(), null, 2));
  }

  async function runDryRun() {
    const response = await fetch("/api/actions/catalog/dry-run", { method: "POST" });
    const body = await response.json();
    setDryRun(body);
    setStatus(JSON.stringify(body, null, 2));
  }

  async function apply() {
    const response = await fetch("/api/actions/catalog/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    setStatus(JSON.stringify(await response.json(), null, 2));
  }

  return (
    <div className="action-panel">
      <h3>Review/apply flow</h3>
      <input value={domain} onChange={(event) => setDomain(event.target.value)} placeholder="candidate domain" />
      <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="reason/comment" />
      <div className="button-row">
        <button className="muted-button" onClick={() => review("approve")} type="button">Approve</button>
        <button className="muted-button" onClick={() => review("reject")} type="button">Reject</button>
        <button className="muted-button" onClick={runDryRun} type="button">Dry-run</button>
        <button className="muted-button primary" disabled={!dryRun || confirmation !== dryRun?.confirmation_phrase} onClick={apply} type="button">Apply prepared</button>
      </div>
      {dryRun ? <div className="page-note">Confirmation phrase: <strong>{dryRun.confirmation_phrase}</strong></div> : null}
      <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="type confirmation phrase before apply" />
      {status ? <pre className="codebox">{status}</pre> : null}
    </div>
  );
}

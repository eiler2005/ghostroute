"use client";

import { useState } from "react";

export function AlarmActions({ id, status }: { id: string; status?: string }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const normalized = String(status || "open").toLowerCase();

  async function post(action: "ack" | "snooze" | "open", minutes?: number) {
    setBusy(action);
    setMessage("");
    const response = await fetch(`/api/alarms/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(minutes ? { minutes } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      setMessage(body.warning || "Action failed");
      setBusy("");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="alarm-actions">
      {normalized !== "acknowledged" ? (
        <button className="muted-button" type="button" disabled={Boolean(busy)} onClick={() => post("ack")}>Ack</button>
      ) : null}
      <button className="muted-button" type="button" disabled={Boolean(busy)} onClick={() => post("snooze", 60)}>Snooze 1h</button>
      <button className="muted-button" type="button" disabled={Boolean(busy)} onClick={() => post("snooze", 1440)}>Snooze 24h</button>
      {normalized !== "open" ? (
        <button className="muted-button" type="button" disabled={Boolean(busy)} onClick={() => post("open")}>Reopen</button>
      ) : null}
      {message ? <span className="subtle">{message}</span> : null}
    </div>
  );
}

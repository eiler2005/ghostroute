"use client";

import { useEffect, useState } from "react";
import { RouteBadge } from "@/components/Widgets";

type LivePayload = {
  generated_at: string;
  freshness_status: string;
  events: Array<Record<string, any>>;
  route_decisions: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
};

export function LiveStreamPanel({ initial }: { initial: LivePayload }) {
  const [payload, setPayload] = useState(initial);
  const [mode, setMode] = useState("SSE connecting");

  useEffect(() => {
    const source = new EventSource("/api/live/stream");
    source.addEventListener("snapshot", (event) => {
      setPayload(JSON.parse((event as MessageEvent).data));
      setMode("SSE live");
    });
    source.onerror = () => {
      setMode("SSE fallback");
    };
    return () => source.close();
  }, []);

  return (
    <section className="card live-stream-card">
      <div className="toolbar">
        <div>
          <h2>Live event stream</h2>
          <p>DNS, flows, route decisions and alerts from append-only Console events.</p>
        </div>
        <span className={`badge status-${payload.freshness_status === "fresh" ? "ok" : "warn"}`}>{mode}</span>
      </div>
      <div className="live-feed">
        {[...(payload.events || []), ...(payload.route_decisions || [])].slice(0, 18).map((row, idx) => (
          <div className="live-feed-row" key={`${row.event_type || "decision"}-${row.id || idx}`}>
            <span>{row.occurred_at || payload.generated_at}</span>
            <strong>{row.event_type || "route.decision"}</strong>
            <small>{row.client || "client"} → {row.destination || row.summary || "destination"}</small>
            <RouteBadge value={row.route || "Unknown"} />
          </div>
        ))}
      </div>
    </section>
  );
}

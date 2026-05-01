"use client";

import { useEffect, useState } from "react";
import { ChannelBadge, RouteBadge, shortDateTime } from "@/components/Widgets";

type LivePayload = {
  generated_at: string;
  freshness_status: string;
  events: Array<Record<string, any>>;
  total_events?: number;
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
          <p>Последние client events из log snapshots. Автообновление около 10 минут; service/background показан отдельно.</p>
        </div>
        <span className={`badge status-${payload.freshness_status === "fresh" ? "ok" : "warn"}`}>{mode}</span>
      </div>
      <div className="page-note">Последнее обновление: {shortDateTime(payload.generated_at)} · показано {Math.min((payload.events || []).length, 50)} из {payload.total_events || (payload.events || []).length}</div>
      <div className="live-feed">
        {[...(payload.events || []), ...(payload.route_decisions || [])].slice(0, 50).map((row, idx) => (
          <div className="live-feed-row" key={`${row.event_type || "decision"}-${row.event_id || row.id || idx}`}>
            <span>{shortDateTime(row.occurred_at || payload.generated_at)}</span>
            <strong>{row.event_type || "route.decision"}</strong>
            <small>{row.origin || row.client || row.client_ip || "System"} → {row.destinationLabel || row.destination || row.dns_qname || row.summary || "destination"}</small>
            <ChannelBadge value={row.channel} />
            <RouteBadge value={row.route || "Unknown"} />
          </div>
        ))}
      </div>
    </section>
  );
}

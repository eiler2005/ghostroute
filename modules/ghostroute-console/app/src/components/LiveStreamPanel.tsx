"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Pause, Play } from "lucide-react";
import { RouteBadge, shortDateTime, timeWithMillis } from "@/components/Widgets";

type LivePayload = {
  generated_at: string;
  freshness_status: string;
  events: Array<Record<string, any>>;
  total_events?: number;
  route_decisions: Array<Record<string, any>>;
  alerts: Array<Record<string, any>>;
};

export function LiveStreamPanel({
  initial,
  visibleCount = 150,
  streamHref = "/api/live/stream",
  children,
}: {
  initial: LivePayload;
  visibleCount?: number;
  streamHref?: string;
  children?: ReactNode;
}) {
  const [payload, setPayload] = useState(initial);
  const [mode, setMode] = useState("SSE connecting");
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  useEffect(() => {
    setPayload(initial);
  }, [initial]);

  useEffect(() => {
    const source = new EventSource(streamHref);
    source.addEventListener("snapshot", (event) => {
      if (!pausedRef.current) {
        setPayload(JSON.parse((event as MessageEvent).data));
      }
      setMode("SSE connected");
    });
    source.onerror = () => {
      setMode("SSE connecting");
    };
    return () => source.close();
  }, [streamHref]);

  const togglePaused = () => {
    setPaused((value) => {
      pausedRef.current = !value;
      return !value;
    });
  };

  const exportPayload = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ghostroute-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const rows = [...(payload.events || []), ...(payload.route_decisions || [])].slice(0, visibleCount);

  return (
    <section className="card live-stream-card">
      <div className="live-stream-toolbar">
        <div className="live-stream-title">
          <h2>Live event stream</h2>
          <span>Всего событий: {new Intl.NumberFormat("ru-RU").format(payload.total_events || (payload.events || []).length)}</span>
        </div>
        <div className="live-stream-actions">
          <span className={`badge sse-badge status-${mode.includes("connected") ? "ok" : "warn"}`}>{mode}</span>
          <button className="icon-button" type="button" onClick={togglePaused} title={paused ? "Продолжить live updates" : "Пауза live updates"} aria-label={paused ? "Продолжить live updates" : "Пауза live updates"}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button className="muted-button live-export-button" type="button" onClick={exportPayload}>
            <Download size={15} />
            <span>Экспорт</span>
          </button>
        </div>
      </div>
      <div className="live-stream-meta">Автообновление около 10 минут · последнее: {shortDateTime(payload.generated_at)} · показано {rows.length}</div>
      <div className="live-table-wrap">
        <table className="live-events-table">
          <thead>
            <tr>
              <th>Время</th>
              <th>Событие</th>
              <th>Маршрут / Назначение</th>
              <th>Клиент</th>
              <th>Канал / Route</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const eventType = row.event_type || "route.decision";
              const destination = row.destinationLabel || row.destination || row.dns_qname || row.summary || "destination";
              const origin = row.origin || row.source_log || "Router/sing-box";
              const client = row.client || row.client_label || row.client_ip || "not observed";
              const status = row.status || row.result || (String(row.route || "").toLowerCase() === "blocked" ? "Blocked" : "OK");
              const statusSlug = String(status).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
              return (
                <tr key={`${eventType}-${row.event_id || row.id || idx}`}>
                  <td className="live-col-time">{timeWithMillis(row.occurred_at || payload.generated_at)}</td>
                  <td className="live-col-event">
                    <span className={`event-dot event-${String(eventType).split(".")[0]}`} />
                    <strong>{eventType}</strong>
                  </td>
                  <td className="live-col-destination">
                    <span>{origin}</span>
                    <i>→</i>
                    <strong>{destination}</strong>
                  </td>
                  <td className="live-col-client">{client}</td>
                  <td className="live-col-route"><RouteBadge value={row.route || "Unknown"} /></td>
                  <td className={`live-col-status status-text-${statusSlug}`}>{status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {children ? <div className="live-card-footer">{children}</div> : null}
    </section>
  );
}

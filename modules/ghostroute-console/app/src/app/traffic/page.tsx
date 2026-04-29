import Link from "next/link";
import { ArrowLeft, Download, Share2 } from "lucide-react";
import { ConsoleShell } from "@/components/ConsoleShell";
import {
  bytes,
  ConfidenceBadge,
  EmptyState,
  RawEvidence,
  RouteBadge,
  routeFromBytes,
} from "@/components/Widgets";
import { buildConsoleModel } from "@/lib/server/selectors";
import { filtersFromSearchParams, type SearchParams } from "@/lib/server/page";

function scalar(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function lower(value: unknown) {
  return String(value || "").toLowerCase();
}

function matchesDestination(row: Record<string, any>, destination: string) {
  const domain = lower(row.domain || row.qname || row.query || row.destination || row.family);
  const needle = lower(destination);
  if (!needle || !domain) return false;
  return domain.includes(needle) || needle.includes(domain);
}

function routeSteps(route: string) {
  const direct = route === "Direct";
  const mixed = route === "Mixed";
  return [
    ["Client", "Запрос от устройства"],
    ["Router", "Пакеты вошли на роутер"],
    ["dnsmasq + ipset", "DNS/rule evidence"],
    ["sing-box", "Классификация outbound"],
    [direct ? "Direct" : mixed ? "mixed-out" : "reality-out", direct ? "Локальный выход" : mixed ? "Смешанный маршрут" : "Reality handshake"],
    [direct ? "Internet" : "VPS", direct ? "Доставка напрямую" : "Выход с VPS"],
    ...(!direct ? [["Internet", "Доставка до сайта"]] : []),
  ];
}

function firstValue(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "") || "unknown";
}

function Timeline({ selected, dns, catalog, route }: { selected: Record<string, any>; dns: Record<string, any>[]; catalog: Record<string, any>[]; route: string }) {
  const ts = String(firstValue(selected.raw?.ts, selected.raw?.timestamp, selected.collected_at, "latest snapshot"));
  const rows = [
    ["DNS query", dns[0]?.domain || dns[0]?.qname || selected.destination || "no DNS evidence"],
    ["Catalog/rule", catalog[0]?.domain || catalog[0]?.type || "no catalog match"],
    ["Decision", route],
    ["Traffic", bytes(selected.bytes || selected.total_bytes || selected.via_vps_bytes || selected.direct_bytes || 0)],
  ];
  return (
    <div className="timeline">
      {rows.map(([label, value], idx) => (
        <div className="timeline-row" key={label}>
          <span>{idx + 1}</span>
          <div>
            <strong>{label}</strong>
            <small>{idx === 0 ? ts : value}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteDiagram({ route }: { route: string }) {
  return (
    <div className="route-diagram">
      {routeSteps(route).map(([label, detail], idx) => (
        <div className="route-node-wrap" key={`${label}-${idx}`}>
          <div className="route-index">{idx + 1}</div>
          <div className="route-node">
            <strong>{label}</strong>
          </div>
          <small>{detail}</small>
          {idx < routeSteps(route).length - 1 ? <div className="route-line" /> : null}
        </div>
      ))}
    </div>
  );
}

function CompactRouteExample({ flow }: { flow?: Record<string, any> }) {
  if (!flow) return null;
  const route = flow.route || routeFromBytes(flow);
  return (
    <section className="route-example">
      <h3>Ещё один пример: почему {flow.destination || flow.family || "destination"} ушёл {route}</h3>
      <RouteDiagram route={route} />
      <div className="result-strip">
        Итог: traffic to {flow.destination || flow.family || "n/a"} routed as <RouteBadge value={route} />.
        Confidence: {flow.confidence || "unknown"}.
      </div>
    </section>
  );
}

export default async function TrafficPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ? await searchParams : {};
  const filters = await filtersFromSearchParams(Promise.resolve(params));
  const model = buildConsoleModel(filters);
  const selectedIndex = Math.min(
    Math.max(Number.parseInt(scalar(params.flow) || "0", 10) || 0, 0),
    Math.max(model.flows.length - 1, 0)
  );
  const selected = model.flows[selectedIndex];
  const route = selected ? selected.route || routeFromBytes(selected) : "Unknown";
  const destination = String(selected?.destination || selected?.family || "");
  const dnsMatches = selected ? model.dnsQueries.filter((row) => matchesDestination(row, destination)).slice(0, 4) : [];
  const catalogMatches = selected ? model.catalog.filter((row) => matchesDestination(row, destination)).slice(0, 4) : [];
  const directExample = model.flows.find((row, idx) => idx !== selectedIndex && (row.route || routeFromBytes(row)) === "Direct");
  const egressIp = String(firstValue(selected?.raw?.egress_ip, selected?.raw?.exit_ip, selected?.raw?.visible_ip, selected?.raw?.ip));
  const protocol = String(firstValue(selected?.protocol, selected?.raw?.protocol, selected?.raw?.proto));
  const catalogRule = catalogMatches[0];

  return (
    <ConsoleShell active="/traffic" model={model} filters={filters}>
      {!selected ? (
        <section className="card">
          <EmptyState title="Нет выбранного flow" />
        </section>
      ) : (
        <div className="route-layout">
          <section className="route-main">
            <div className="route-breadcrumbs">
              <Link href="/traffic"><ArrowLeft size={16} /> Traffic Explorer</Link>
              <span>/</span>
              <Link href={`/clients?client=${encodeURIComponent(selected.client || selected.channel || "")}`}>
                {selected.client || selected.channel || "client"}
              </Link>
              <span>/</span>
              <strong>{destination || "destination"}</strong>
            </div>
            <div className="toolbar">
              <div>
                <h2>Почему маршрут именно такой?</h2>
                <p>Разбираем выбранный destination на основе собранных factual evidence.</p>
              </div>
              <div className="button-row">
                <button className="muted-button" disabled><Download size={15} /> Экспорт отчёта</button>
                <button className="muted-button primary" disabled><Share2 size={15} /> Поделиться</button>
              </div>
            </div>

            <section className="route-card">
              <div className="panel-title">
                <h3>Маршрут для {destination || "unknown destination"}</h3>
                <RouteBadge value={route} />
              </div>
              <RouteDiagram route={route} />
              <div className="result-strip">
                Итог: traffic to {destination || "n/a"} routed as <RouteBadge value={route} />.
                Confidence: <ConfidenceBadge value={selected.confidence} />.
              </div>
              <div className="evidence-grid">
                <div className="evidence-card">
                  <span>Запрос DNS</span>
                  <strong>{dnsMatches[0]?.domain || destination || "unknown"}</strong>
                  <small>{dnsMatches[0] ? `${dnsMatches[0].qtype || "A"} · ${dnsMatches[0].count || 1} seen` : "no DNS evidence"}</small>
                </div>
                <div className="evidence-card">
                  <span>Совпавшее правило</span>
                  <strong>{catalogRule?.type || catalogRule?.source || "no catalog match"}</strong>
                  <small>{catalogRule?.domain || "catalog evidence not present"}</small>
                </div>
                <div className="evidence-card">
                  <span>Соединение</span>
                  <strong>{protocol}</strong>
                  <small>{selected.connections || 0} connections</small>
                </div>
                <div className="evidence-card">
                  <span>Принятое решение</span>
                  <strong><RouteBadge value={route} /></strong>
                  <small>{route === "VPS" ? "Route via reality-out" : route === "Direct" ? "Direct allowed" : "Derived from counters"}</small>
                </div>
                <div className="evidence-card">
                  <span>Передано</span>
                  <strong>{bytes(selected.bytes || selected.total_bytes || selected.via_vps_bytes || selected.direct_bytes || 0)}</strong>
                  <small>{selected.raw?.direction || "snapshot counters"}</small>
                </div>
                <div className="evidence-card">
                  <span>Выходной IP</span>
                  <strong>{egressIp}</strong>
                  <small>{route === "VPS" ? "visible as VPS when known" : "local/direct when known"}</small>
                </div>
                <div className="evidence-card evidence-confidence">
                  <span>Уверенность</span>
                  <strong>{selected.confidence || "unknown"}</strong>
                  <small>Never promoted above source evidence</small>
                </div>
              </div>
            </section>

            <CompactRouteExample flow={directExample} />

            <section className="card">
              <div className="toolbar">
                <h2>Flow table</h2>
                <span className="subtle">{model.flows.length} factual rows</span>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th className="col-client">Client</th>
                    <th className="col-destination">Destination</th>
                    <th className="col-route">Route</th>
                    <th className="col-traffic">Traffic</th>
                    <th className="col-conn">Conn</th>
                    <th className="col-confidence">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {model.flows.slice(0, 100).map((row, idx) => {
                    const rowRoute = row.route || routeFromBytes(row);
                    return (
                      <tr key={idx} className={idx === selectedIndex ? "selected" : ""}>
                        <td><Link href={`/traffic?flow=${idx}`}>{row.client || row.channel || "n/a"}</Link></td>
                        <td><Link href={`/traffic?flow=${idx}`}>{row.destination || row.family || "n/a"}</Link></td>
                        <td><RouteBadge value={rowRoute} /></td>
                        <td>{bytes(row.bytes || row.total_bytes || row.via_vps_bytes || row.direct_bytes || 0)}</td>
                        <td>{row.connections || 0}</td>
                        <td><ConfidenceBadge value={row.confidence} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </section>

          <aside className="side-panel route-rail">
            <section className="card">
              <h3>Что видит сайт</h3>
              <div className="detail-list">
                <div className="detail-row"><span>Destination</span><strong>{destination || "unknown"}</strong></div>
                <div className="detail-row"><span>Visitor IP</span><strong>{egressIp}</strong></div>
                <div className="detail-row"><span>Protocol</span><strong>{protocol}</strong></div>
                <div className="detail-row"><span>SNI</span><strong>{destination.includes(".") ? destination : "unknown"}</strong></div>
              </div>
            </section>
            <section className="card">
              <h3>Что видит оператор</h3>
              <div className="detail-list">
                <div className="detail-row"><span>Input</span><strong>{selected.client || selected.channel || "unknown"}</strong></div>
                <div className="detail-row"><span>Output</span><strong><RouteBadge value={route} /></strong></div>
                <div className="detail-row"><span>Rule</span><strong>{catalogRule?.type || "unknown"}</strong></div>
                <div className="detail-row"><span>Confidence</span><strong>{selected.confidence || "unknown"}</strong></div>
              </div>
            </section>
            <section className="card info-card">
              <h3>Об IP и логике</h3>
              <p>
                Home-first policy: locally allowed traffic goes direct. Otherwise factual counters and rule evidence
                explain whether traffic used the reliable VPS path.
              </p>
            </section>
            <section className="card">
              <h3>Хронология событий</h3>
              <Timeline selected={selected} dns={dnsMatches} catalog={catalogMatches} route={route} />
            </section>
            <section className="card">
              <RawEvidence value={{ flow: selected, dns: dnsMatches, catalog: catalogMatches }} />
            </section>
          </aside>
        </div>
      )}
    </ConsoleShell>
  );
}

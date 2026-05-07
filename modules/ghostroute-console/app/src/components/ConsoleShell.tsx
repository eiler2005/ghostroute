import { Activity, BarChart3, Boxes, Gauge, Home, Radio, Search, Settings, ShieldCheck, SlidersHorizontal, Users, Wifi } from "lucide-react";
import { shortDateTime } from "@/components/Widgets";
import { filterOptions } from "@/lib/server/selectors/shell";
import type { ConsoleFilters, ConsoleModel } from "@/lib/server/types";

const nav = [
  ["Dashboard", "/", Home],
  ["Flow Explorer", "/traffic", Search],
  ["DNS Query Log", "/dns", Wifi],
  ["Clients", "/clients", Users],
  ["Health Center", "/health", ShieldCheck],
  ["Catalog", "/catalog", Boxes],
  ["Budget", "/budget", Gauge],
  ["Live", "/live", Radio],
  ["Reports", "/reports", BarChart3],
  ["Settings", "/settings", Settings],
] as const;

export function ConsoleShell({
  active,
  model,
  filters,
  children,
}: {
  active: string;
  model: ConsoleModel;
  filters: ConsoleFilters;
  children: React.ReactNode;
}) {
  const options = filterOptions(model);
  const freshnessLabel =
    model.freshnessMinutes === null
      ? "snapshots: n/a"
      : model.freshnessMinutes === 0
        ? "fresh now"
        : `${model.freshnessMinutes}m ago`;
  const freshnessTitle = [
    model.freshnessLabel ? `last ${shortDateTime(model.freshnessLabel)}` : "",
    model.nextExpectedCollection ? `next ${shortDateTime(model.nextExpectedCollection)}` : "",
    model.staleThresholdMinutes ? `stale>${model.staleThresholdMinutes}m` : "",
  ].filter(Boolean).join(" · ");
  const latestTraffic = model.runtime.latestSnapshots.traffic ? shortDateTime(model.runtime.latestSnapshots.traffic) : "n/a";
  const latestSummary = model.runtime.latestSnapshots.traffic_summary ? shortDateTime(model.runtime.latestSnapshots.traffic_summary) : "n/a";
  const buildLabel = model.runtime.buildAt ? `${model.runtime.buildCommit} · ${shortDateTime(model.runtime.buildAt)}` : model.runtime.buildCommit;
  const sourceTitle = [
    `data: ${model.runtime.dataDirLabel}`,
    `repo: ${model.runtime.repoRootLabel}`,
    `env: ${model.runtime.nodeEnv}`,
    model.runtime.buildAt ? `build: ${model.runtime.buildAt}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="ghost">GR</div>
          <div>
            <strong>GhostRoute</strong>
            <span>Console</span>
          </div>
        </div>
        <nav>
          {nav.map(([label, href, Icon]) => (
            <a className={active === href ? "nav active" : "nav"} href={href} key={href}>
              <Icon size={18} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="system-pill">
          <Activity size={16} />
          <div>
            <strong>System healthy</strong>
            <span>{model.alerts.length === 0 ? "No active warnings" : `${model.alerts.length} warnings`}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>GhostRoute Console</h1>
            <p>Factual read-only monitoring for routes, clients, and system health</p>
          </div>
          <form className="filters">
            <span className={`freshness freshness-${model.freshnessStatus}`}>
              {model.freshnessStatus}
              <small title={freshnessTitle}>{freshnessLabel}</small>
            </span>
            <select name="period" defaultValue={filters.period || "today"}>
              <option value="today">Today</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
            <select name="route" defaultValue={filters.route || "all"}>
              <option value="all">All routes</option>
              {options.routes.map((route) => (
                <option value={route} key={route}>
                  {route}
                </option>
              ))}
            </select>
            <select name="channel" defaultValue={filters.channel || "all"}>
              <option value="all">All channels</option>
              {options.channels.map((channel) => (
                <option value={channel} key={channel}>
                  {channel}
                </option>
              ))}
            </select>
            <select name="confidence" defaultValue={filters.confidence || "all"}>
              <option value="all">Any confidence</option>
              {options.confidences.map((confidence) => (
                <option value={confidence} key={confidence}>
                  {confidence}
                </option>
              ))}
            </select>
            <select name="trafficClass" defaultValue={filters.trafficClass || "all"}>
              {options.trafficClasses.map((item) => (
                <option value={item.value} key={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <input name="search" defaultValue={filters.search || ""} placeholder="Search..." />
            <button type="submit"><span>Filters</span><SlidersHorizontal size={15} /></button>
          </form>
        </header>
        <div className="source-strip" title={sourceTitle}>
          <span>{model.runtime.sourceLabel}</span>
          <span>build {buildLabel}</span>
          <span>traffic {latestTraffic}</span>
          <span>summary {latestSummary}</span>
        </div>
        {children}
      </main>
    </div>
  );
}

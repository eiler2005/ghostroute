import Link from "next/link";
import { Activity, BarChart3, Boxes, Gauge, Home, Radio, Search, Settings, ShieldCheck, Users } from "lucide-react";
import { filterOptions } from "@/lib/server/selectors";
import type { ConsoleFilters, ConsoleModel } from "@/lib/server/types";

const nav = [
  ["Dashboard", "/", Home],
  ["Traffic Explorer", "/traffic", Search],
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
            <Link className={active === href ? "nav active" : "nav"} href={href} key={href}>
              <Icon size={18} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="system-pill">
          <Activity size={16} />
          <div>
            <strong>Система здорова</strong>
            <span>{model.alerts.length === 0 ? "Нет активных предупреждений" : `${model.alerts.length} предупреждений`}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <h1>GhostRoute Console</h1>
            <p>Фактический read-only мониторинг маршрутов, клиентов и здоровья системы</p>
          </div>
          <form className="filters">
            <span className={`freshness freshness-${model.freshnessStatus}`}>
              {model.freshnessStatus}
              <small>{freshnessLabel}</small>
            </span>
            <select name="period" defaultValue={filters.period || "today"}>
              <option value="today">Сегодня</option>
              <option value="week">Неделя</option>
              <option value="month">Месяц</option>
            </select>
            <select name="route" defaultValue={filters.route || "all"}>
              <option value="all">Все маршруты</option>
              {options.routes.map((route) => (
                <option value={route} key={route}>
                  {route}
                </option>
              ))}
            </select>
            <select name="channel" defaultValue={filters.channel || "all"}>
              <option value="all">Все каналы</option>
              {options.channels.map((channel) => (
                <option value={channel} key={channel}>
                  {channel}
                </option>
              ))}
            </select>
            <select name="confidence" defaultValue={filters.confidence || "all"}>
              <option value="all">Любая уверенность</option>
              {options.confidences.map((confidence) => (
                <option value={confidence} key={confidence}>
                  {confidence}
                </option>
              ))}
            </select>
            <input name="search" defaultValue={filters.search || ""} placeholder="Поиск..." />
            <button type="submit">Фильтр</button>
          </form>
        </header>
        {children}
      </main>
    </div>
  );
}

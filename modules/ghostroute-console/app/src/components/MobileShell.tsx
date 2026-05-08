import { shortDateTime } from "@/components/Widgets";
import type { ConsoleFilters, ConsoleModel } from "@/lib/server/types";

const nav = [
  ["Home", "/m"],
  ["Flows", "/m/traffic"],
  ["DNS", "/m/dns"],
  ["Clients", "/m/clients"],
  ["Live", "/m/live"],
  ["Catalog", "/m/catalog"],
] as const;

function withDesktopBypass(path: string) {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("desktop", "1");
  const suffix = params.toString();
  return suffix ? `${base}?${suffix}` : base;
}

export function mobileDesktopHref(path: string) {
  if (path === "/m") return withDesktopBypass("/");
  if (path.startsWith("/m/")) return withDesktopBypass(path.slice(2) || "/");
  return withDesktopBypass(path);
}

export function MobileShell({
  active,
  model,
  filters,
  desktopPath,
  children,
}: {
  active: string;
  model: ConsoleModel;
  filters: ConsoleFilters;
  desktopPath: string;
  children: React.ReactNode;
}) {
  const freshnessLabel =
    model.freshnessMinutes === null
      ? "snapshots n/a"
      : model.freshnessMinutes === 0
        ? "fresh now"
        : `${model.freshnessMinutes}m ago`;
  return (
    <main className="mobile-shell">
      <header className="mobile-header">
        <div>
          <strong>GhostRoute Console</strong>
          <span>Mobile</span>
        </div>
        <a href={mobileDesktopHref(desktopPath)}>Desktop version</a>
      </header>

      <nav className="mobile-nav" aria-label="Mobile Console navigation">
        {nav.map(([label, href]) => (
          <a className={active === href ? "active" : ""} href={href} key={href}>{label}</a>
        ))}
      </nav>

      <section className="mobile-status">
        <div>
          <span>Freshness</span>
          <strong className={`mobile-freshness mobile-freshness-${model.freshnessStatus}`}>{freshnessLabel}</strong>
        </div>
        <div>
          <span>Traffic</span>
          <strong>{model.runtime.latestSnapshots.traffic ? shortDateTime(model.runtime.latestSnapshots.traffic) : "n/a"}</strong>
        </div>
        <div>
          <span>Build</span>
          <strong>{model.runtime.buildCommit}</strong>
        </div>
      </section>

      <form className="mobile-filter" action={active}>
        <input name="search" defaultValue={filters.search || ""} placeholder="Search" />
        <button type="submit">Go</button>
      </form>

      {children}
    </main>
  );
}

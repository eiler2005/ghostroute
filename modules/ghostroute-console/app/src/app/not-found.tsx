import Link from "next/link";

export default function NotFound() {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">GhostRoute Console</p>
        <h1>Console route not found</h1>
        <p className="muted">This path is not part of the current read-only Console surface.</p>
        <Link className="primary-button" href="/">
          Open Dashboard
        </Link>
      </section>
    </main>
  );
}

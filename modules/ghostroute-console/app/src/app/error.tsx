"use client";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="app-shell">
      <section className="hero-panel">
        <p className="eyebrow">GhostRoute Console</p>
        <h1>Console view failed to render</h1>
        <p className="muted">{error.message || "A server render error interrupted this view."}</p>
        {error.digest ? <p className="muted">Digest: {error.digest}</p> : null}
        <button className="primary-button" onClick={() => reset()} type="button">
          Retry
        </button>
      </section>
    </main>
  );
}

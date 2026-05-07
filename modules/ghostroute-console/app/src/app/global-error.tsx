"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ru">
      <body>
        <main className="app-shell">
          <section className="hero-panel">
            <p className="eyebrow">GhostRoute Console</p>
            <h1>Console shell failed to load</h1>
            <p className="muted">{error.message || "A top-level application error interrupted the Console shell."}</p>
            {error.digest ? <p className="muted">Digest: {error.digest}</p> : null}
            <button className="primary-button" onClick={() => reset()} type="button">
              Retry
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}

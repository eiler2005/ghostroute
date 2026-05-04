# GhostRoute Console Observability V2 AI Review

This review records the design risks found before implementation and the
required corrections. It is intentionally written as an implementation guardrail.

## Review Findings

### 1. Risk: UI could become a second source of truth

Console must not decide routing policy. It may display and correlate evidence
from `traffic-report`, `dns-forensics-report`, `domain-report`, health reports
and live log tails.

Correction:

- Keep all write-like catalog behavior as review/dry-run/apply-preparation
  only.
- Keep route explanations evidence-driven. If a source does not prove a field,
  show `not observed`.

### 2. Risk: Flow Explorer can overclaim session precision

Some reports expose exact LAN bytes, while Home Reality destination bytes are
estimated from connection share. Channel B/C destination bytes may be
connection-only.

Correction:

- Store `bytes_confidence`, `duration_confidence` and row `confidence`.
- Label `dns-interest` rows separately from byte-carrying flows.
- Do not call estimated aggregates billing-grade sessions.

### 3. Risk: Read models can drift from raw evidence

Materialized tables improve performance, but they can become stale after new
snapshots, registry edits or schema changes.

Correction:

- Track source snapshot version and registry version in `read_model_state`.
- Rebuild read models from raw snapshots and v4 normalized rows.
- Keep raw snapshots and v4 tables as the fallback evidence layer.

### 4. Risk: Live mode can overload router or VPS

The desired troubleshooting UI needs lower latency than the current ten-minute
UI refresh, but continuous tails are risky.

Correction:

- Use cursor polling with bounded `--limit`.
- Default production polling can be 15 seconds only for Console live events,
  with short raw retention.
- Keep collector timeout and lock files.

### 5. Risk: Alarm Center can duplicate notification state

There are already `normalized_alerts` and `notifications`.

Correction:

- `alarm_events` becomes the display read model.
- `notifications` remains action/delivery/audit state.
- Ack/snooze updates status without deleting evidence.

### 6. Risk: Privacy screens could leak real operator data

Screens and exports may show client names, private IPs, domains or QR/VLESS
payloads.

Correction:

- Add redaction utilities for display/export.
- Never include secrets in tracked docs or tests.
- Keep generated profiles, Vault values and local runtime data out of public
  docs.

### 7. Risk: UI can become too card-heavy or slow

The target experience is operational, dense and scannable.

Correction:

- Use cards only for repeated items, side panels and tool surfaces.
- Keep tables paginated.
- Use read-model queries for first render.
- Keep Playwright performance budgets.

## Review Decision

Proceed with an additive SQLite v5/read-model implementation, then rebuild UI
screens on top of those APIs. Do not alter router/VPS routing or production
catalog deployment behavior in this feature.


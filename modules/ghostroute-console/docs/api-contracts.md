# GhostRoute Console — API Contracts

Reference for the Console's internal HTTP API (Next.js route handlers under
[app/src/app/api/](../app/src/app/api/)). Every handler returns JSON via
`NextResponse.json(...)`. The API is split into two kinds of endpoint:

- **Read endpoints (`GET`)** serve already-prepared, sanitized data from the
  local SQLite store (see [database-schema.md](database-schema.md)). They do not
  touch routing state.
- **Action endpoints (`POST`)** perform operator-initiated catalog/ops/alarm
  actions and are audited (`audit_log`). They are guarded per the
  [operator-runbook.md](operator-runbook.md); they remain within the Console's
  documented authority and never mutate router/VPS runtime directly.

Parameters listed are the query-string keys each handler reads via
`searchParams.get(...)`; handlers without listed params take none. Dynamic path
segments use `[id]`. This table is the contract surface; per-field response
shapes live next to each `route.ts`.

## Read endpoints (GET)

| Path | Params | Purpose |
|---|---|---|
| `/api/dashboard` | `period`, `channel`, `client`, `route`, `trafficClass`, `confidence`, `search`, `fresh` | Primary dashboard payload: filtered traffic/client/route view for the selected window. |
| `/api/clients` | — | Client inventory and per-client summary. |
| `/api/catalog` | — | Managed-domain catalog view. |
| `/api/dns` | — | DNS activity view. |
| `/api/flows` | — | Flow/session view. |
| `/api/health` | — | Router/VPS health snapshot. |
| `/api/system` | — | System/runtime status summary. |
| `/api/budget` | — | Traffic budget / quota view. |
| `/api/audit` | — | Operator action audit log. |
| `/api/alarms` | — | Current alarms list. |
| `/api/notifications` | — | Notifications list. |
| `/api/notifications/settings` | — | Current notification settings. |
| `/api/filters/rules` | `limit`, `offset` | Paginated filter-rule definitions. |
| `/api/filters/decisions` | `limit`, `offset` | Paginated filter decision records. |
| `/api/settings` | — | Console settings. |
| `/api/live` | — | Latest live cursor/state for the live view. |
| `/api/live/stream` | — | Streaming live updates (server-sent stream). |
| `/api/reports/llm-safe` | `format` | Sanitized, LLM-safe report export. |
| `/api/routes/[id]/export` | `format` | Export a single route's evidence. |

## Action endpoints (POST)

| Path | Purpose |
|---|---|
| `/api/actions/catalog/dry-run` | Preview a catalog change without applying it. |
| `/api/actions/catalog/review` | Record a catalog review decision. |
| `/api/actions/catalog/apply` | Apply a reviewed catalog change. |
| `/api/actions/catalog/rollback` | Roll back a previously applied catalog change. |
| `/api/actions/ops` | Run a guarded operational action. |
| `/api/alarms/[id]/open` | Open/raise an alarm. |
| `/api/alarms/[id]/ack` | Acknowledge an alarm. |
| `/api/alarms/[id]/snooze` | Snooze an alarm. |
| `/api/notifications/[id]/ack` | Acknowledge a notification. |
| `/api/notifications/[id]/snooze` | Snooze a notification. |
| `/api/notifications/settings` | Update notification settings (also serves `GET`). |
| `/api/notifications/test` | Send a test notification. |

## Related

- [database-schema.md](database-schema.md) — tables these endpoints read.
- [operator-runbook.md](operator-runbook.md) — operator action guardrails.
- [ghostroute-console-architecture.md](../../../docs/ghostroute-console-architecture.md) — Console trust model and data flow.

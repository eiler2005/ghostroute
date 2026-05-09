# GhostRoute Console Data Pyramid

GhostRoute Console must not rebuild a data warehouse during deploy, restart or
ordinary UI navigation. Large raw tables are troubleshooting input, not the
steady-state read path. The steady-state path is a prepared aggregate pyramid
with small watermarked chunks.

## Goals

- Keep client traffic accounting correct while avoiding request-time raw scans.
- Make deploy/startup fast: verify existing chunks, catch up only missing gaps,
  and leave large repair work to background jobs.
- Keep `today`, `week` and `month` filters available from prepared data.
- Bound disk use: raw rows are short-lived; aggregates carry the UI history.
- Prefer client traffic. Service/background evidence is retained only as much as
  needed for diagnostics and attribution gaps.

## Layers

```text
raw snapshots / normalized rows
  -> short troubleshooting retention
  -> source for new or repaired chunks only

client_traffic_5min / dns_log_5min
  -> fine current-day chunks
  -> short retention, enough for late/current corrections

client_traffic_hourly
  -> current-day and recent-day hourly chunks
  -> built from 5-minute chunks

client_traffic_daily
  -> week/month daily chunks
  -> built from hourly chunks

traffic_window_snapshots
  -> small prepared payloads for today/week/month
  -> Dashboard, Clients, DNS/report APIs read these first
```

Weekly/monthly aggregate tables are optional future layers. Daily chunks are
small enough for the current one-month UI window; add weekly/monthly tables only
when production measurements show daily scans becoming expensive.

## Window Planning

Prepared windows should be composed from the coarsest accurate chunks:

- `today`: the latest 1-2 hours from 5-minute chunks, earlier current-day hours
  from hourly chunks.
- `week`: the `today` plan for the current day, previous days from daily chunks.
- `month`: the `today` plan for the current day, previous days from daily
  chunks; future weekly chunks may replace older daily ranges.

The UI and API must not fall back to `normalized_flows`, `normalized_dns`,
`events` or raw snapshot payloads for `week`/`month`. If a prepared window is
missing, render a bounded fallback and let the collector repair it.

## Collector Contract

Normal collection has two separate jobs:

- Incremental rollup: read new normalized rows since the last watermark plus a
  small dirty overlap, update 5-minute chunks, roll them into hourly/daily
  chunks, and rewrite the small prepared windows.
- Backfill/repair: rebuild missing or suspect historical chunks in the
  background. Deploy/startup should not wait for a full historical repair.

The steady-state dirty overlap is bounded to the current Moscow day and a small
recent window (`GHOSTROUTE_ROLLUP_REBUILD_HOURS`, default 6h). This is a
correction window, not the main source for historical `week`/`month` data.

Each aggregate layer should eventually have explicit watermarks, for example:

```text
aggregate_state(model, window_key, source_snapshot_id, built_until_utc, status)
```

Deploy/startup should check those watermarks, catch up small gaps, and keep
serving the last good prepared snapshot while a large backfill runs separately.

## Night Mode

During 23:00-06:00 Moscow time, collection windows intentionally widen:

- full traffic collection: every 3 hours by default;
- lightweight traffic summaries: every 30 minutes by default;
- live polling: every 30 minutes by default.

This reduces VPS/router/SQLite pressure when operator freshness requirements are
lower. It does not change chunk semantics: already collected traffic remains in
the same 5-minute/hourly/daily pyramid.

## Retention

Default retention should preserve the one-month UI window without keeping
unbounded raw data:

- raw normalized client rows: about 7 days;
- service/background raw rows: shorter diagnostic retention;
- 5-minute traffic chunks: about 8 days;
- hourly/daily traffic chunks and DNS aggregates: about 35 days;
- heavy raw `traffic`, `dns` and `live` snapshot payloads: short
  troubleshooting window once newer payloads exist.

Retention must prune oldest layers after prepared aggregates exist, not before.

## Rollback

`GHOSTROUTE_CONSOLE_USE_PREPARED_WINDOWS=0` is a diagnostic compatibility switch.
It must not become the production path for large databases, because it allows
request paths to revisit heavier selectors.

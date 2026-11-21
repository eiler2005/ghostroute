# Traffic Observatory Module Overview

LAN route-counter deltas carry explicit interval bounds and are emitted as
volume facts independently of sampled connection detail. A covered connection
sample is detail evidence and must not be added to its owning volume interval.
This preserves total usage when app/destination observation is incomplete.
Encrypted or unobserved app attribution remains unknown; DNS query volume must
not manufacture transferred app bytes. These additive fields keep the
`traffic-facts` schema-v3 interface compatible with existing consumers.
Both legacy nine-field LAN counter rows and rows extended with MAC/hostname
metadata are accepted. Optional identity metadata must not remove counter bytes.

## Purpose

Traffic Observatory provides day-to-day usage and routing reports for WAN,
LAN/Wi-Fi, Home Reality QR clients, popular destinations and split-routing
mistakes.

## Features

- Current-day and historical traffic reports.
- LAN/Wi-Fi device counters with redacted labels by default.
- Home Reality QR client accounting for remote iPhone/Mac clients.
- Routing mistake hints for managed domains and direct/VPS exits.

## How It Works

Accounting maintenance owners refresh mangle counters; read-only collector
scripts snapshot the existing byte totals without invoking those owners.
Control-machine reports pull those counters through the shared router SSH helper,
combine them with local metadata and render safe Markdown/text output for humans
and LLM handoff.

For Console accounting, the router also writes a bounded bottom layer of LAN
flow, DNS and edge-rollup evidence. `lan-flow-facts-snapshot` samples conntrack
byte deltas as `client_ip -> destination_ip -> route -> bytes` with append-only
v2 route-evidence columns, `dns-query-snapshot` records best-effort dnsmasq
query/answer evidence, `lan-device-counters.tsv` supplies per-client
VPN/WAN/other counter deltas, and `traffic-rollup-snapshot` builds portable
`5min/hourly/daily/weekly/monthly` chunks under the traffic state directory.
`sing-box-route-evidence-snapshot` is an optional read-only tail of sing-box
outbound lines for route proof/mismatch diagnostics. All jobs are asynchronous,
guarded by lock/load/row limits, and do not change Channels A/B/C, managed
domains, iptables routing rules or sing-box policy. The VPS/Console remains the
warehouse/read-model layer and imports router rollups as preferred totals.

## Architecture

- `bin/` contains local reporting commands.
- `router/` contains ASUS Merlin runtime collectors.
- `lib/traffic_measurements.rb` owns common counter increments, byte partitions,
  volume-fact construction, measurement kinds and per-channel coverage. LAN,
  Home Reality and isolated-channel sources are adapters to this shared core,
  rather than separate accounting implementations.
- Shared parsing and redaction helpers live in `modules/shared/lib`.

The router keeps protocol-specific readers: conntrack and device counters for
LAN/Wi-Fi, encrypted ingress counters for Home Reality, named statistics/peer
counters for isolated engines and completed CONNECT streams for Channel D.
Their different visibility is preserved. B/C/M without independent byte evidence
remain `not_observed`; neither another channel's counters nor connection counts
can fill that gap. Inactive labs are never started for monitoring.

## Read-only / Mutating Contract

Readers observe existing counters/logs and write only their evidence state.
`cron-traffic-evidence` runs the flow, DNS and route-log readers every five minutes,
separately from the six-hour maintenance job. It never refreshes firewall rules.
Kernel byte visibility (`nf_conntrack_acct`) is provisioned by the explicit
`lan-traffic-accounting-refresh` owner, which saves the prior value; the sampler
reports `accounting_disabled` rather than changing it. The rollback helper remains
available for operator-directed restoration.

DNS collection uses an inode/offset/prefix cursor: repeated polls do not duplicate
queries, rotation/truncation resets the cursor, incomplete lines wait for completion
and bounded backlog is reported. Parsed log timestamps are retained across midnight;
unknown log formats remain explicitly approximate. Conntrack polling is still partial:
connections completed between polls and hardware-offloaded bytes may be absent.
An unobserved destination cannot be reconstructed from client totals or DNS popularity.

The five-minute interval balances bounded detail collection with router CPU and
storage activity. Readers append only new evidence; quiet route-log polls do not
rewrite the retained TSV. The shared `traffic-evidence-lib` compacts histories
hourly to 50,000 rows, or earlier at a 60,000-row safety ceiling (20% headroom).
Those limits apply independently to each history, not to total device traffic.
Compaction removes only old records; retained timestamps and byte values are unchanged.
Storage occupied and bytes written are separate measures: an append/compaction
budget does not imply that the drive fills by that amount every day.
The polling interval is independent of byte-counter ownership and the Console
ingestion interval. Before shortening it, measure successful (not locked or
load-skipped) sampler runs: elapsed time, child CPU time, available memory and
storage writes. Average whole-router CPU share is `cpu_seconds / (interval_seconds
* cpu_count)`; elapsed duty is `elapsed_seconds / interval_seconds`. File-size growth
is not bytes written: retained TSV histories can be rewritten even without growth.
Use repeated observations under ordinary and peak traffic; do not infer throughput
impact from load average alone or change routing to benchmark an observer.

Run collection checks with `./tests/run-traffic.sh --collection`. Console data and
GUI checks are separate gates described in [tests](../../tests/README.md#traffic-layer-gates).

## Public Commands

- `./modules/traffic-observatory/bin/traffic-report`
- `./modules/traffic-observatory/bin/traffic-report check`
- `./modules/traffic-observatory/bin/traffic-evidence --json today`
- `./modules/traffic-observatory/bin/traffic-facts --json today`
- `./modules/traffic-observatory/bin/traffic-summary --json today`
- `./modules/traffic-observatory/bin/traffic-summary --json recent --hours 2`
- `./modules/traffic-observatory/bin/traffic-rollup-export --json today`
- `./modules/traffic-observatory/bin/traffic-report today`
- `./modules/traffic-observatory/bin/traffic-report channel-c`
- `./modules/traffic-observatory/bin/traffic-report yesterday`
- `./modules/traffic-observatory/bin/traffic-report week`
- `./modules/traffic-observatory/bin/traffic-daily-report`

`traffic-facts --json` is the machine contract (`schema_version: 3`) consumed by
Console. It reads `traffic-evidence --json` by default; `traffic-report` remains
operator/debug output and a rollback source only.

`traffic-evidence --json <period>` applies explicit UTC window bounds for
`today`, `yesterday`, `week`, `month` and `YYYY-MM-DD` before facts are built, so
retained router tails do not leak old rows into current accounting. Evidence
mode includes current LAN and Home Reality counter snapshots in a temporary state
copy for live `today`/`week`/`month` windows, keeping the source router files
read-only while matching `traffic-summary` freshness.
LAN counter decreases mark a coverage gap and contribute only non-negative
observed increments, using the same reset semantics as the summary. Live
counter observations extend the latest historical interval; Console replaces
contained partial intervals with their later owning interval rather than adding
the cumulative observations together. Historical windows never append live data.
Evidence is conservative: route/ipset matches are policy intent until real egress
or outbound evidence exists. Per-client route counters prove their own total
split; they do not assign that split to sampled destinations. Ingress
connection/outbound counts prove neither per-app bytes nor route-byte proportions.
Profile counters remain volume-only facts with unknown destination and route
until matching byte evidence exists.
Joining outbound proof to a sampled flow also requires the same channel and client identity;
a shared destination and nearby timestamp alone cannot prove its route.
DNS links only use safe time-ordered answers, and unverified route bytes stay in
`unknown_bytes` to preserve the accounting invariant.

`modules/traffic-observatory/bin/live-check` remains a compatibility wrapper,
but the canonical live A/B/C health owner is
`./modules/ghostroute-health-monitor/bin/live-check`.

## Runtime Storage & Artifacts

- Router traffic counters and snapshot files.
- Local report output on stdout.
- Optional local `reports/` artifacts when called by health/report workflows.

## Dependencies On Other Modules

- Routing Core installs and invokes router counter scripts.
- Shared helpers provide router connection and device-label redaction.
- Health Monitor consumes traffic summaries for health snapshots.

## Failure Modes

The LAN conntrack sampler calculates deltas per connection tuple, including the
client port, before grouping by destination. Closing one parallel connection
must not reset a destination's aggregate and replay the surviving connection's
lifetime bytes. Newly observed/reappearing tuples and decreasing counters
initialize a baseline; their previous lifetime is not an interval measurement.
All bounded observed connections retain a baseline even when the output fact
limit is smaller. Conntrack detail remains a sampled lower bound: short-lived
connections between polls and initial baseline bytes cannot be reconstructed.

Corrected rows use `conntrack_connection_delta`. Legacy grouped
`conntrack_snapshot_delta` rows remain in raw history for diagnosis but are
excluded by evidence export and edge rollups with an explicit evidence warning.
Do not use them to reconstruct historical app bytes. The independent LAN and
profile counters remain the volume sources. Test the actual router awk stages
with `python3 tests/test-lan-flow-connection-deltas.py` before deployment.

`traffic-facts` indexes DNS answers by destination IP and route observations by
client and destination, with pre-parsed timestamps and bounded time lookup.
Indexing by client alone is insufficient: one busy client can otherwise trigger
a flow-by-route-log cross product and exceed the collection timeout. The join
preserves source-order ties, shared-answer ambiguity, port/protocol checks,
time-window boundaries and conflicting-outbound rejection. It never assigns
unmeasured bytes to applications.
Run `python3 tests/test-traffic-facts-index.py` for equivalence and bounded-size
regressions. A transport timeout can leave a report subprocess running on the
report host; verify its ancestry and age before terminating that report alone.

- Stale traffic snapshots.
- Missing counter chains after firewall restart.
- Device labels unavailable, causing redacted or unknown labels.
- Managed traffic visible on the wrong exit path.

## Tests

- Covered by `./tests/run-all.sh`, `modules/traffic-observatory/tests/test-router-rollups.sh`
  and health/report fixture tests.
- Live behavior is confirmed by `./verify.sh` and traffic report smoke checks.
- `python3 tests/test-traffic-measurement-core.py` checks the cross-channel byte
  contract, large counters, sensitive exit observations and LAN correlation isolation.

## Related Docs

- `modules/traffic-observatory/docs/traffic-observability.md`
- `modules/traffic-observatory/docs/llm-traffic-runbook.md`
- `modules/routing-core/docs/network-flow-and-observer-model.md`

# GhostRoute Health Monitor Module Overview

## Purpose

GhostRoute Health Monitor is the read-only reliability module for the router +
VPS setup. It writes local sentinels, `status.json`, Markdown summaries, daily
digests and disk-based alert ledgers without changing production routing state.

## Features

- Router probes for sing-box, Reality paths, Channel A/Home Reality,
  Channel B and Channel C split leaks, DNS leaks, rule-set drift and stale
  snapshots.
- VPS observer probes for Caddy, Xray, 3x-ui, disk pressure and recent Reality
  evidence.
- Compact daily status and active leak-check commands for operator triage.
- Short live A/B/C runtime-chain check with text/JSON output, local logging and
  optional active probes.
- Managed egress path comparison and backend-bank health for the owned primary
  VPS, reserve Reality profile, owned clone VPS and the active router
  `reality-out` backend.
- Local-only alert ledgers and merged control-machine reports.
- Rolling baseline learning for RTT and retransmit degradation.

## How It Works

Router and VPS probes emit JSONL evidence into their own runtime storage.
Aggregators turn that evidence into `STATUS_OK` / `STATUS_FAIL`, `status.json`
and `summary-latest.md`. The control-machine report reads both sides and can
save a merged operational report back to router runtime storage.

## Architecture

- `router/` contains BusyBox-compatible router monitor scripts.
- `vps/` contains VPS observer scripts.
- `bin/` contains local report commands.
- `tests/` contains fixture tests for router, VPS and merged report behavior.

## Read-only / Mutating Contract

Probes and reports are read-only relative to production routing. They may write
their own health state, alerts and summaries. They must not restart services,
edit catalogs, rotate secrets or repair routing without a separate explicit
operator action.

## Public Commands

- `./modules/ghostroute-health-monitor/bin/router-health-report`
- `./modules/ghostroute-health-monitor/bin/router-health-report --save`
- `./modules/ghostroute-health-monitor/bin/ghostroute-health-report`
- `./modules/ghostroute-health-monitor/bin/ghostroute-health-report --save`
- `./modules/ghostroute-health-monitor/bin/status`
- `./modules/ghostroute-health-monitor/bin/leak-check`
- `./modules/ghostroute-health-monitor/bin/live-check`
- `./modules/ghostroute-health-monitor/bin/managed-egress-check`
- `./modules/ghostroute-health-monitor/bin/egress-backend-health`
- `./modules/ghostroute-health-monitor/bin/egress-dpi-probe`
- Runtime-only router command: `/jffs/scripts/health-monitor/run-once`

`status` is the compact daily view: overall drift count, STEALTH capacity,
Channel A/Home Reality invariants, Channel B ingress/relay summary, rule-set
mirror count and the last non-OK probe. By default it avoids the full traffic
report so it stays quick; run `GHOSTROUTE_STATUS_WITH_TRAFFIC=1
./modules/ghostroute-health-monitor/bin/status` when you need the byte-level
Home Reality (Channel A) split inline.

`leak-check` is the active egress/policy check: it runs the existing read-only
router probes for Reality exit, DNS/IPv6 policy and rule-set sync, then
validates that the static raw-IP mirror exists. Both commands sanitize IP/port
evidence and never mutate routing, services, catalogs or secrets. `leak-check`
may append health probe evidence to the router health-monitor log directory,
which is the module-owned monitoring state.

`managed-egress-check` compares the primary owned VPS path with the active
router managed egress. It checks router TCP/TLS reachability to the primary
cover endpoint, raw backup TCP/TLS reachability when a backup profile is
configured, and the real application path through router SOCKS canaries. It
sanitizes endpoint evidence and treats backup raw TLS as advisory because some
Reality endpoints intentionally close generic TLS handshakes.

`egress-backend-health` reports the managed egress backend bank by role
(`primary_vps`, `backup_reality`, `hermes_vps`) and then probes application
canaries through the active router SOCKS path. Inactive backend TCP/TLS probes
are advisory; active application canaries are the canonical proof that the
selected backend works for managed traffic. The command emits human text or
`--json` with `schema_version`, `active_backend`, `channel_d_backend`,
`backend_bank[]`, `app_canaries[]` and `rollup`, without printing raw endpoints,
provider values, IP addresses or keys.

`egress-dpi-probe` is the path / censorship-signature classifier for the same
backend bank. Where `egress-backend-health` proves the *active* backend carries
app traffic through the tunnel, this probes the *raw* TLS path to each backend's
public endpoint and gives each vantage a descriptive verdict — `open` (handshake
completed, usually on the Reality cover/decoy), `reset` (RST on/after the TLS
ClientHello), `refused`, `timeout`, or `tls_reject` (fast TLS rejection, typical
of a Reality server refusing a plain probe). The real signal is the comparison:
because each backend's Reality config is constant across vantages, a difference
isolates the network path while agreement points at the endpoint. With
`--from both` (default) a router-open but control-degraded backend is reported as
`network_specific_filtering` (the current network is interfering, so switching
backend will not help); matching results are `consistent_degraded` (cross-check
the app canaries). Use `--from control|router` for a single vantage. Output is
human text or `--json` (`schema_version`, `from`, `active_backend`, `results[]`
with per-vantage `stage`/`verdict` and a `cross_verdict`), always sanitized of
hosts/IPs/SNIs. This is an advisory heuristic — a healthy Reality backend can
legitimately reset a plain probe — so cross-check against the
`egress-backend-health` live app canaries before acting. The "control" vantage
is whatever network the command actually runs from — confirm that before
trusting a `network_specific_filtering` verdict as "this is my current
network": if a coding agent or CI runner executes this from a sandbox/VPN, its
egress ASN can differ from the operator's real network, which silently changes
what the comparison proves.

`live-check` is the canonical short "are A/B/C alive now?" check. Default mode
is config/log based and normally takes 1-8 seconds: listeners, firewall rules,
sing-box split rules, DNS/catalog sanity, direct-domain sanity, the iCloud
Reality cover SNI, recent sanitised sing-box evidence, and the Console
collector path from VPS to the router remote endpoint when the control machine
has Ansible/Vault access. Use `--json` for Console/LLM automation. Use
`--active-probe` only when the default check is green but a user still reports a
symptom; it runs bounded network probes and may take 15-30 seconds.
Use `--deploy-gate` before mutating deploys. It implies `--active-probe`, adds
VPS edge checks when Ansible/Vault are available, and promotes deploy-critical
WARN/N/A results to CRIT. A full deploy gate normally takes 40-90 seconds and is
intended to protect the current working Wi-Fi managed domains, VPS edge and
Channel A/B/C runtime chain before files or services are changed.

`deploy-risk` is a fast path classifier for local and CI workflows. It inspects
changed paths and reports whether the full live deploy gate is required:
router/VPS runtime, DNS/catalog routing, Channel A/B/C, deploy, recovery and
Health Monitor changes require the gate; Console-only, docs-only and test-only
changes can use their narrower local checks. This command is advisory only:
mutating deploy entrypoints still run their own pre/post deploy gate.

## Runtime Storage & Artifacts

- Router primary: `/opt/var/log/router_configuration/health-monitor`
- Router fallback: `/jffs/addons/router_configuration/health-monitor`
- VPS: `/var/log/ghostroute/health-monitor`
- Local generated reports: `reports/`

## Dependencies On Other Modules

- Routing Core supplies the runtime hooks and rule-set state.
- Traffic Observatory supplies traffic context for router health reports.
- DNS & Catalog Intelligence supplies catalog capacity and drift evidence.
- Recovery & Verification is used for live confirmation.

## Failure Modes

- `STATUS_FAIL` or stale `summary-latest.md`.
- Reality path unavailable on router or VPS.
- DNS/plain port 53 leak, IPv6 drift or direct traffic leak.
- Rule-set drift or catalog freshness problems.

## Tests

- `./modules/ghostroute-health-monitor/tests/test-health-monitor.sh`
- `./modules/ghostroute-health-monitor/tests/test-egress-backend-health.sh`
- `./modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh`
- `./tests/run-all.sh`

## Related Docs

- `modules/ghostroute-health-monitor/docs/stealth-monitoring-implementation-guide.md`
- `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md`
- `docs/troubleshooting.md`

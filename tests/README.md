# Tests

The test layer covers safe parser/renderer/reporting behavior. It does not emulate the ASUS/Merlin runtime.

## Current Runtime Contract

Docs and health tests should assume the current production policy:

```text
br0 TCP     -> STEALTH_DOMAINS / VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> STEALTH_DOMAINS / VPN_STATIC_NETS -> REJECT, forcing TCP fallback
OUTPUT      -> main routing by default; explicit proxy only for router-local diagnostics
wgs1        -> VPN_DOMAINS / VPN_STATIC_NETS    -> 0x1000 -> table wgc1
```

Legacy expectations such as `br0 -> RC_VPN_ROUTE`, `OUTPUT -> RC_VPN_ROUTE`, or per-domain `@wgc1` DNS upstreams are not the normal state anymore.

## What Tests Cover

### Fixture tests

```bash
./tests/test-router-health.sh
./tests/test-catalog-review.sh
./tests/test-dns-forensics.sh
./tests/test-health-monitor.sh
./tests/test-vps-health-monitor.sh
```

These tests validate:

- stable parsing of saved health/journal/report text
- stable Markdown rendering for humans and LLMs
- catalog review output shape
- DNS forensics snapshot/report formatting
- health monitor JSONL/status aggregation, local alert ledger, summary rendering
- VPS observer fixtures and merged GhostRoute health report rendering

They do not connect to the router.

### Syntax checks

```bash
bash -n verify.sh scripts/router-health-report scripts/traffic-report scripts/traffic-daily-report scripts/lib/router-health-common.sh tests/test-router-health.sh
bash -n scripts/catalog-review-report scripts/dns-forensics-report tests/test-catalog-review.sh tests/test-dns-forensics.sh
sh -n scripts/firewall-start scripts/nat-start scripts/domain-auto-add.sh scripts/health-monitor/lib.sh scripts/health-monitor/run-probes scripts/health-monitor/aggregate scripts/health-monitor/daily-digest scripts/health-monitor/run-once scripts/vps-health-monitor/lib.sh scripts/vps-health-monitor/run-probes tests/test-health-monitor.sh
bash -n scripts/ghostroute-health-report tests/test-vps-health-monitor.sh
```

### Ansible syntax

```bash
cd ansible
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
ansible-playbook --syntax-check playbooks/10-stealth-vps.yml
ansible-playbook --syntax-check playbooks/99-verify.yml
```

### Live smoke

Live smoke reads the router/VPS and may require network access:

```bash
./verify.sh
./scripts/router-health-report
./scripts/traffic-report
cd ansible && ansible-playbook playbooks/99-verify.yml
```

Expected health semantics:

- `STEALTH_DOMAINS` exists.
- sing-box REDIRECT listener on `:<lan-redirect-port>` exists.
- LAN TCP REDIRECT rules exist for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- LAN UDP/443 reject rules exist for `STEALTH_DOMAINS` and `VPN_STATIC_NETS`.
- legacy `fwmark 0x2000`, table `200`, and `singbox0` are absent.
- `br0 -> RC_VPN_ROUTE` is disabled.
- `OUTPUT -> RC_VPN_ROUTE` is disabled.
- `wgs1 -> RC_VPN_ROUTE` is enabled.
- `wgs1 -> STEALTH_DOMAINS` is disabled.

## What Tests Do Not Cover

- Real packet forwarding correctness.
- Real Caddy/Xray handshakes.
- Actual client QR usability.
- Live secrets/vault values.
- Provider-side blocking behavior.

Use `ansible/playbooks/99-verify.yml` plus manual client checks for those.

## Documentation Consistency Check

After documentation updates:

```bash
rg '@wgc1|OUTPUT -j RC_VPN_ROUTE|PREROUTING -i br0 -j RC_VPN_ROUTE|server=/.*@wgc1' README*.md docs CLAUDE.md
```

Remaining matches must be explicitly marked as legacy, retired, rollback-only, or historical.

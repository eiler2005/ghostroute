# Channel A Decommission Final Runbook

**Status:** implementation cleanup in progress after the mobile home Reality relay rollout.
**Baseline:** `pre-channel-a-final-cleanup-2026-04-25`.

This document is the final execution plan for retiring Channel A: router WireGuard
server `wgs1` plus router WireGuard client `wgc1`. The staged runtime shutdown
was already completed during the mobile-relay work:

- `wgs1_enable=0`
- `wgc1_enable=0`
- `wg show` has no active `wgs1`/`wgc1`
- no active `fwmark 0x1000 -> table wgc1`
- no active `RC_VPN_ROUTE`
- mobile access now uses router-side Reality ingress on TCP/<home-reality-port>

The remaining work is cleanup: remove legacy catalog/runtime artifacts, keep the
cold fallback safe, and make verification expect the new Reality-only steady state.

## 0. Threat Model And Goal

Channel A is removed because classic WireGuard has an obvious UDP fingerprint:
public WAN ingress for `wgs1`, and outbound WireGuard handshake traffic from
`wgc1`. After this cleanup, routine traffic should use only Channel B:

```text
LAN/Wi-Fi clients -> STEALTH_DOMAINS / VPN_STATIC_NETS
  -> TCP REDIRECT :<lan-redirect-port> -> sing-box -> Reality -> VPS

Mobile clients -> home WAN TCP/<home-reality-port>
  -> router Reality inbound -> sing-box -> Reality -> VPS
```

`wgc1_*` NVRAM fields are preserved as a cold fallback. Do not delete or unset
them. Only `wgc1_enable=0` is enforced in normal operation.

## 1. New Steady State

| Component | Expected State |
|---|---|
| `wgs1` | disabled, interface absent |
| `wgc1` | disabled, interface absent |
| `VPN_DOMAINS` | absent |
| `STEALTH_DOMAINS` | present and populated |
| `VPN_STATIC_NETS` | present and populated; name retained for compatibility |
| `fwmark 0x1000` | absent except during explicit emergency fallback |
| `RC_VPN_ROUTE` | absent |
| DNS domain source | `configs/dnsmasq-stealth.conf.add` only |
| Mobile ingress | router Reality TCP/<home-reality-port> |
| IPv6 | disabled; dnsmasq filters AAAA |

## 2. Invariants

1. `wgc1_*` NVRAM is preserved forever.
2. `wgc1_enable` and `wgs1_enable` stay `0`.
3. `VPN_STATIC_NETS` stays because Channel B uses it.
4. `configs/static-networks.txt` stays.
5. `VPN_DOMAINS` is not recreated or persisted.
6. `domain-auto-add.sh` writes only `STEALTH_DOMAINS`.
7. No `server=/domain/...@wgc1` rules are generated.
8. Normal operation has no `0x1000` policy rule.
9. Emergency fallback is dry-run by default and must not be enabled casually.
10. IPv6 remains disabled until a separate dual-stack design exists.

## 3. Implementation Phases

### Phase A - Baseline

Create a checkpoint before cleanup:

```bash
git add -A
git commit -m "Checkpoint mobile home relay rollout"
git tag pre-channel-a-final-cleanup-2026-04-25
```

### Phase B - Domain Catalog Cleanup

- Delete repo files:
  - `configs/dnsmasq.conf.add`
  - `configs/dnsmasq-vpn-upstream.conf.add`
- Keep `configs/dnsmasq-stealth.conf.add` as the only managed domain catalog.
- Update `deploy.sh` and the Ansible stealth role so live dnsmasq uses:

```text
/jffs/configs/dnsmasq.conf.add
  conf-file=/jffs/configs/dnsmasq-stealth.conf.add
```

- Remove old inline managed blocks from `/jffs/configs/dnsmasq.conf.add`:
  - `router_configuration dnsmasq.conf.add`
  - `router_configuration dnsmasq-vpn-upstream.conf.add`
  - `router_configuration dnsmasq-stealth.conf.add`

### Phase C - Runtime Hooks Cleanup

- `firewall-start` creates/restores `STEALTH_DOMAINS`, not `VPN_DOMAINS`.
- `cron-save-ipset` persists `STEALTH_DOMAINS.ipset`.
- `nat-start` is no-op for Channel A.
- `stealth-route-init.sh` owns only Channel B REDIRECT/QUIC-drop and mobile
  Reality INPUT rules.
- `domain-auto-add.sh` writes only `ipset=/domain/STEALTH_DOMAINS`.
- `update-blocked-list.sh` fetches through local sing-box SOCKS, not `wgc1`.

### Phase D - Cold Fallback

Create `scripts/emergency-enable-wgc1.sh` with default `--dry-run` behavior.

`--enable` must:

- set `wgc1_enable=1`
- restart the WireGuard client service
- add `ip rule fwmark 0x1000/0x1000 table wgc1`
- mark `STEALTH_DOMAINS` and `VPN_STATIC_NETS`
- insert `nat PREROUTING -m mark --mark 0x1000/0x1000 -j ACCEPT`
- insert `FORWARD -m mark --mark 0x1000/0x1000 -j ACCEPT`

`--disable` must remove those emergency rules and set `wgc1_enable=0`.

Do not run `--enable` during normal verification.

### Phase E - One-Time Router Cleanup

After deploying the repo changes, run once on the router:

```sh
/jffs/addons/x3mRouting/domain-auto-add.sh --cleanup-only || true
service restart_dnsmasq

ipset destroy VPN_DOMAINS 2>/dev/null || true
rm -f /opt/tmp/VPN_DOMAINS.ipset /jffs/addons/router_configuration/VPN_DOMAINS.ipset

while ip rule del fwmark 0x1000/0x1000 table wgc1 2>/dev/null; do :; done
iptables -t nat -D POSTROUTING ! -s 10.10.59.106/32 -o wgc1 -j MASQUERADE 2>/dev/null || true

nvram set wgs1_enable=0
nvram set wgc1_enable=0
nvram commit
```

### Phase F - Verification

Required local checks:

```bash
bash -n deploy.sh verify.sh scripts/*.sh scripts/*
ansible-playbook ansible/playbooks/20-stealth-router.yml --syntax-check
ansible-playbook ansible/playbooks/99-verify.yml --syntax-check
tests/test-router-health.sh
tests/test-catalog-review.sh
git diff --check
```

Required router checks:

```sh
nvram get wgs1_enable
nvram get wgc1_enable
wg show
ip rule show
ipset list VPN_DOMAINS
ipset list STEALTH_DOMAINS | head
ipset list VPN_STATIC_NETS | head
iptables -t nat -S | grep -E 'wgs1|wgc1|0x1000|VPN_DOMAINS' || true
iptables -t mangle -S | grep -E 'wgs1|wgc1|0x1000|RC_VPN_ROUTE|VPN_DOMAINS' || true
dig @192.168.50.1 youtube.com AAAA +short
dig @192.168.50.1 youtube.com A +short
/jffs/scripts/emergency-enable-wgc1.sh --dry-run
```

Expected:

- `wgs1_enable=0`
- `wgc1_enable=0`
- `wg show` empty for Channel A
- no `0x1000`, `wgc1`, `wgs1`, `RC_VPN_ROUTE` runtime hooks
- `VPN_DOMAINS` does not exist
- `STEALTH_DOMAINS` exists
- `VPN_STATIC_NETS` exists
- YouTube AAAA answer is empty while IPv6 is disabled
- dry-run fallback prints planned actions without enabling WireGuard

## 4. Rollback

### Level 1 - Undo Cleanup Only

Restore from the checkpoint tag:

```bash
git diff pre-channel-a-final-cleanup-2026-04-25..HEAD
git restore --source pre-channel-a-final-cleanup-2026-04-25 -- <file>
```

### Level 2 - Emergency `wgc1`

Only if Reality fails catastrophically:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --enable
```

Disable after incident:

```sh
/jffs/scripts/emergency-enable-wgc1.sh --disable
```

### Level 3 - Full Repo Rollback

Use the checkpoint tag and redeploy. Do not unset `wgc1_*` NVRAM.

## 5. Monitoring

For seven days after cleanup:

- run `ROUTER=192.168.50.1 ./verify.sh`
- run `ansible/playbooks/99-verify.yml` against the router
- inspect sing-box logs for `redirect-in` and `reality-out` activity
- confirm mobile home QR profiles still work through TCP/<home-reality-port>
- confirm no WAN UDP WireGuard traffic appears in packet captures
- keep WAN SSH disabled unless deliberately needed

## 6. Non-Goals

- no ZeroTier overlay in this cleanup
- no multi-VPS or AS-mismatch redesign
- no CDN fronting
- no IPv6 enablement
- no cascade exit
- no `maxtg_bridge` migration

# Routing Performance Troubleshooting

**Status:** current as of 2026-04-25.

This runbook explains routing performance issues seen or considered in the
current GhostRoute production model, especially slow remote mobile LTE access
through the Home Reality ingress.

It is intentionally operational: use it to understand what was changed, why it
was changed, how to verify the runtime state, and what to try next.

## 0. Current Data Path

There are two active performance-sensitive paths.

### Home Wi-Fi / LAN

```text
LAN device
  -> ASUS dnsmasq / ipset
  -> iptables nat REDIRECT :<lan-redirect-port> for STEALTH_DOMAINS / VPN_STATIC_NETS
  -> router sing-box redirect-in
  -> VLESS+Reality TCP/443
  -> VPS Xray
  -> destination site
```

### Remote Mobile LTE

```text
iPhone / Mac outside home
  -> LTE carrier
  -> home public Russian IP TCP/<home-reality-port>
  -> router sing-box reality-in
  -> managed split:
       STEALTH_DOMAINS / VPN_STATIC_NETS -> VPS Reality
       non-managed destinations          -> home WAN direct-out
```

The LTE path has extra latency and one extra TCP/TLS-like leg. It is therefore
more sensitive to MSS/MTU, TCP buffer sizing, and ingress connection limits than
ordinary home Wi-Fi.

## 1. Summary Of Applied Fixes

| Area | Runtime state | Why |
|---|---|---|
| Mobile MSS clamp | `TCPMSS --set-mss 1360` on `PREROUTING dport <home-reality-port>` and `OUTPUT sport <home-reality-port>` | Avoid LTE PMTUD blackholes and large-segment retransmits on the mobile -> home TCP leg. |
| Mobile ingress connlimit | `connlimit --connlimit-above 300` before ACCEPT | Avoid false drops for 6-7 mobile devices, Safari tab bursts, app sync, and LTE CGNAT source sharing. |
| TCP socket buffers | `rmem_max/wmem_max = 8388608` and TCP r/w max `8388608` | Give high-BDP LTE paths enough receive/send window headroom. |
| PMTU probing | `tcp_mtu_probing = 1` | Let Linux recover better when ICMP fragmentation-needed is blocked on other TCP paths. It does not raise the mobile ingress MSS above the static `1360` clamp. |
| Slow-start after idle | `tcp_slow_start_after_idle = 0` | Avoid needless throughput collapse after idle periods. |
| TCP features | `tcp_window_scaling=1`, `tcp_sack=1`, `tcp_timestamps=1` | Keep core TCP performance features explicitly enabled. |
| Congestion control | `cubic` | `bbr` is not available in the current Merlin kernel/modules. |

These changes are managed by:

- [ansible/group_vars/routers.yml](../ansible/group_vars/routers.yml)
- [ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2](../ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2)
- [ansible/playbooks/99-verify.yml](../ansible/playbooks/99-verify.yml)
- [scripts/lib/router-health-common.sh](../scripts/lib/router-health-common.sh)

## 2. MTU / MSS Problems

### Symptom

On LTE, pages open slowly, video starts but stalls, or large transfers are much
slower than expected. Home Wi-Fi stays fast.

Typical cause: LTE path MTU is lower than ordinary Ethernet MTU, and PMTUD can
fail when ICMP fragmentation-needed is filtered. With nested Reality/TLS-like
transport, large TCP segments can trigger retransmits.

### Important Detail For This Architecture

The Home Reality mobile ingress is a local service on the router:

```text
iPhone -> router TCP/<home-reality-port> -> local sing-box reality-in
```

So a generic `FORWARD --clamp-mss-to-pmtu` rule does **not** cover this ingress.
The packets are delivered locally, not forwarded through the router.

We need both sides of the TCP handshake:

```text
PREROUTING dport <home-reality-port>  # inbound SYN from mobile client
OUTPUT     sport <home-reality-port>  # outbound SYN-ACK from router
```

### Current Fix

```sh
iptables -t mangle -A PREROUTING \
  -p tcp --dport <home-reality-port> --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1360

iptables -t mangle -A OUTPUT \
  -p tcp --sport <home-reality-port> --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1360
```

`1360` is deliberately conservative for LTE plus Reality overhead. It trades a
small amount of efficiency for fewer fragmentation/retransmit pathologies.

This static clamp also means `tcp_mtu_probing=1` cannot discover a larger MSS for
the Home Reality ingress itself. That is an accepted defensive trade-off. Future
experiments with `--clamp-mss-to-pmtu`, `1380`, or `1400` must be backed by LTE
measurements and easy rollback.

### Verification

```sh
ssh admin@192.168.50.1 '
  iptables-save -t mangle | grep -iE "TCPMSS|<home-reality-port>"
'
```

Expected:

```text
-A PREROUTING ... --dport <home-reality-port> ... -j TCPMSS --set-mss 1360
-A OUTPUT ... --sport <home-reality-port> ... -j TCPMSS --set-mss 1360
```

Also:

```sh
ANSIBLE_CONFIG=ansible/ansible.cfg \
  ansible-playbook ansible/playbooks/99-verify.yml --limit routers
```

Expected: router play succeeds.

## 3. TCP Buffer / High-BDP Problems

### Symptom

LTE bandwidth is available, but single-stream throughput is much lower than it
should be. Latency is naturally higher because the path is:

```text
mobile -> home -> VPS -> site -> VPS -> home -> mobile
```

High latency multiplied by moderate/high bandwidth requires larger TCP windows.
Small socket caps can prevent a TCP flow from filling the pipe.

### Current Runtime Values

```text
net.core.rmem_max                  8388608
net.core.wmem_max                  8388608
net.ipv4.tcp_rmem                  4096 262144 8388608
net.ipv4.tcp_wmem                  4096 65536 8388608
net.ipv4.tcp_mtu_probing           1
net.ipv4.tcp_slow_start_after_idle 0
net.ipv4.tcp_window_scaling        1
net.ipv4.tcp_sack                  1
net.ipv4.tcp_timestamps            1
```

These are applied by `stealth-route-init.sh`, which is re-run from
`firewall-start` after Merlin firewall rebuilds.

### Verification

```sh
ssh admin@192.168.50.1 '
  for p in \
    /proc/sys/net/core/rmem_max \
    /proc/sys/net/core/wmem_max \
    /proc/sys/net/ipv4/tcp_rmem \
    /proc/sys/net/ipv4/tcp_wmem \
    /proc/sys/net/ipv4/tcp_mtu_probing \
    /proc/sys/net/ipv4/tcp_slow_start_after_idle \
    /proc/sys/net/ipv4/tcp_window_scaling \
    /proc/sys/net/ipv4/tcp_sack \
    /proc/sys/net/ipv4/tcp_timestamps
  do
    printf "%s=" "$p"
    cat "$p" 2>/dev/null || echo missing
  done
'
```

Health report should also show:

```text
Home Reality LTE MSS clamp :<home-reality-port> | OK
Router TCP high-BDP tuning        | OK
```

## 4. Congestion Control: BBR Is Not Available

BBR/fq was checked on the router:

```sh
ssh admin@192.168.50.1 '
  modprobe tcp_bbr 2>/dev/null || true
  modprobe sch_fq 2>/dev/null || true
  cat /proc/sys/net/ipv4/tcp_available_congestion_control
  cat /proc/sys/net/core/default_qdisc 2>/dev/null || true
'
```

Current result:

```text
available congestion control: reno cubic
default qdisc: pfifo_fast
tcp_bbr module: missing
sch_fq module: missing
```

Therefore the current production choice is `cubic`. Do not document BBR as
enabled unless a future Merlin/kernel build actually provides `tcp_bbr` and
`sch_fq`.

## 5. Connlimit On TCP/<home-reality-port>

### What Happened

The original mobile ingress rule used:

```text
connlimit --connlimit-above 30
```

Runtime counters showed this rule had already dropped a very large number of
SYN packets. That made it a strong candidate for LTE stalls and reconnect churn.

Why this can happen with normal clients:

- 6-7 devices can be active at the same time.
- iOS apps open many parallel connections.
- Safari tabs, push sync, Apple services, mail, messengers and video apps can
  spike together.
- LTE operators can put multiple devices behind the same CGNAT source IP, while
  `connlimit --connlimit-mask 32 --connlimit-saddr` counts per source IPv4.

### Current Fix

The limit is now:

```text
connlimit --connlimit-above 300
```

This is intentionally generous. It keeps a minimal guard against noisy SYN
floods on the home ingress, but should not affect normal family mobile usage.

If it still drops during real LTE tests, prefer raising to `500` before removing
the rule entirely.

### Verification

```sh
ssh admin@192.168.50.1 '
  iptables -nvxL INPUT --line-numbers | grep -E "<home-reality-port>|connlimit"
'
```

Expected:

```text
DROP ... tcp dpt:<home-reality-port> ... #conn src/32 > 300
ACCEPT ... tcp dpt:<home-reality-port>
```

Watch the `DROP` packet counter during LTE tests. It should stay near zero.

## 6. DNS Latency

Mobile DNS hardening is handled separately from raw throughput:

- iOS client apps should use Fake-IP / override-system-DNS style settings.
- Router-side `reality-in` DNS ports `53/853` are forced through
  `reality-out` if DNS already entered the tunnel.

DNS latency can still affect page-load feel if the mobile app does not cache or
fake DNS efficiently. This is usually visible as slow initial page start rather
than low sustained video/download throughput.

See [docs/client-profiles.md](client-profiles.md) for client-side DNS settings.

## 7. How To Test After Changes

Use a clean mobile session. Existing TCP sessions keep their negotiated MSS and
socket behavior.

1. On iPhone, disconnect/reconnect the Home Reality profile.
2. Toggle LTE airplane mode if the carrier path looks sticky.
3. Start a YouTube video or another known managed destination.
4. Watch router counters:

```sh
ssh admin@192.168.50.1 '
  iptables -nvxL INPUT --line-numbers | grep -E "<home-reality-port>|connlimit"
  iptables-save -t mangle | grep -iE "TCPMSS|<home-reality-port>"
'
```

5. Generate health:

```sh
ROUTER=192.168.50.1 ./verify.sh
ROUTER=192.168.50.1 ./scripts/router-health-report --save
```

Expected:

```text
Drift: No missing repo-managed invariants detected.
Result: OK
```

## 8. Rollback

The changes are idempotent and managed by Ansible. Prefer reverting through git
and redeploying rather than hand-editing router state.

### Roll Back MSS Clamp Only

Remove the two TCPMSS blocks from `stealth-route-init.sh.j2`, deploy:

```sh
ANSIBLE_CONFIG=ansible/ansible.cfg \
  ROUTER=192.168.50.1 \
  ansible-playbook ansible/playbooks/20-stealth-router.yml --limit routers
```

### Roll Back TCP Buffer Tuning

Set:

```yaml
router_tcp_perf_tuning_enabled: false
```

Then deploy. Note that kernel runtime values may remain until reboot or manual
reset; the health invariant should be adjusted together with the change.

### Roll Back Connlimit Headroom

Change:

```yaml
home_reality_connlimit_above: 300
```

to a different value, then deploy. For current traffic, `300` is the recommended
baseline.

## 9. Current Recommended Baseline

Keep:

- MSS `1360` on both mobile ingress directions.
- connlimit `>300`.
- TCP max buffers `8 MiB`.
- `tcp_mtu_probing=1`.
- `cubic`, unless a future kernel exposes `bbr` and `sch_fq`.

Revisit only if live LTE tests still show stalls after reconnecting the mobile
profile and confirming the connlimit DROP counter stays at zero.

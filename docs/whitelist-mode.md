# RU Mobile Whitelist Mode

> Status: research and design. **Nothing here is implemented.** This document
> describes how RU mobile whitelist mode affects GhostRoute and what a future
> Channel W could look like. It is not a description of current runtime state.
> The posture decisions are fixed in
> [adr/0011-whitelist-mode-posture.md](adr/0011-whitelist-mode-posture.md).

## What Whitelist Mode Is

"Whitelist mode" (`белые списки`) is an operator-side filtering regime, not a
client-side domain list. During a mobile shutdown the carrier permits only an
approved set of destinations and drops everything else.

Publicly measured mechanics:

- filtering is two-level: **L3 IP allowlist** (reported around 63k addresses)
  **plus L7 SNI** inspection, with additional port filtering;
- when the SNI is not on the approved set, connections are cut after roughly the
  **first 16-20 KB** of response body. The TCP handshake completes and data
  starts flowing, which makes the failure look like a stall rather than a block;
- it applies to **mobile data only** (MTS, Megafon, Beeline, Tele2). Home
  Wi-Fi, fibre and wired corporate links are not affected.

The approved set is not published as a single document, so any list of
whitelisted destinations is a community reconstruction, not an authoritative
source.

## Why Reality Does Not Help Here

Reality/Vision defeats **L7** classification: the handshake looks like an
ordinary TLS session to an allowed site. Whitelist mode rejects the flow at
**L3**, before any SNI is presented, because the destination address is not in
the allowlist.

```text
normal DPI blocking   -> L7 decides    -> Reality survives
whitelist mode        -> L3 decides first -> Reality never gets a turn
```

This is the core reason GhostRoute's existing channels cannot be tuned into
surviving the regime. The problem is reachability of the first hop, not the
disguise of the first hop.

## Impact On GhostRoute Channels

Every managed channel is home-first, so they all terminate at the same home
public address. That address is an ordinary residential RU address and is not in
the carrier allowlist.

| Channel | First hop from the endpoint | Survives whitelist mode | Why |
|---|---|---|---|
| A - home Wi-Fi / LAN | local bridge, no mobile leg | **Yes** | Home broadband is not filtered |
| A - Home Reality (mobile) | endpoint -> home public host | No | Home address not in L3 allowlist |
| B - XHTTP/TLS | endpoint -> home public host | No | Same L3 rejection |
| C1-Shadowrocket | endpoint -> home public host, HTTPS CONNECT | No | Same L3 rejection |
| C1-sing-box (native Naive) | endpoint -> home public host | No | Same L3 rejection |
| D - NaiveProxy lab | endpoint -> home router Caddy | No | Same L3 rejection |
| M - MAX service egress | router-initiated outbound SSH from home | **Yes** | No mobile leg; originates on home WAN |
| A - emergency profile | endpoint -> managed egress VPS | No | Foreign address not in L3 allowlist |

The operationally important consequence: **whitelist mode takes A, B, C, D and
the emergency profile down at the same moment**, because they share one failure
cause rather than five independent ones. There is no channel-to-channel
workaround inside the current design. Home Wi-Fi keeps working normally, so the
regime degrades mobile reach only.

## Option Space

| Approach | Mechanism | iOS | Verdict |
|---|---|---|---|
| Cover-service WebRTC | TCP-over-WebRTC disguised as a video call on a permitted service (Jitsi, Telemost, WB Stream, VK, DION) | Yes - unsigned `.ipa` in proxy mode exposes a local SOCKS5 listener | Main candidate, lab only |
| WDTT-style WireGuard over VK TURN | WireGuard wrapped in RTP so DPI sees WebRTC audio | No - Android only | Rejected: no iOS client |
| RU-hosted front hop inside the allowlist | RU cloud VPS relays to the foreign egress | Yes, client unchanged | **Rejected by operator decision** - legal and operational exposure |
| RU whitelist as client DIRECT rules | Keep permitted RU services usable while the tunnel is down | Yes, Shadowrocket-native | Cheap independent track |
| RU blocked-domain rule-sets (Re:filter and similar) | Auto-updating managed-domain lists | Yes | Orthogonal to this regime - do not conflate |

## Proposed Shape: Channel W As A Sub-Layer

If a survival lane is ever built, it must sit **under** the existing channels
rather than replace them:

```text
iPhone
  -> cover transport app (WebRTC via a permitted service)
  -> local SOCKS5 listener on the device
  -> Shadowrocket or Karing chains Channel C on top
  -> home router
  -> normal managed split -> reality-out / direct-out
```

This shape preserves the invariants that matter:

- the router still owns the managed-vs-direct decision after ingress;
- the carrier still sees `endpoint -> permitted service`, never `endpoint -> VPS`;
- Channel A REDIRECT, router DNS, TUN and recovery ownership are untouched;
- the lane is explicit and opt-in, consistent with the existing rule that
  channels are never automatic failover for each other.

## Router Resource Assessment

The cover transport needs a long-lived "creator" endpoint on free internet. The
open question is whether the home router can host it.

Known from the repo and public specifications:

- RT-AX88U Pro: BCM4912 quad-core Cortex-A53 at 2.0 GHz, 1 GB RAM;
- four Go runtimes plus dnsmasq already run concurrently on it - `sing-box-go`,
  `dnscrypt-proxy2`, `xray-core` and Caddy `forward_proxy@naive` for Channel D,
  alongside Python 3.13 and the traffic-evidence collectors
  (see [router-runtime-map.md](router-runtime-map.md));
- the init/boot guard sets `vm.overcommit_memory=1` because Entware Go runtimes
  otherwise fail to start. That is already a symptom of real memory pressure.

Read-only measurement checklist, to be run from the home network. None of these
mutate router state:

```sh
free
top -bn1 | head -20
df /opt /jffs /tmp/mnt
cat /proc/loadavg
nvram get productid
opkg list-installed | wc -l
```

Measured on the home LAN, router uptime 22.5 h, evening traffic:

| Metric | Value |
|---|---|
| `MemTotal` | 995 MB |
| `MemAvailable` | 335 MB |
| `MemFree` | 43 MB (the box runs on reclaimable cache) |
| Sum of all process RSS | 455 MB |
| Load average | 0.09 / 0.11 / 0.09 across 4 cores |
| `/opt` (USB) | 28.9 GB, 5% used |
| `vm.overcommit_memory` | `1`, as expected |

Resident set of the long-lived daemons:

| Process | RSS |
|---|---|
| `sing-box` | 72.6 MB |
| `tailscaled` | 29.5 MB |
| `caddy-channel-d` | 27.3 MB |
| `xray` | 18.6 MB |
| `dnscrypt-proxy` | 16.6 MB |
| `dnsmasq` (two instances) | 30.2 MB |

Roughly 165 MB across five Go daemons.

**Verdict: do not host the creator on the router.** The reasoning changed once
the numbers existed, so it is worth stating precisely.

- **CPU is not the constraint.** Load average 0.09 on four cores is effectively
  idle, with enormous headroom.
- **Memory is tight but not disqualifying on its own.** 335 MB available against
  a daemon that would plausibly sit in the 30-80 MB range, comparable to the
  existing `caddy-channel-d` or `sing-box`.
- **The blast radius is the disqualifier.** `vm.overcommit_memory=1` means the
  kernel does not refuse allocations, so memory exhaustion surfaces as the OOM
  killer rather than a clean failure - and the fattest target is `sing-box` at
  72.6 MB, which is Channel A. A compatibility lane must never be able to take
  Channel A down, and a WebRTC transport with video-channel modes has exactly
  the bursty allocation profile that triggers this.

The two guards that would make it safe were checked directly, and one of them
cannot be built on this firmware:

| Guard | Feasible | Evidence |
|---|---|---|
| `oom_score_adj` protection for `sing-box` | Yes | currently `0`, writable; its `oom_score` of `72` is the highest in the system |
| Hard memory cap on the new daemon | **No** | no `/proc/cgroups` and no cgroup mounts at all; `ulimit -v` is unusable for a Go runtime, which reserves a large virtual arena |

Without a cap, the only available guard does not protect the system - it just
redirects the kill to the next-highest scorer, which would be `tailscaled`
(remote access), `caddy-channel-d` (Channel D) or `dnsmasq` (DNS for the whole
house). That converts a Channel A outage into a different outage rather than
preventing one.

The router is therefore ruled out as the creator host, and the reason is the
missing cgroup support, not the memory headroom. There have been no OOM events
in 22.5 h of uptime, so this is a precaution about a new workload, not a
symptom of an existing problem.

The creator belongs on a separate home machine with Docker and working cgroups;
the project ships a Docker image, so that is the supported path. If no such
machine is available, the cover transport track stays unbuilt, which is an
acceptable outcome.

## Lab Protocol For The Cover Transport Track

The point of the lab is to answer whether the chain works at all, without
touching production state.

1. Run the creator on a home machine **outside** the router, or skip the track
   entirely per the assessment above.
2. On the iPhone, use a **separate** client profile. Do not modify the working
   A/B/C profiles.
3. Verify the chain `Shadowrocket -> local SOCKS5 -> Channel C`. Shadowrocket's
   proxy-chaining feature is **the first thing to confirm** - secondary sources
   describe it, but this has not been verified against primary documentation.
4. Explicitly check for a **routing loop**: the cover app's own traffic to the
   permitted service must go DIRECT, or the client will wrap the transport
   inside its own tunnel.
5. If chaining cannot be confirmed in Shadowrocket, retry with Karing. It runs a
   sing-box engine with richer routing and is already live-proven in
   [channel-d.md](channel-d.md).
6. Success criteria: egress IP changes, no DNS leak to the carrier, usable
   throughput, stable session, and defined behaviour after the cover call drops.

Phase 1 result, measured 2026-09-11 with both roles containerised on one Mac
and a public third-party Jitsi as the SFU:

| Check | Result |
|---|---|
| WebRTC transport establishes through the SFU | yes (XMPP + ICE negotiated) |
| SOCKS5 listener carries real traffic | yes, HTTP 200 |
| Traffic genuinely traverses the tunnel | confirmed - stopping the server end breaks the proxy |
| Direct throughput | 4.85 MB/s (10 MB in 2.2 s) |
| Tunnelled throughput | 0.69 MB/s (10 MB in 15.2 s), about 7x slower |

A follow-up run put a real iPhone on the tunnel over the home LAN, with Karing
as the client:

| Check | Result |
|---|---|
| iPhone imports the SOCKS5 listener | yes, via a `socks5://` QR |
| iPhone traffic traverses the tunnel | confirmed - stopping the server end kills the phone's browsing, restoring it brings the phone back |
| Tunnel self-heals after the server end returns | yes, in under 45 s, no client action |

**Chaining is confirmed.** Karing routed a second proxy through the cover
tunnel, which is the property the whole design depends on.

The chain test deliberately avoided using a real GhostRoute channel as the
second hop, because the home router has no NAT loopback - reaching the home
public address from inside the house fails regardless of chaining, and would
have produced a false negative. Instead the second hop was a plain SOCKS5
proxy on a Docker-internal address with no route from the phone, so the only
possible path to it was out of the tunnel's far end.

| Check | Result |
|---|---|
| Karing exposes chaining | yes - Settings > Diversion > Front Proxy |
| Beginner mode hides it *and disables it silently* | yes - must be turned off first |
| Second hop reachable only via the tunnel | verified: no direct route from phone or host |
| Chained browsing works from the phone | yes |
| Killing the tunnel kills the chained path | yes - proves the chain is real, not a direct fallback |

Egress IP is identical with and without the tunnel here, because both ends sit
on the same home network, so every positive result had to be confirmed by
breaking the tunnel rather than by reading the IP.

### The creator belongs on the LAN, and chaining may be unnecessary

Testing the real topology surfaced a simpler design than the sub-layer sketch
above. If the creator runs at home, the tunnel has **already delivered the
endpoint home** - there is nothing left for Channel C/D to do, and pointing them
at the home public address from a home-resident creator just hits the missing
NAT loopback again.

Instead the creator is an ordinary LAN device, so its egress is already subject
to Channel A's LAN data plane: `STEALTH_DOMAINS` / `VPN_STATIC_NETS` ipset plus
the `PREROUTING` REDIRECT. The managed split applies with no client-side
chaining at all.

This was verified end to end. Through the tunnel, a non-managed destination came
back on the home WAN while `api.ipify.org`, the managed canary, came back on the
managed egress - the same split a normal LAN device gets.

**Hard requirement: the creator must resolve through the router.** The LAN split
is DNS-driven - dnsmasq resolves a managed name and inserts the answer into the
ipset, and only then does the REDIRECT match. Pointed at an external resolver
(`1.1.1.1`), managed destinations did not merely leak, they stopped working
altogether; pointed at the router they resolved and took the managed egress.
Any future Channel W creator config must pin router DNS.

Chaining, proven above, remains the fallback for a creator that is *not* on the
home LAN.

Still unverified, in rough order of risk:

- the real topology puts the SOCKS5 listener **on the phone** (olcbox is
  proxy-mode only on iOS), which introduces the routing loop: the client must
  send the cover app's own traffic direct, or it wraps its own transport;
- the phone side has not yet run over a real cellular network, only home Wi-Fi;
- whether a cover service actually survives whitelist mode - untestable on
  demand, since the regime only exists during a shutdown;
- the creator moved to a dedicated home machine rather than a laptop;
- account exposure for the RU cover services; the Jitsi path used here needed
  no account at all.

Two corrections to earlier assumptions came out of this run. `meet.jit.si` has
required a Google/GitHub/Facebook login to create a room since August 2023, so
"Jitsi needs no account" holds only for third-party instances. And of the 15
instances the project ships, several are already dead, which is a durability
warning for any cover service.

The lab lives outside this repo at `~/aiprojects/olcrtc-lab/` and carries its
own README with the trust assessment and the steps to move it to another host.

Known risks to record rather than discover later: unsigned `.ipa` requires
sideloading and re-signing every 7 days; one creator serves exactly one joiner;
the cover service account can hit CAPTCHA or be banned; a datacenter IP on the
creator side makes the cover call conspicuous.

## Survival Profile Track (Design Note)

Independent of any new transport, there is a cheap gap worth closing. A
`FINAL,PROXY` client profile sends everything to a dead home ingress during
whitelist mode, so even the permitted services break. A mode-specific profile
that keeps the permitted RU set DIRECT would leave government, banking and map
services usable while the tunnel is down.

Design notes for a future implementation:

- data source quality is the weak point. The main community whitelist repo is
  small and infrequently updated, so any generated profile must be cross-checked
  against the banking and government lists maintained by the larger Shadowrocket
  config projects, and must carry its snapshot date;
- generation belongs in `ansible/playbooks/30-generate-client-profiles.yml`
  under its own tag, next to the existing `shadowrocket_proof` and
  `shadowrocket_daily` artifacts. The C1-SR section is the pattern to follow;
- the RU whitelist is **client-side and mode-specific**. It must not be merged
  into `configs/dnsmasq-stealth.conf.add`, `configs/static-networks.txt` or
  `configs/domains-no-vpn.txt` - that would inflate the managed catalog with RU
  domains and break the curated foreign policy in
  [routing-policy-principles.md](routing-policy-principles.md);
- this profile is a **compatibility option only**, exactly as Layer 0 in
  `routing-policy-principles.md` allows. It must never become the daily profile
  or a proof profile, both of which stay `FINAL,PROXY`.

## Sources

Public references used for the mechanics above:

- Habr analyses of TSPU/DPI filtering, the two-level L3+L7 whitelist structure
  and the 16-20 KB cutoff observed in Moscow.
- `openlibrecommunity/olcrtc` and `kulikov0/whitelist-bypass` for the
  cover-service WebRTC transport and its iOS proxy mode.
- `kostfuciy/qWDTT` for the Android-only WireGuard-over-TURN variant.
- `kort0881/russia-whitelist` for the community reconstruction of the permitted
  domain set.
- `1andrevich/Re-filter-lists`, `oxystin/shadowrocket-configuration` and
  `misha-tgshv/shadowrocket-configuration-file` for RU rule-set formats.

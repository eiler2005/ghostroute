# ADR 0010: Channel A Selected Full-VPS

## Context

GhostRoute's default Channel A behavior is managed-domain split: selected
managed domains and static CIDRs use `reality-out`, while other destinations use
the home WAN. Some devices and Home Reality profiles need a stronger per-device
mode for YouTube, games or broad app compatibility where all internet-bound
traffic should use the active managed egress.

This requirement applies both to home Wi-Fi/LAN devices and to remote Channel A
Home Reality profiles. It must not turn Channel B or Channel C into automatic
fallbacks or make full-VPS global for all devices.

## Decision

Add Channel A selected full-VPS as an opt-in router-side policy override with
two independent selected sets:

- selected home Wi-Fi/LAN devices: reserved source IPs are captured with TPROXY
  into `channel-a-selected-lan-full-vps-in`, then routed to `reality-out`;
- selected Home Reality profiles: `reality-in` `auth_user` values route private
  destinations direct and all other internet-bound traffic to `reality-out`
  before the normal managed split.

Non-selected home devices and non-selected Home Reality profiles keep the
existing managed-domain split. Real MACs, reserved IPs, resolver IPs and profile
names stay in Vault or gitignored local files.

## Consequences

Selected full-VPS becomes a first-class Channel A capability, not a new channel.
It reuses the current Reality/Vision egress and therefore has the same
best-effort limits for UDP-heavy games over Reality/XUDP. If game NAT, jitter or
latency are poor, the next design should be a separate UDP-native gaming lane,
not broadening Channel B/C ownership or reviving WireGuard as normal production
state.


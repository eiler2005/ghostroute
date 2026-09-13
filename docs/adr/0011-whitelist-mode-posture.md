# ADR 0011: RU Mobile Whitelist Mode Posture

## Context

RU carriers can enter a whitelist regime on mobile data: only an approved set of
destinations is reachable, enforced as an L3 IP allowlist plus L7 SNI
inspection. Home Wi-Fi and wired links are unaffected.

Every GhostRoute managed channel is home-first and terminates at the same
residential home address, which is not in the allowlist. The emergency profile
targets the managed egress VPS, which is not in it either. Whitelist mode
therefore takes Channel A Home Reality, B, C, D and the emergency profile down
simultaneously, from a single shared cause. Reality/Vision does not help,
because the rejection happens at L3 before any SNI is presented.

Channel M is unaffected: it is router-initiated from the home WAN and has no
mobile leg.

The analysis and the option space are recorded in
[../whitelist-mode.md](../whitelist-mode.md).

## Decision

1. Whitelist mode does **not** become automatic failover for Channel A, B or C.
   This extends the existing rule that channels are explicit and never fail over
   to each other.
2. Any survival lane is a **new isolated Channel W**, opt-in and
   client-initiated, following the Channel B/C/M isolation model: its own port,
   credentials and playbook. It must not take over Channel A REDIRECT, router
   DNS, TUN or recovery ownership.
3. A survival transport is layered **under** the existing channels, not in place
   of them. The endpoint reaches home through the survival transport and then
   enters the normal router-owned managed split, so the router remains the
   policy engine and the carrier never sees `endpoint -> VPS`.
4. An **RU-hosted front hop inside the allowlist is rejected**. This is an
   operator decision based on legal and operational exposure, not a technical
   verdict, and it is recorded here so the option is not reopened by default.
5. The RU whitelist is **client-side, mode-specific data**. It must not be
   merged into `configs/dnsmasq-stealth.conf.add`, `configs/static-networks.txt`
   or `configs/domains-no-vpn.txt`.

## Consequences

GhostRoute accepts a known gap: during whitelist mode, mobile managed access is
unavailable and home Wi-Fi remains the working path. This is stated rather than
papered over, so incident diagnosis does not waste time on Reality, SNI rotation
or egress health when the real cause is carrier L3 filtering.

Keeping the whitelist data out of the managed catalogs preserves the curated
foreign policy: the managed catalog stays a foreign-service catalog, and RU
services stay on the home/RF path. A client-side RU-direct profile remains
permitted only as a Layer 0 compatibility option; daily and proof profiles stay
`FINAL,PROXY`.

Because the survival transport depends on riding permitted third-party services,
any implementation is best-effort and expected to break when those services
change. It must not acquire recovery responsibilities or appear in health checks
as a required component.

# Managed Egress Failover Roadmap

Status: future roadmap only. This document does not describe an implemented
runtime failover path.

## Summary

GhostRoute currently has one production managed foreign egress: router
`sing-box` sends managed destinations through `reality-out` to the primary VPS.
If that VPS becomes unavailable, the router-managed path for foreign managed
domains can fail even though the home router, LAN and direct home-WAN traffic
are still healthy.

The future target is a semi-automatic backup egress for managed domains:

```text
Home LAN / Home Reality / Channel B / Channel C
  -> home router
  -> existing managed split
       managed destinations     -> active Reality egress -> foreign VPS
       non-managed destinations -> direct-out via home WAN
```

The router remains the policy owner. `STEALTH_DOMAINS` and `VPN_STATIC_NETS`
continue to define what is managed; failover only changes which foreign egress
is used for managed traffic.

## Target V1

- Add a second managed outbound on the router. The long-term owned target is a
  backup `VLESS + Reality/Vision` VPS, but the first practical v1 candidate is
  a Red Shield `VLESS (XTLS)` profile if the router's `sing-box` accepts it.
- Keep the current primary VPS as the normal default egress.
- Prefer a backup VPS on a different provider and ASN from the primary Hetzner
  host for the owned long-term target.
- Use the existing router health-monitor model as the decision source, because
  the router is the system that actually experiences "primary VPS unavailable".
- Keep failover semi-automatic with a latch: once backup is selected, stay on
  backup until the operator explicitly returns to primary.

Recommended logical shape:

```text
reality-primary -> current primary VPS
reality-backup  -> backup managed egress, initially Red Shield VLESS (XTLS)
reality-out     -> stable logical managed-egress tag used by route rules
```

The exact sing-box implementation can use a selector, generated active tag or a
small controlled config switch, but the operator-facing contract should be the
same: one active managed egress at a time, with explicit state and rollback.

## Concrete V1 Direction: Red Shield VLESS Backup

The first implementation plan should evaluate Red Shield `VLESS (XTLS)` as the
fastest backup egress candidate. This is not because Red Shield is the final
architecture, but because it can prove the router-side failover logic before
provisioning and operating a second owned VPS.

Protocol choice:

- Prefer Red Shield `VLESS (XTLS)` over AmneziaWG, WireGuard, OpenVPN,
  AmneziaWG legacy and PPTP for v1.
- Reason: VLESS-like client profiles map naturally to router `sing-box`
  outbounds, while WireGuard/OpenVPN-style options would reintroduce kernel VPN
  interfaces, policy-routing state and rollback risks that GhostRoute already
  retired from steady state.
- The backup profile must be dedicated to the router. Do not reuse the same
  provider configuration on phones, laptops or other clients.

Router logic target:

- Keep the route contract stable: managed rules still point to `reality-out`.
- Add `reality-primary` for the current VPS and `reality-backup` for the backup
  provider profile. If the backup transport is not Reality, the tag is still a
  compatibility name for the existing routing contract, not a claim about the
  provider protocol.
- Add local-only probe paths for both egresses so the router can test primary
  and backup without moving production traffic first.
- The controller may switch only after repeated primary failures and positive
  backup proof. First thresholds remain:

```text
primary_fail_count >= 3
backup_success_count >= 2
switch mode = latch
auto-return = disabled
```

- After switching to backup, the controller records a latch state. Return to
  primary is manual only.
- If both primary and backup are unhealthy, do not switch blindly; emit a
  critical alert and preserve the current state.

Operator surface:

- Future router command shape:
  `/jffs/scripts/managed-egress-failover status|dry-run|switch-backup|switch-primary|run-controller`.
- Future state directory:
  `/jffs/addons/router_configuration/managed-egress/state`.
- `dry-run` must explain the decision evidence without mutating `sing-box`,
  dnsmasq or firewall state.

Secrets and public docs:

- Store Red Shield URI/profile material only in Ansible Vault or another
  gitignored secret store.
- Public docs must use placeholders only. Do not commit real provider hostnames,
  UUIDs, short IDs, keys, ports, subscription URLs, generated VLESS URIs or
  account identifiers.
- Prefer an IP literal or cached last-known-good address for the backup server
  during probes so failover does not depend on DNS that may currently be routed
  through the failed primary path.

## Monitoring And Switch Criteria

Primary failure should require repeated evidence, not one transient timeout:

- primary active proxy/curl check fails repeatedly;
- router cannot open or use the primary Reality path;
- no recent successful primary `reality-out` traffic evidence exists;
- local router `sing-box` and home WAN are not the real fault.

Backup activation should require positive proof:

- backup VPS TCP/443 is reachable from the router;
- backup Reality exit probe succeeds;
- a managed canary such as `api.ipify.org` exits through the backup path.

Recommended first thresholds:

```text
primary_fail_count >= 3
backup_success_count >= 2
switch mode = latch
auto-return = disabled
```

If both primary and backup are unhealthy, the router must not switch blindly.
It should keep a clear critical alert and avoid hiding the incident behind a
partial recovery attempt.

## DNS Emergency Policy

Backup mode is an availability mode. Its first goal is that managed services
such as YouTube continue to work, not that BrowserLeaks fingerprinting remains
perfect.

For v1:

- do not expose public DNS on the backup VPS;
- do not open public `53/tcp`, `53/udp` or an unrestricted resolver port;
- use availability-first DNS in backup mode, so managed DNS does not depend on
  the primary VPS Unbound path while the primary VPS is the suspected fault;
- allow DNS consistency to be imperfect during an emergency if that keeps
  internet access working;
- treat private backup DNS over the backup Reality path as a later optional
  phase, not as a v1 requirement.

This deliberately differs from normal policy-split DNS, where managed foreign
domains try to use a consistent VPS-side DNS path. During backup incidents,
availability is allowed to win over resolver geography cleanliness.

Implementation implication for v1: switching to backup should temporarily
demote or empty the generated managed-VPS-DNS include and restart dnsmasq, then
restore the normal generated include during manual switchback to primary.

## Non-Goals

- Do not make Channel B or Channel C automatic fallbacks for Channel A.
- Do not resurrect legacy WireGuard as a normal runtime path.
- Do not implement full automatic return to primary; avoid flapping.
- Do not open a public DNS resolver on the backup VPS.
- Do not move managed-vs-direct policy from the router to endpoint profiles.
- Do not treat this as a replacement for the existing home-first channel model.
- Do not commit or paste real Red Shield account, subscription or VLESS profile
  details into tracked docs, tests, commits or chat transcripts.

## Future Implementation Phases

1. Document and store backup provider profile material outside git.
2. Validate that the router `sing-box` version accepts the Red Shield
   `VLESS (XTLS)` profile shape. If not, stop and reassess Xray sidecar or an
   owned second VPS.
3. Add router-side backup outbound rendering while keeping managed split rules
   unchanged.
4. Extend health monitor probes for primary and backup egress evidence.
5. Add a dry-run switch report that explains whether failover would happen.
6. Add the latched semi-auto switch command and explicit manual switchback.
7. Add availability-first backup DNS handling.
8. Run a live drill by blocking the primary VPS path and confirming backup
   managed egress without changing direct/RU/default traffic.
9. Later, if desired, replace or supplement Red Shield with an owned second
   `VLESS + Reality/Vision` VPS on a different provider/ASN.

## Acceptance Scenarios

- Primary healthy: managed traffic uses the primary VPS.
- Primary down and Red Shield backup healthy: managed traffic switches to
  backup.
- Primary and backup down: no unsafe switch; clear critical alert is emitted.
- Direct, RU and default traffic remain on home WAN unless explicitly managed.
- Backup mode remains active until a manual switchback.
- Verification confirms no Channel B/C automatic failover and no WireGuard
  resurrection.
- Backup DNS mode does not depend on primary VPS Unbound and is restored during
  manual switchback to primary.

## Future Test Plan

When implementation starts, add focused static and fixture tests for:

- `sing-box` outbound tags: `reality-primary`, `reality-backup` and stable
  logical `reality-out`;
- unchanged managed/direct split for LAN, Home Reality, Channel B and Channel C;
- no `wgs1`, `wgc1`, `RC_VPN_ROUTE`, `VPN_DOMAINS` or `0x1000` resurrection;
- backup DNS mode demoting only the generated managed-VPS-DNS include, not the
  source catalogs;
- failover latch behavior, dry-run verdicts, both-down behavior and manual
  switchback.

## Related Docs

- [architecture.md](architecture.md)
- [channels.md](channels.md)
- [dns-policy.md](dns-policy.md)
- [future-improvements-backlog.md](future-improvements-backlog.md)
- [routing-policy-principles.md](routing-policy-principles.md)

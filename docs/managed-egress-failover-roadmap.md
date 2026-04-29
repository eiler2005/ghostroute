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
continue to define what is managed; failover only changes which foreign VPS is
used for managed egress.

## Target V1

- Add a second `VLESS + Reality/Vision` outbound on the router for a backup
  foreign VPS.
- Keep the current primary VPS as the normal default egress.
- Prefer a backup VPS on a different provider and ASN from the primary Hetzner
  host.
- Use the existing router health-monitor model as the decision source, because
  the router is the system that actually experiences "primary VPS unavailable".
- Keep failover semi-automatic with a latch: once backup is selected, stay on
  backup until the operator explicitly returns to primary.

Recommended logical shape:

```text
reality-primary -> current primary VPS
reality-backup  -> backup foreign VPS
managed-egress  -> selected active Reality outbound
```

The exact sing-box implementation can use a selector, generated active tag or a
small controlled config switch, but the operator-facing contract should be the
same: one active managed egress at a time, with explicit state and rollback.

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
- allow DNS consistency to be imperfect during an emergency if that keeps
  internet access working;
- treat private backup DNS over the backup Reality path as a later optional
  phase, not as a v1 requirement.

This deliberately differs from normal policy-split DNS, where managed foreign
domains try to use a consistent VPS-side DNS path. During backup incidents,
availability is allowed to win over resolver geography cleanliness.

## Non-Goals

- Do not make Channel B or Channel C automatic fallbacks for Channel A.
- Do not resurrect legacy WireGuard as a normal runtime path.
- Do not implement full automatic return to primary; avoid flapping.
- Do not open a public DNS resolver on the backup VPS.
- Do not move managed-vs-direct policy from the router to endpoint profiles.
- Do not treat this as a replacement for the existing home-first channel model.

## Future Implementation Phases

1. Document and provision backup VPS secrets outside git.
2. Add backup Reality/Vision server deployment with separate credentials,
   hostname/SNI and verification.
3. Add router-side backup outbound rendering while keeping managed split rules
   unchanged.
4. Extend health monitor probes for primary and backup egress evidence.
5. Add a dry-run switch report that explains whether failover would happen.
6. Add the latched semi-auto switch command and explicit manual switchback.
7. Run a live drill by blocking the primary VPS path and confirming backup
   managed egress without changing direct/RU/default traffic.

## Acceptance Scenarios

- Primary healthy: managed traffic uses the primary VPS.
- Primary down and backup healthy: managed traffic switches to backup.
- Primary and backup down: no unsafe switch; clear critical alert is emitted.
- Direct, RU and default traffic remain on home WAN unless explicitly managed.
- Backup mode remains active until a manual switchback.
- Verification confirms no Channel B/C automatic failover and no WireGuard
  resurrection.

## Related Docs

- [architecture.md](architecture.md)
- [channels.md](channels.md)
- [dns-policy.md](dns-policy.md)
- [future-improvements-backlog.md](future-improvements-backlog.md)
- [routing-policy-principles.md](routing-policy-principles.md)

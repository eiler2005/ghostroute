# Channel M: Regional Service Policy

Channel M isolates applications that require an approved country or region of
egress. It is separate from the managed client channels and is not their failover.

## Public contract

- Scope is selected service traffic, including the application's required API
  and content endpoints.
- The operator approves the regional egress and verifies application behavior
  before assigning traffic to it.
- Credentials, application names, geography, infrastructure mapping and detailed
  recovery steps remain in private operator configuration and recovery material.
- Channel M keeps independent policy and recovery ownership. It must not take
  over Channel A/B/C/D routing, LAN/Wi-Fi classification or shared DNS.
- A service-path failure is reported as degraded; it does not authorize an
  unqualified egress change or a change to unrelated client routes.

## Verification and recovery

Verify the selected application's actual requests and required content against
the approved regional policy. Listener availability alone is not application
acceptance. Preserve the existing channel contracts when performing scoped
recovery, and record deployment-specific evidence only in ignored local reports.

The private operator runbook owns exact commands, resource identities and
credentials. Public source-level interfaces retain compatibility; this overview
does not rename runtime fields or migrate client profiles.

See [routing policy principles](routing-policy-principles.md),
[channel boundaries](channels.md) and the
[egress qualification rule](../modules/ghostroute-health-monitor/docs/egress-qualification.md).

# GhostRoute Architecture Decision Records

ADRs capture stable architectural decisions that should survive refactors,
handoffs and incident response. They are intentionally short.

Use an ADR when a decision changes or protects one of these surfaces:

- production routing behavior;
- router/VPS runtime layout;
- security or secret handling;
- public repo command structure;
- operational monitoring and recovery contracts.

Each ADR uses:

- Context
- Decision
- Consequences

Long implementation details stay in module docs and runbooks.

## Records

- `0001-module-native-repo.md`
- `0002-scripts-reserved-policy.md`
- `0003-local-only-health-alerts.md`
- `0004-deprecated-wireguard-cold-fallback.md`
- `0005-secrets-outside-git.md`
- `0006-channel-terminology-and-manual-fallbacks.md`
- `0007-channel-b-production-channel-c-planned.md`

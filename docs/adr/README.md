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

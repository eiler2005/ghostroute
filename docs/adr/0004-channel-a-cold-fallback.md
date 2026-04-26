# ADR 0004: Channel A Is Cold Fallback Only

## Context

The old WireGuard Channel A path was retired from normal operation. Some NVRAM
state is intentionally preserved so a manual emergency fallback remains
possible.

## Decision

Channel A runtime must stay disabled during normal operation. `wgs1`/`wgc1`
interfaces, legacy marks, legacy ipsets and Channel A hooks are treated as
drift when they appear in runtime checks. Cold fallback may be enabled only by a
human operator during a severe incident.

## Consequences

The production path remains Reality-first. Recovery tooling must verify that
Channel A has not silently returned, while preserving enough state for explicit
manual fallback.

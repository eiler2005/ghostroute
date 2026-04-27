# ADR 0004: Previously Used Deprecated WireGuard Is Cold Fallback Only

## Context

The previously used WireGuard path was deprecated and retired from normal
operation. Some NVRAM state is intentionally preserved so a manual emergency
cold fallback remains possible.

## Decision

Deprecated WireGuard runtime must stay disabled during normal operation.
`wgs1`/`wgc1` interfaces, legacy marks and legacy ipsets are treated as drift
when they appear in runtime checks. Cold fallback may be enabled only by a
human operator during a severe incident.

## Consequences

The production path remains Channel A Reality-first. Recovery tooling must
verify that previously used deprecated WireGuard has not silently returned,
while preserving enough state for explicit manual fallback.

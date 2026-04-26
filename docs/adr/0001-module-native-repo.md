# ADR 0001: Module-Native Repository

## Context

GhostRoute started as a practical operational repo with many top-level scripts.
As the system grew, the script list no longer explained ownership or runtime
boundaries clearly enough.

## Decision

Module-owned code lives under `modules/<module>/`. Public module commands live
under `modules/<module>/bin`, router runtime scripts under
`modules/<module>/router`, VPS scripts under `modules/<module>/vps`, and shared
helpers under `modules/shared/lib`.

Root-level entrypoints are reserved for platform orchestration such as
`deploy.sh` and `verify.sh`.

## Consequences

Ownership is visible from the path. Module tests and docs can evolve with the
code they describe. Existing runtime paths on the router and VPS remain stable.

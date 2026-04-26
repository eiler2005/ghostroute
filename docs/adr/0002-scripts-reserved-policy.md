# ADR 0002: `scripts/` Is Reserved For Common Utilities

## Context

The historical `scripts/` directory used to contain module commands and aliases.
That made the repository look like a flat script collection instead of a
modular operational platform.

## Decision

`scripts/` is reserved for cross-repo utilities that do not have a clear module
owner. It is not a compatibility-wrapper layer and must not contain shortcuts
for module commands.

## Consequences

New module commands must be placed in the owning module. Documentation should
reference module-native paths directly. The policy keeps command ownership
auditable and prevents a second public CLI surface from drifting.

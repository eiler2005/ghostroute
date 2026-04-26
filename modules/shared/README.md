# Shared Helpers Module Overview

## Purpose

Shared Helpers contains internal libraries used by multiple GhostRoute modules.
It is a support component rather than a user-facing operational module.

## Features

- Router SSH/environment helpers.
- Health report parsing and rendering helpers.
- Device-label loading and redaction helpers.

## How It Works

Module commands source shared shell libraries directly from
`modules/shared/lib`. There is no public import path for these helpers.

## Architecture

- `lib/router-health-common.sh` is shared by verification, health and traffic
  reports.
- `lib/device-labels.sh` is shared by traffic and DNS forensics reports.

## Read-only / Mutating Contract

Shared helpers inherit the contract of the caller. Helper changes must stay
BusyBox-safe where they are sourced by router-facing scripts.

## Public Commands

- None.

## Runtime Storage & Artifacts

- None directly.

## Dependencies On Other Modules

- Used by Health Monitor, Traffic Observatory, DNS & Catalog Intelligence and
  Recovery & Verification.

## Failure Modes

- A helper API change can break several modules at once.
- Non-BusyBox shell syntax can break router-side consumers.
- Device metadata parsing mistakes can leak names unless redaction defaults hold.

## Tests

- `./tests/run-all.sh`
- Syntax checks for module commands that source the helpers.

## Related Docs

- `modules/traffic-observatory/docs/traffic-observability.md`
- `modules/secrets-management/docs/secrets-management.md`

# Recovery & Verification Toolkit Module Overview

## Purpose

Recovery & Verification provides live invariant checks, incident triage and
controlled manual fallback procedures for Reality, VPS, DNS and routing drift.

## Features

- Platform health gate through root `./verify.sh`.
- Module-native verification implementation in `bin/verify.sh`.
- Static architecture/security audit through `bin/audit-fixes`.
- Manual cold fallback tooling for catastrophic Reality outage.
- Fixture tests for router health parsing and rendering.

## How It Works

`./verify.sh` is the top-level operator command. It delegates to the module
implementation, which reads router state through SSH, checks routing invariants
and prints a compact health summary by default.

## Architecture

- `bin/verify.sh` contains the verification implementation.
- `router/` contains manual fallback tooling installed to `/jffs/scripts`.
- `tests/` contains local fixture tests.

## Read-only / Mutating Contract

Verification is read-only. Fallback scripts are mutating and must be run only by
an operator after reading the relevant runbook.

## Public Commands

- `./verify.sh`
- `./verify.sh --verbose`
- `./modules/recovery-verification/bin/verify.sh`
- `./modules/recovery-verification/bin/audit-fixes`
- Runtime-only router fallback: `/jffs/scripts/emergency-enable-wgc1.sh`

## Runtime Storage & Artifacts

- Verification stdout.
- Router runtime state.
- Cold fallback state controlled by ASUS NVRAM and Merlin hooks.

## Dependencies On Other Modules

- Routing Core provides the runtime state being verified.
- Health Monitor supplies status summaries for incident workflows.
- DNS & Catalog Intelligence and Traffic Observatory provide supporting context.

## Failure Modes

- Reality/VPS path unavailable.
- Rule-set drift or missing cron hooks.
- WireGuard fallback unexpectedly active.
- IPv6, DNS or direct traffic leaks.

## Tests

- `./modules/recovery-verification/tests/test-router-health.sh`
- `./modules/recovery-verification/tests/test-audit-fixes.sh`
- `./tests/run-all.sh`
- Ansible `playbooks/99-verify.yml`

## Related Docs

- `modules/recovery-verification/docs/failure-modes.md`
- `docs/archive/roadmaps/architecture-improvement-roadmap-2026-04-26.md`
- `docs/adr/`
- `docs/troubleshooting.md`
- `modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md`
- `modules/routing-core/docs/channel-routing-operations.md`

# Recovery & Verification Toolkit Module Overview

## Purpose

Recovery & Verification provides live invariant checks, incident triage and
controlled manual fallback procedures for Reality, VPS, DNS and routing drift.

## Architecture

`bin/verify.sh` is the local verification entrypoint. `router/` contains manual
fallback tooling installed to `/jffs/scripts` by deploy. Tests and fixtures
cover renderer/parser contracts used by verification reports.

## Contract

Verification is read-only by default. Fallback scripts are explicitly mutating
and should be run only by an operator after reading the relevant runbook.

## Commands And Storage

- Public wrappers: `verify.sh`, `scripts/emergency-enable-wgc1.sh`.
- Ansible playbook: `ansible/playbooks/99-verify.yml`.
- Artifacts: verification output and router runtime state.
- Related docs: `docs/failure-modes.md`, `docs/troubleshooting.md`,
  `docs/stealth-monitor-runbook.md`, `docs/channel-routing-operations.md`.
- Tests: `modules/recovery-verification/tests/test-router-health.sh`, also
  exposed through `tests/test-router-health.sh`.

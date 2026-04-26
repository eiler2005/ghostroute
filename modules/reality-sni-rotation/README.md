# Reality SNI Rotation Guide Module Overview

## Purpose

Reality SNI Rotation documents how to validate, rotate and roll back Reality
cover SNI choices without leaking production values into public docs.

## Features

- Candidate review workflow for cover SNI choices.
- Compatibility and regional reachability checks.
- Rollback-oriented deployment checklist.
- Secret hygiene rules for public docs and generated profiles.

## How It Works

The module is documentation-led. Operators validate candidate cover names,
update Vault-held Reality values, regenerate configs/profiles and verify both
router and VPS health before considering the rotation complete.

## Architecture

- Runtime values live in Ansible Vault.
- Generated client artifacts stay outside git.
- Verification is performed by Recovery & Verification and Health Monitor.

## Read-only / Mutating Contract

Candidate review is read-only. Rotation is mutating and requires explicit
operator approval, Vault edits, deploy and rollback readiness.

## Public Commands

- No standalone command in v1.
- Use documented Ansible/Vault workflows plus `./verify.sh`.

## Runtime Storage & Artifacts

- Ansible Vault values.
- Gitignored generated client profiles.
- Health monitor reports after rotation.

## Dependencies On Other Modules

- Secrets Management protects SNI and endpoint values.
- Client Profile Factory regenerates QR/VLESS artifacts.
- Health Monitor and Recovery Verification confirm live behavior.

## Failure Modes

- Candidate SNI unreachable from target networks.
- Rotation applied to VPS but not client profiles.
- Rollback values missing or not documented privately.
- Public docs accidentally exposing real endpoints.

## Tests

- Ansible syntax checks.
- `./verify.sh`
- Health monitor live report after deploy.

## Related Docs

- `docs/sni-rotation-candidates.md`
- `docs/secrets-management.md`
- `docs/stealth-channel-implementation-guide.md`

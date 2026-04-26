# Reality SNI Rotation Guide Module Overview

## Purpose

Reality SNI Rotation documents how to validate, rotate and roll back Reality
cover SNI choices without leaking production values into public docs.

## Architecture

This module is documentation-led. Runtime values live in Ansible Vault and
generated client artifacts stay outside git.

## Contract

SNI rotation is mutating and requires explicit operator approval. Validation and
candidate review are read-only until the Vault/deploy step.

## Commands And Storage

- Public workflow: documented Ansible/Vault commands, no standalone command.
- Storage: Ansible Vault and gitignored generated client artifacts.
- Related docs: `docs/sni-rotation-candidates.md`,
  `docs/secrets-management.md`,
  `docs/stealth-channel-implementation-guide.md`.
- Tests: covered by Ansible syntax and post-rotation health verification.

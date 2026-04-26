# Secrets Management Module Overview

## Purpose

Secrets Management protects Vault values, generated artifacts, local reports
and public docs from accidental credential or production endpoint exposure.

## Architecture

`bin/init-stealth-vault.sh` bootstraps Vault templates. `bin/secret-scan` is the
repo-specific pre-push scanner. Public wrappers remain in `scripts/`.

## Contract

Real credentials, UUIDs, keys, public endpoints and production literals must
stay in Vault, local secrets, runtime storage or gitignored reports. Public docs
use placeholders.

## Commands And Storage

- Public wrappers: `scripts/init-stealth-vault.sh`, `scripts/secret-scan`.
- Private storage: `secrets/`, `ansible/secrets/`, `configs/private/`,
  `docs/private/`, `reports/`.
- Related docs: `docs/secrets-management.md`.
- Tests: `scripts/secret-scan`, plus repository-wide static checks.

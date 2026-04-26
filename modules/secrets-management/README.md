# Secrets Management Module Overview

## Purpose

Secrets Management protects Vault values, generated artifacts, local reports and
public docs from accidental credential or production endpoint exposure.

## Features

- Vault bootstrap helper.
- Repo-specific secret scanner.
- Rules for local/private files and generated artifacts.
- Public documentation placeholders for sensitive values.

## How It Works

Vault and local private directories hold real secrets. The scanner checks tracked
and untracked candidate files for real IPs, UUIDs, keys, VLESS URIs and known
production literals before commit/push.

## Architecture

- `bin/init-stealth-vault.sh` bootstraps Vault templates.
- `bin/secret-scan` performs repository hygiene checks.
- `.gitignore` keeps generated credentials and reports out of public history.

## Read-only / Mutating Contract

Scanning is read-only. Vault bootstrap and edits are local/private mutations.
Secrets must never be moved into tracked docs or module READMEs.

## Public Commands

- `./modules/secrets-management/bin/init-stealth-vault.sh`
- `./modules/secrets-management/bin/secret-scan`

## Runtime Storage & Artifacts

- `secrets/`
- `ansible/secrets/`
- `configs/private/`
- `docs/private/`
- `reports/`
- `ansible/out/clients*`

## Dependencies On Other Modules

- Client Profile Factory depends on Vault values.
- Reality SNI Rotation depends on private endpoint/SNI values.
- Traffic and DNS reports depend on local redacted device metadata.

## Failure Modes

- Real endpoint or port leaked into public docs.
- Generated QR/client artifact staged for git.
- Vault value referenced directly instead of through a placeholder.
- Scanner allowlist widened without review.

## Tests

- `./modules/secrets-management/bin/secret-scan`
- `./tests/run-all.sh`

## Related Docs

- `modules/secrets-management/docs/secrets-management.md`

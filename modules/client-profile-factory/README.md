# Client Profile Factory Module Overview

## Purpose

Client Profile Factory generates and cleans local QR/VLESS profiles from
Ansible Vault for router identity, home-mobile clients and emergency profiles.

## Features

- Generates local VLESS `.conf` files and QR images.
- Separates router, home-mobile and emergency profile flows.
- Opens local HTML indexes for operator use.
- Cleans generated artifacts without touching Vault.

## How It Works

The module entrypoint delegates generation to the existing Ansible playbook,
then lists, opens or removes gitignored artifacts under `ansible/out`. Generated
credentials never become tracked repo content.

## Architecture

- `bin/client-profiles` is the local control-machine command.
- Ansible owns profile rendering templates.
- Output directories are ignored by git.

## Read-only / Mutating Contract

Listing and opening artifacts are read-only. Generating and cleaning profiles
mutate only local generated files. Router/VPS runtime changes require the
explicit Ansible workflow.

## Public Commands

- `./modules/client-profile-factory/bin/client-profiles generate`
- `./modules/client-profile-factory/bin/client-profiles list`
- `./modules/client-profile-factory/bin/client-profiles home-list`
- `./modules/client-profile-factory/bin/client-profiles emergency-list`
- `./modules/client-profile-factory/bin/client-profiles clean`

## Runtime Storage & Artifacts

- `ansible/out/clients`
- `ansible/out/clients-home`
- `ansible/out/clients-emergency`

## Dependencies On Other Modules

- Secrets Management stores Vault values and enforces generated-artifact rules.
- Reality SNI Rotation may require profile regeneration.
- Recovery & Verification confirms generated profiles match live routing.

## Failure Modes

- Missing Vault values.
- Generated QR files accidentally staged for git.
- Profile regeneration not followed by live verification.
- Emergency profiles confused with home-mobile profiles.

## Tests

- Syntax checks.
- `./modules/secrets-management/bin/secret-scan`
- Ansible profile playbook syntax checks.

## Related Docs

- `modules/client-profile-factory/docs/client-profiles.md`
- `docs/getting-started.md`
- `modules/secrets-management/docs/secrets-management.md`

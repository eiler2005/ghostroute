# Client Profile Factory Module Overview

## Purpose

Client Profile Factory generates and cleans local QR/VLESS profiles from
Ansible Vault for router identity, home-mobile clients and emergency profiles.

## Architecture

The control-machine implementation lives in `bin/client-profiles`. It delegates
profile generation to the existing Ansible playbook and opens or cleans local
gitignored artifacts.

## Contract

Profile generation is local artifact creation. Credentials and QR outputs must
stay outside git. Runtime router/VPS state changes happen only through the
explicit Ansible profile-generation workflow.

## Commands And Storage

- Public wrapper: `scripts/client-profiles`.
- Ansible playbook: `ansible/playbooks/30-generate-client-profiles.yml`.
- Artifacts: `ansible/out/clients*`, all gitignored.
- Related docs: `docs/client-profiles.md`, `docs/getting-started.md`,
  `docs/secrets-management.md`.
- Tests: syntax checks and secret-scan coverage.

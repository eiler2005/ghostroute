# GhostRoute Console Observability V2 Implementation Plan

## Phase 0: Branch And Baseline

- Create `feature/console-observability-v2`.
- Record current Console architecture, data contracts and safety boundaries.
- Confirm the worktree is clean or preserve existing changes without reverting
  them.
- No code behavior changes in this phase.

Checks:

- `git status --short --branch`
- Documentation review for secrets and production values.

## Phase 1: Architecture Documents

- Add the v2 architecture document.
- Add AI review notes and corrections.
- Add implementation and commit plans.
- Keep public docs stable and sanitized.

Checks:

- `rg` review for real endpoints, credentials, UUIDs, QR/VLESS payloads and
  production literals in new docs.

## Phase 2: SQLite V5 Read Models

- Add additive v5 schema in both server store and collector normalizer.
- Add model rebuild helpers for:
  - flow sessions
  - DNS query log
  - device inventory
  - alarm events
  - read model state
  - non-secret console settings
- Extend tests to assert v5 tables and a small fixture rebuild.
- Keep v4 tables intact.

Checks:

- `cd modules/ghostroute-console/app && npm test`
- `./modules/ghostroute-console/tests/test-json-contracts.sh`

Rollback:

- Revert schema/read-model commit.
- If a local runtime DB is unusable, quarantine and rebuild from raw snapshots.

## Phase 3: Selectors And APIs

- Add paged selectors backed by v5 tables.
- Add or update APIs:
  - `/api/flows`
  - `/api/dns`
  - `/api/clients`
  - `/api/alarms`
  - `/api/dashboard`
  - `/api/live`
  - `/api/reports/llm-safe`
- Add cache helpers with snapshot-version and TTL invalidation.
- Keep raw evidence excluded from normal API responses unless explicitly
  requested through existing gated export/detail routes.

Checks:

- `cd modules/ghostroute-console/app && npm test`
- API smoke through Playwright request tests.

Rollback:

- Revert selector/API commit; v4 pages remain available.

## Phase 4: GUI Refresh

- Replace Console shell styling with the dense dark operational layout from
  the target screens.
- Keep the first screen as the real app, not a landing page.
- Add page-level UI for Dashboard, Flow Explorer, DNS Query Log, Clients,
  Health/Alarm Center, Catalog, Budget, Live, Reports/Redaction and Settings.
- Use existing `lucide-react` icons.
- Avoid mock production data; empty factual states stay explicit.

Checks:

- `cd modules/ghostroute-console/app && npm run build`
- `cd modules/ghostroute-console/app && npm run test:e2e`
- `cd modules/ghostroute-console/app && npm run test:perf`

Rollback:

- Revert GUI commits while keeping data model if already stable.

## Phase 5: Documentation And Final Local Verification

- Update Console README and architecture docs.
- Update roadmap/operational module references only where needed.
- Run narrow checks first, then broader checks before deployment.

Checks:

- `cd modules/ghostroute-console/app && npm test`
- `cd modules/ghostroute-console/app && npm run build`
- `cd modules/ghostroute-console/app && npm run test:e2e`
- `cd modules/ghostroute-console/app && npm run test:perf`
- `./modules/ghostroute-console/tests/test-json-contracts.sh`
- `./tests/run-all.sh`
- `./modules/secrets-management/bin/secret-scan`

## Phase 6: Console-Only Deployment

Deploy only after all local checks pass.

Allowed deployment target for this feature:

```bash
ansible-playbook modules/ghostroute-console/vps/deploy-readonly.yml
```

Optional public listener verification, only if the existing listener needs
validation:

```bash
ansible-playbook modules/ghostroute-console/vps/expose-caddy-readonly.yml
```

Do not run root `deploy.sh` or routing playbooks for this feature.

Post-deploy checks:

- Local Console container health endpoint.
- Public Basic Auth health endpoint.
- Dashboard, flows, DNS, clients, live and reports APIs.
- `./verify.sh` as read-only routing health confirmation.
- Container logs for collector errors.


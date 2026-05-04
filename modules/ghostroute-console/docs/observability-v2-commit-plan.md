# GhostRoute Console Observability V2 Commit Plan

Each commit should be small enough to review and roll back independently.

## Commit 1: Baseline Docs

Message:

```text
docs(console): capture observability v2 baseline
```

Changes:

- Add current-state, architecture, AI-review, implementation and commit plan
  documents.

Verify:

- `git status --short --branch`
- Manual secret scan of docs with `rg`.

Rollback:

- Revert the docs commit.

## Commit 2: SQLite V5 Schema

Message:

```text
feat(console): add observability v2 read model schema
```

Changes:

- Add additive schema to server store and collector normalizer.
- Add indexes for period, route, client, destination, risk and status.
- Add model state table.

Verify:

- `cd modules/ghostroute-console/app && npm test`

Rollback:

- Revert commit. Existing v4 tables and raw snapshots remain valid.

## Commit 3: Read Model Rebuild

Message:

```text
feat(console): materialize flow dns device and alarm views
```

Changes:

- Rebuild `flow_sessions`, `dns_query_log`, `device_inventory` and
  `alarm_events` from normalized evidence.
- Update collector calls to refresh read models after snapshot normalization.
- Add fixture assertions.

Verify:

- `cd modules/ghostroute-console/app && npm test`
- `./modules/ghostroute-console/tests/test-json-contracts.sh`

Rollback:

- Revert commit. Quarantine/rebuild runtime SQLite only if needed.

## Commit 4: Cached Selectors And APIs

Message:

```text
feat(console): serve observability views from cached read models
```

Changes:

- Add paged read-model selectors.
- Add `/api/dns` and `/api/alarms`.
- Update dashboard, live, flows and clients APIs.
- Add cache invalidation by snapshot version and TTL.

Verify:

- `cd modules/ghostroute-console/app && npm test`
- API smoke in Playwright.

Rollback:

- Revert commit.

## Commit 5: Flow Explorer And DNS UI

Message:

```text
feat(console): add flow explorer and dns query log screens
```

Changes:

- Refresh `/traffic` as Flow Explorer.
- Add `/dns` page and navigation entry.
- Add route explanation drawer/details using factual evidence.

Verify:

- `cd modules/ghostroute-console/app && npm run build`
- `cd modules/ghostroute-console/app && npm run test:e2e`

Rollback:

- Revert commit.

## Commit 6: Device And Alarm UI

Message:

```text
feat(console): upgrade device inventory and alarm center
```

Changes:

- Rebuild Clients as Device Inventory.
- Rebuild Health as Alarm Center plus probe detail.
- Wire ack/snooze actions to alarm rows without deleting evidence.

Verify:

- `cd modules/ghostroute-console/app && npm test`
- `cd modules/ghostroute-console/app && npm run test:e2e`

Rollback:

- Revert commit.

## Commit 7: Dashboard Budget Live Reports Settings UI

Message:

```text
feat(console): refresh dashboard live budget reports and settings
```

Changes:

- Dashboard status/traffic/topology/actions.
- Budget quotas and threshold alarms.
- Live troubleshooting mode.
- Reports redaction mode.
- Settings for collector/data source/runtime settings.

Verify:

- `cd modules/ghostroute-console/app && npm run build`
- `cd modules/ghostroute-console/app && npm run test:e2e`
- `cd modules/ghostroute-console/app && npm run test:perf`

Rollback:

- Revert commit.

## Commit 8: Docs And Final Verification

Message:

```text
docs(console): document observability v2 rollout
```

Changes:

- Update Console README and stable architecture docs.
- Update test/deploy notes.

Verify:

- `./modules/ghostroute-console/tests/test-json-contracts.sh`
- `cd modules/ghostroute-console/app && npm test`
- `cd modules/ghostroute-console/app && npm run build`
- `cd modules/ghostroute-console/app && npm run test:e2e`
- `cd modules/ghostroute-console/app && npm run test:perf`
- `./tests/run-all.sh`
- `./modules/secrets-management/bin/secret-scan`

Rollback:

- Revert docs commit.

## Deployment Commit Boundary

Deployment happens only after the final local verification is green. Deployment
does not require a separate routing commit because this feature is Console-only.


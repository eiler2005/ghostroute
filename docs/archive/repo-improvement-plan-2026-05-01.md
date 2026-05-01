# Repo Improvement Plan Snapshot - 2026-05-01

This archived snapshot records the post-Console audit plan that was used to
choose the current CI/docs cleanup. It is no longer live operator guidance.

## Status

- Phase 0 is resolved by `a885198 Fix GhostRoute Console public path`.
- Phase 1 was narrowed to fast CI plus a small Console smoke suite.
- Phase 2 Console hygiene remains deferred. In particular, SQLite migrations,
  stronger server types and POST body validation need their own implementation
  plan.
- Phase 3 shell/Ansible refactoring remains deferred. The large
  `traffic-report` split should be planned and tested separately.
- Phase 4 was narrowed to documentation policy, test-entrypoint docs, and
  archiving stale planning notes.

## Deferred Backlog

- Type the broad Console `Record<string, any>` surfaces.
- Split Console database opening/schema/migrations from the current store file.
- Add validation on Console POST actions.
- Refactor `modules/traffic-observatory/bin/traffic-report` in small
  behavior-preserving slices.
- Review brittle grep-based static tests and replace the riskiest ones with
  contract checks.

Current production guidance lives in the root READMEs, `docs/`, module docs and
the active test entrypoints under `tests/`.

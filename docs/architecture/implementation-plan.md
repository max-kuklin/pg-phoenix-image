# Implementation Plan

> Note: The Dockerfile is committed in its final state. It references scripts from all phases. Phase 1 creates the test harness, logger, and minimal scripts so the image can build and container-first TDD can start immediately. Later phases replace stubs with real implementations.

## Current Status

Phases 1 and 2 are implemented. Phase 3 is partially implemented: WAL-G setup, `backup.sh`, startup restore preparation, restore idempotency, rollback markers, and the first MinIO E2E restore path are in place. Phase 4 has partial entrypoint behavior through restore selection, but the dedicated `startup.test.js` and `clone.test.js` suites have not been added yet. Phase 5 is design-only; `upgrade.sh` is still a stub. Phase 6 has a main-branch CI workflow, but Renovate digest pinning is not configured.

## Phase 1: Foundation

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 1 | `package.json`, `vitest.config.js`, `tests/helpers/shell.js`, `tests/helpers/containers.js` | nothing | `npm test -- tests/contracts` has a real target |
| 2 | `scripts/lib/logger.sh`, `tests/contracts/logger.test.js` | step 1 | contract test runs in Linux |
| 3 | stub scripts: `entrypoint.sh`, `backup.sh`, `restore.sh`, `upgrade.sh` | steps 1-2 | scripts are executable and source logger cleanly |
| 4 | local image build gate | step 3 | `docker build -t pg-phoenix-image:test .` succeeds |

The script contract layer is intentionally small. It exists for fragile Bash contracts such as logging, shell quoting, env validation, prefix rewriting, and argument parsing. It does not try to mock PostgreSQL, WAL-G, cron, or upgrade behavior.

Contract tests run inside Linux, not directly on the Windows host. `tests/helpers/shell.js` owns that execution detail so shell behavior matches the Debian image closely enough for Bash contracts.

The initial `entrypoint.sh` stub must delegate to the official `docker-entrypoint.sh` and pass `-c config_file=/etc/postgresql/postgresql.conf` when starting Postgres. That keeps Phase 2 aligned with the shipped config path from the start.

## Phase 2: Image Validation

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 5 | `tests/pg-only.test.js` | Phase 1 plus existing Dockerfile/config | write image smoke tests first |

This is the first full behavior gate. It validates the image contract: PostgreSQL connects, the active config file is `/etc/postgresql/postgresql.conf`, WAL-G is installed, `pg_stat_statements` works, cron exists, and `conf.d/` overrides are honored.

The normal loop for image changes is:

```bash
docker build -t pg-phoenix-image:test .
npm test -- tests/pg-only.test.js
```

## Phase 3: Backup and Restore

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 6 | minimal backup/restore contracts: env file quoting, prefix selection, restore args | Phase 1 | contract tests only where pure Bash value exists |
| 7 | `scripts/backup.sh`, `scripts/restore.sh`, and WAL-G startup setup in `entrypoint.sh` | Phase 2 plus step 6 | image still starts; contract tests pass |
| 8 | `tests/backup-restore.test.js` | steps 6-7 | write E2E tests for real WAL-G/MinIO behavior |

Backup and restore are primarily E2E-tested because their correctness depends on real PostgreSQL, WAL-G, object storage, WAL replay, and failure recovery. Contract tests cover only the Bash pieces that are hard to diagnose through container logs.

The entrypoint WAL-G setup is implemented in this phase because backup E2E needs the real runtime contract: version-scoped prefix generation, `/etc/walg-env.sh`, `conf.d/walg.conf`, and `/etc/cron.d/pg-backup`.

## Phase 4: Entrypoint and Startup

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 9 | remaining `scripts/entrypoint.sh` orchestration: version checks, binary stash, startup restore selection | Phase 1 plus steps 6-7 | contract tests only where pure Bash value exists |
| 10 | `tests/startup.test.js` | Phase 2 plus step 9 | write container scenarios for env-driven startup |
| 11 | `tests/clone.test.js` | Phase 2 plus steps 7 and 9 | write E2E clone scenarios |

Entrypoint ties the image together: version check, binary stash, startup restore selection, and handoff to the official PostgreSQL entrypoint. WAL-G backup setup is already covered by Phase 3 because backup E2E depends on it. Pure env/path decisions can have contracts, but process behavior belongs in `startup.test.js`.

`clone.test.js` validates the data result of `PG_RESTORE_FROM` with an empty PVC; `startup.test.js` only needs to prove that the entrypoint selects the restore path and respects the overwrite/rollback gates.

## Phase 5: Upgrade

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 12 | `scripts/upgrade.sh` plus minimal contracts for gates/argument decisions | Phase 1 plus steps 6 and 9 | contract tests only where pure Bash value exists |
| 13 | `tests/upgrade.test.js` | Phase 2 plus step 12 | write E2E tests for real upgrade behavior |

Upgrade is last because it has the heaviest setup: two PostgreSQL major versions, stashed binaries, `pg_upgrade --link`, pre-upgrade backup gating, and rollback paths.

The full upgrade suite is not the normal edit loop. It is a pre-merge/release gate. CI should cache Docker layers for this suite because the Dockerfile installs packages and downloads WAL-G.

## Phase 6: CI Glue

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 14 | CI workflow that builds `pg-phoenix-image:test` and runs contract, image, and E2E suites | Phase 2 | CI passes on PRs |
| 15 | `renovate.json` | step 14 | Renovate PRs are gated by CI |

Renovate is only useful if digest updates are gated by automated builds and tests. The CI workflow is therefore part of the feature, not optional glue.

## Dependency Graph

```text
test harness -> logger.sh -> script stubs -> image build -> pg-only.test.js
     |             |                                 |
     |             +-> small script contracts         |
     |                                               |
     +-> containers.js                              |
                                                     +-> backup.sh + restore.sh -> backup-restore.test.js
                                                     +-> entrypoint.sh ---------> startup.test.js
                                                     |                             clone.test.js
                                                     +-> upgrade.sh ------------> upgrade.test.js
```

Container tests depend on a prebuilt `pg-phoenix-image:test` image. Contract tests exist only for pure Bash behavior that has a clear payoff.

## Summary

| Phase | Scripts | Tests | Running total |
|---|---|---|---|
| 1: Foundation | `logger.sh`, stub scripts | contract harness, logger contract, container helpers, image build gate | 10 files |
| 2: Image | none | `pg-only.test.js` | 11 files |
| 3: Backup/Restore | `backup.sh`, `restore.sh` | focused contracts, `backup-restore.test.js` | 14 files |
| 4: Entrypoint | `entrypoint.sh` | focused contracts, `startup.test.js`, `clone.test.js` | 17 files |
| 5: Upgrade | `upgrade.sh` | focused contracts, `upgrade.test.js` | 19 files |
| 6: CI | none | CI workflow, `renovate.json` | 21 files |

Each phase ends with passing tests for everything built so far. No phase depends on a later phase.

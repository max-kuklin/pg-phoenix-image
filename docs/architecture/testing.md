# Testing Strategy

## Purpose

Keep the TDD loop practical for a PostgreSQL image whose real behavior depends on Docker, Debian, WAL-G, cron, and PostgreSQL itself. The suite has two layers:

| Layer | Scope | Default use |
|---|---|---|
| Script contract tests | Small Bash contracts that are expensive to debug through E2E output | Quoting, validation, parsing, prefix logic |
| Image and E2E tests | Real container behavior with PostgreSQL, WAL-G, and S3-compatible object storage | Main development and pre-merge confidence |

Script contract tests are intentionally limited. They are not a separate mock-heavy unit-test architecture for Bash scripts. Most script behavior should be proved through real containers.

## Commands

| Command | Runs | Use when |
|---|---|---|
| `npm run test:contracts` | Script contract tests in Linux | Changing shared Bash validation/quoting/parsing |
| `docker build -t pg-phoenix-image:test .` | Local image build | Before any image or E2E test |
| `npm run test:image` | Single-PG image smoke suite | Checking image startup/config/runtime surface |
| `npm test -- tests/startup.test.js` | Fast entrypoint refusal scenarios | Changing startup env gates |
| `npm run test:e2e` | Startup gates plus PG + SeaweedFS S3 backup/restore suite | Working on WAL-G backup or restore |
| `npm run test:report` | Full suite plus timing report with inline duration bars | Comparing test runtime |
| `npm test` | Full suite | Before merge or release |

Integration tests use the prebuilt `pg-phoenix-image:test` tag by default. Tests should not rebuild the image per file. The upgrade suite is the exception because it intentionally builds old/new PostgreSQL variants from the Dockerfile.

## Layer 1: Script Contract Tests

Script contract tests validate only Bash behavior that is pure, fragile, and hard to diagnose from container logs. They run in Linux, not directly on the Windows host. The test runner should execute them through a small Debian/Bash container or equivalent Linux environment so shell behavior matches the image.

Use this layer for:

- logger formatting, levels, and stderr-only output
- shell-safe generation of `/etc/walg-env.sh`
- env validation for `ARCHIVE_TIMEOUT`, `BACKUP_SCHEDULE`, and restore source prefixes
- storage backend selection and version suffixing for `WALG_S3_PREFIX`, `WALG_GS_PREFIX`, and `WALG_AZ_PREFIX`
- argument parsing for `restore.sh`

Do not use this layer for:

- PostgreSQL lifecycle behavior
- `pg_ctl`, `pg_isready`, or signal handling
- `wal-g backup-push`, `wal-g backup-fetch`, or WAL replay
- cron actually running jobs
- file ownership/permission behavior that depends on the image user
- major upgrade execution

Those belong in image or E2E tests.

Recommended structure:

```text
tests/
  contracts/
    logger.test.js
    env-file.test.js
    prefix.test.js
    restore-args.test.js
  helpers/
    shell.js
```

`tests/helpers/shell.js` centralizes running Bash inside Linux, mounting the repo, setting temp dirs, and capturing stdout/stderr. Fake external binaries should be used only when the contract under test is pure Bash behavior. If a test needs a realistic PostgreSQL or WAL-G process, it is not a contract test.

As scripts grow, shared pure behavior should move into small sourceable files under `scripts/lib/`. The executable scripts should remain thin orchestration layers.

## Layer 2: Image and E2E Tests

This is the main test layer. It proves the image behaves correctly with real PostgreSQL and, where needed, real WAL-G and S3-compatible object storage. The current Testcontainers backend is SeaweedFS S3; tests use backend-neutral helpers so the storage implementation remains replaceable.

Top-level test files are grouped by container topology, not by feature, to minimize container starts:

```text
tests/
  helpers/
    containers.js
  pg-only.test.js
  startup.test.js
  backup-restore.test.js
  clone.test.js
  upgrade.test.js
```

### `pg-only.test.js`: Image Smoke

One shared PostgreSQL container where possible. This suite should fail quickly when the Dockerfile, entrypoint handoff, config path, extension setup, or bundled binaries are broken.

| Group | Scenarios | State |
|---|---|---|
| Image | PG connects, `SHOW config_file`, WAL-G exists, cron exists | Read-only |
| Config override | Mount `work_mem=128MB` into `conf.d/`, then verify `SHOW work_mem` | Fresh container |
| Metrics | `pg_stat_statements` exists, tracks calls, expected settings are active | Mutates `pg_stat_statements` view only |
| Slow query log | Default off, enable/change/disable via config reload, log format visible | Sequential global config changes |

### `startup.test.js`: Entrypoint Scenarios

Each scenario uses a new container because entrypoint behavior is mostly env-driven.

| Scenario | Topology |
|---|---|
| No WAL-G env starts plain PostgreSQL | PG only |
| WAL-G prefix with valid schedule configures archiving and cron | PG + object storage |
| WAL-G prefix without `BACKUP_SCHEDULE` refuses startup | PG + object storage |
| Invalid `ARCHIVE_TIMEOUT` refuses startup | PG + object storage |
| Invalid `BACKUP_SCHEDULE` refuses startup | PG + object storage |
| Restore env over existing PGDATA without overwrite gate refuses startup | PG + object storage |
| Restore env without request ID refuses startup | PG + object storage |
| Completed restore request ID is skipped on restart | PG + object storage |
| Restore rollback env swaps `pre-restore` back | PG + object storage |
| Completed rollback request ID is skipped on restart | PG + object storage |
| Clone env on empty PGDATA triggers startup restore | 2x PG + object storage |
| Clone env on existing PGDATA is skipped | PG + object storage |
| Version mismatch without `PG_UPGRADE` refuses startup | PG only |
| Binary stash exists after startup | PG only |
| Postgres receives signals correctly after entrypoint handoff | PG only |

### `backup-restore.test.js`: PG + Object Storage

One shared PG + SeaweedFS S3 pair. Backup tests create the state that restore tests consume.

| Group | Scenarios | State |
|---|---|---|
| Backup | Cron scheduled, base backup, WAL archive, delta, retention, `archive_timeout`, version-prefixed path | Sequential |
| Backup without creds | No WAL-G credentials configured, graceful skip | Fresh PG container |
| Restore | startup latest restore, startup PITR, overwrite gate, failed fetch leaves PGDATA untouched, explicit rollback | Sequential |

### `clone.test.js`: Source + Target + Object Storage

Validates cross-instance clone behavior. `startup.test.js` checks that clone is triggered; this file checks data fidelity.

| Scenario | State |
|---|---|
| Clone latest contains source data | Creates target |
| Clone PITR excludes later source data | Creates target |
| Restart after clone does not overwrite PGDATA | Depends on prior clone |
| Bad source prefix fails clearly | Fresh container |

### `upgrade.test.js`: Two PostgreSQL Majors + Object Storage

Slowest suite. It builds old/new image variants via the Dockerfile `PG_BASE` build arg. Defaults are controlled by `PG_TEST_OLD` and `PG_TEST_NEW`.

The full upgrade suite is a pre-merge/release gate, not the normal edit loop. CI should cache Docker layers for this suite because the Dockerfile installs packages and downloads WAL-G.

| Group | Scenarios | State |
|---|---|---|
| Upgrade gate | Mismatch without gate, no backup, full upgrade | Sequential |
| Rollback | `pg_upgrade` failure and post-upgrade start failure | Sequential |
| Post-upgrade | Data intact, prefix switched, analyze ran, no repeat upgrade | Read-only checks |
| Binary stash | Created, reused on restart, updated on minor image change | Mixed |

## Test Helpers

`tests/helpers/containers.js` centralizes image name, env defaults, wait strategies, and container cleanup. It exposes:

- `startPg(overrides?)`: single PostgreSQL container, default `POSTGRES_PASSWORD=test`
- `startPgWithObjectStorage(overrides?)`: PostgreSQL plus SeaweedFS S3, bucket initialization, and WAL-G env
- restore helpers should use mounted Docker volumes for PGDATA when validating startup restore and rollback behavior

`tests/helpers/shell.js` centralizes Linux Bash execution for script contract tests.

Helpers should keep policy out of tests only when the policy is generic. Feature-specific expectations belong in the test file that exercises the feature.

## Vitest Configuration

Root `vitest.config.js` should include:

- `include: ['tests/**/*.test.js']`
- `testTimeout: 120_000` for container operations and WAL replay
- `hookTimeout: 60_000` for container startup
- file-level parallelism enabled for independent top-level suites
- sequential execution within files that share container state

Contract tests should stay few and focused. If they start requiring extensive fake process behavior, move that coverage to an image/E2E test.

## Logging Assertions

Every layer verifies logs at the level it can observe:

- contract tests assert logger formatting, levels, and stderr routing
- image smoke tests assert startup log shape and component tags
- E2E tests assert operation-specific phase markers and error paths

This avoids a separate logging-only integration suite while still treating log output as part of the operational contract.

# E2E Testing

## Purpose

Verify every image feature end-to-end: real PostgreSQL, real WAL-G, real MinIO. No mocks for core paths. Tests run via `npm test` (Vitest + Testcontainers).

## Concept

Container startup dominates test runtime (~5-10s per PG, ~3-5s per MinIO). Individual assertions are milliseconds. Optimization = fewer container starts.

Tests are grouped by **container topology** (what infrastructure they share), not by feature. A single PG container serves image checks, metrics queries, and slow-query-log config changes sequentially — rather than starting three separate containers for three features.

Five test files, each managing its own container lifecycle:

```
tests/
├── helpers/
│   └── containers.js          # startPg(), startPgWithMinio() factories
├── pg-only.test.js            # image + metrics + slow-query-log
├── backup-restore.test.js     # backup → restore (natural dependency)
├── startup.test.js            # fresh container per scenario (different env vars)
├── clone.test.js              # 2× PG + MinIO
└── upgrade.test.js            # 2× PG (two major versions) + MinIO
```

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Runner | Vitest | Jest, node:test | Faster startup, built-in file-level parallelism, same `describe`/`test`/`beforeAll` API as Jest. |
| Container library | Testcontainers | Docker Compose, custom scripts | Programmatic lifecycle per `describe` block. No Compose files, no shared state between test files. Container config (env vars, mounts) is colocated with the tests that use it. |
| Grouping | By container topology | By feature (1 file per feature) | Reduces ~24 container starts to ~14 by sharing PG instances across features that can coexist. Merging backup + restore avoids redundant seed-then-backup setup. |
| File parallelism | Enabled (Vitest default) | Sequential files | All 5 files start simultaneously. Wall-clock time ≈ slowest file (~60s for upgrade) instead of sum of all files. |
| Within-file execution | Sequential | Concurrent tests | Tests within a file share container state. INSERT → backup → restore must be ordered. `concurrent: false` (Vitest default). |
| Workspace projects | Not used | Vitest workspace with `globalSetup` + `provide`/`inject` | 5 files don't warrant workspace config overhead. `beforeAll`/`afterAll` per `describe` is simpler and sufficient. |

### Why Not One File Per Feature?

Eight separate files (image, metrics, slow-query-log, backup, restore, clone, startup, upgrade) would start ~24 containers. Merging by topology saves ~10 starts with no complexity cost:

- **image + metrics + slow-query-log → `pg-only.test.js`**: All need a single PG container. Image checks and metrics are read-only. Slow-query-log mutates `ALTER SYSTEM` settings but doesn't affect prior tests.
- **backup + restore → `backup-restore.test.js`**: Every restore needs a backup in MinIO. Running them sequentially in one file means backup tests create the state that restore tests consume — no redundant seeding.
- **startup stays separate**: Each scenario needs different env vars (no WAL-G, with WAL-G, with clone, version mismatch). Can't share containers.

## Test Files

### `pg-only.test.js` — Single PG Container

Covers: image validation, `pg_stat_statements`, slow-query-log config.

One shared PG container (+ one fresh container for `conf.d/` mount test). Tests run sequentially because slow-query-log mutates global config via `ALTER SYSTEM`.

| Group | Scenarios | State |
|---|---|---|
| Image | PG connects, `SHOW config_file`, WAL-G exists, cron exists | Read-only |
| Image (conf.d) | Mount `work_mem=128MB` → `SHOW work_mem` | Fresh container with bind mount |
| Metrics | Extension exists, call counts, `track=all`, `max` value | Mutates `pg_stat_statements` (isolated view) |
| Slow-query-log | Default off, enable at 500ms, change to 100ms, disable, log format | Sequential `ALTER SYSTEM` + `pg_reload_conf` |

### `backup-restore.test.js` — PG + MinIO

Covers: backup creation, WAL archiving, delta/retention, restore (PITR, DR, rollback), bootstrap.

One PG + MinIO pair. Backup tests seed the data that restore tests consume.

| Group | Scenarios | State |
|---|---|---|
| Backup | Cron scheduled, base backup, WAL archive, delta, retention, `archive_timeout`, version-prefixed path | Sequential — each builds on prior backups |
| Backup (no creds) | No AWS credentials → graceful skip | Fresh PG container (no MinIO) |
| Restore | PITR, DR latest, rollback on fetch/start failure, idempotent stop, empty PGDATA, recovery settings cleanup, bootstrap flag | Sequential — each restore replaces PGDATA |

### `startup.test.js` — Fresh Container Per Scenario

Covers: entrypoint behavior under different env var combinations.

Each `describe` block starts its own container(s) because env vars are set at container creation time — can't reuse a running PG with different config.

| Scenario | Topology | State |
|---|---|---|
| No env vars → plain PG, no cron | PG only | Read-only |
| `WALG_S3_PREFIX` set → cron + archiving | PG + MinIO | Read-only |
| `WALG_S3_PREFIX` set without `BACKUP_SCHEDULE` → refuse to start | PG + MinIO | Read-only |
| `WALG_S3_PREFIX` set with invalid `ARCHIVE_TIMEOUT` → refuse to start | PG + MinIO | Read-only |
| `WALG_CLONE_FROM` + empty PGDATA → clone | 2× PG + MinIO | Mutates (clone) |
| `WALG_CLONE_FROM` + existing PGDATA → skip | PG + MinIO | Read-only |
| Version match → normal startup | PG only | Read-only |
| Version mismatch + no gate → refuse | PG only | Read-only |
| Invalid `BACKUP_SCHEDULE` → refuse to start | PG + MinIO | Read-only |
| Binary stash exists after startup | PG only | Read-only |
| PG is PID 1 (exec'd correctly) | PG only | Read-only |

### `clone.test.js` — 2× PG + MinIO

Covers: cross-instance clone via `WALG_CLONE_FROM` — verifies data fidelity and PITR correctness. (`startup.test.js` only checks that the entrypoint triggers the clone; this file validates the actual data.)

Instance A (source) is seeded and backed up once. Instance B (target) is created per scenario.

| Scenario | State |
|---|---|
| Clone latest → B has A's data | Mutates (creates B) |
| Clone PITR → only T1 data | Mutates (creates B with target time) |
| Clone idempotency → restart B, PGDATA untouched | Read-only (depends on prior clone) |
| Bad source prefix → clear error | Fresh container |

### `upgrade.test.js` — 2× PG (Two Major Versions) + MinIO

Covers: major-version upgrade flow, rollback on failure, binary stash lifecycle.

Heaviest file. Needs PG containers with two different major versions. The Dockerfile accepts a `PG_BASE` build arg (defaults to `postgres:18`). The test helper reads `PG_TEST_OLD` (default: `17`) and `PG_TEST_NEW` (default: `18`) env vars and builds both images using Testcontainers' `GenericContainer.fromDockerfile()`: the "old" image passes `--build-arg PG_BASE=postgres:$PG_TEST_OLD`, and the "new" image passes `--build-arg PG_BASE=postgres:$PG_TEST_NEW`. No registry pulls, no file patching — both images are built locally during the test run. Override via CLI: `PG_TEST_OLD=16 PG_TEST_NEW=17 npm test`. Defaults track the current production target pair (both released and stable).

| Group | Scenarios | State |
|---|---|---|
| Upgrade flow | Mismatch without gate (refuse), full upgrade (data intact), no backup (refuse), rollback on `pg_upgrade` failure, rollback on start failure | Sequential — post-upgrade checks depend on upgrade completing |
| Post-upgrade | Backup prefix switch to `.../19`, `ANALYZE` ran, stash lifecycle, `PG_UPGRADE` left set → no re-upgrade | Read-only checks after upgrade |
| Binary stash | Fresh start → created, restart → unchanged, checksum matches, minor upgrade → updated | Mixed — some need fresh containers |

## Container Helpers

`tests/helpers/containers.js` centralizes image name, common env vars, and wait strategies. Two factory functions:

- `startPg(overrides?)` — single PG container. Defaults: `POSTGRES_PASSWORD=test`, waits for `pg_isready`.
- `startPgWithMinio(overrides?)` — PG + MinIO + bucket init. Adds WAL-G env vars, creates the test bucket, waits for both services.

Both return handles for `stop()` in `afterAll`. Each `describe` block calls the factory it needs — no shared global state between files.

For tests needing fresh containers mid-file (e.g., backup with no credentials, clone with bad source), a nested `describe` block with its own `beforeAll`/`afterAll` handles the lifecycle.

## Log Assertions

Every test file verifies expected log output in container stderr — level, component tag, phase markers. This is woven into each suite rather than tested separately, since log output is a byproduct of every operation.

## Vitest Configuration

`vitest.config.js` at the project root:

- `include: ['tests/**/*.test.js']`
- `testTimeout: 120_000` — container operations and WAL replay can be slow
- `hookTimeout: 60_000` — `beforeAll` container startup
- `fileParallelism: true` — all 5 files run simultaneously
- `sequence.concurrent: false` — tests within a file run in order

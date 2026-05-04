# Entrypoint Orchestration

## Purpose

Single startup script that ties all image features together. Runs before `docker-entrypoint.sh` and decides what needs to happen based on the current state of PGDATA and environment variables.

Any feature that needs to start PostgreSQL before handoff must use a temporary `pg_ctl`-managed child process and stop it before returning. After the final `exec docker-entrypoint.sh ...`, PostgreSQL owns PID 1; stopping it is a container restart.

## Startup Flow

```
entrypoint.sh
  │
  ├─ 1. VERSION CHECK
  │   ├─ PGDATA empty → skip (first boot)
  │   ├─ PG_VERSION matches image → proceed
  │   ├─ mismatch + PG_UPGRADE=true → major upgrade flow [upgrade-major.md]
  │   └─ mismatch + no gate → refuse to start, exit 1
  │
  ├─ 2. BINARY STASH
  │   └─ copy current PG binaries to /var/lib/postgresql/.pg-binaries/<major>/
  │      (unconditional, idempotent, checksum-gated) [upgrade-major.md]
  │
  ├─ 3. VERSION-PREFIX BACKUP PATH
  │   └─ detect active prefix (WALG_S3_PREFIX → WALG_GS_PREFIX → WALG_AZ_PREFIX, first set wins) → append /<major>/ [backup.md]
  │
  ├─ 4. RESTORE REQUEST
  │   ├─ PG_RESTORE_ROLLBACK=true?
  │   │   └─ restore.sh with RESTORE_REQUEST_ID=$PG_RESTORE_REQUEST_ID [restore.md]
  │   ├─ PG_RESTORE=true or PG_RESTORE_FROM set?
  │   │   └─ restore.sh with RESTORE_REQUEST_ID=$PG_RESTORE_REQUEST_ID [--from ...]
  │   └─ otherwise skip
  │
  ├─ 5. BACKUP SETUP
  │   ├─ WAL-G prefix set (any of WALG_S3_PREFIX / WALG_GS_PREFIX / WALG_AZ_PREFIX)?
  │   │   ├─ validate ARCHIVE_TIMEOUT is a non-negative integer (^[0-9]+$) → invalid? fatal error, refuse to start
   │   │   ├─ write all backup env to /etc/walg-env.sh (WALG_*, AWS_*, BACKUP_RETAIN_FULL, LOG_LEVEL)
   │   │   │   - POSIX `/bin/sh`-sourceable (`export NAME='VALUE'` with single-quote escaping)
   │   │   │   - reject NUL/newlines in values
  │   │   ├─ write /etc/postgresql/conf.d/walg.conf (sets archive_command + archive_timeout)
  │   │   ├─ BACKUP_SCHEDULE set?
  │   │   │   ├─ validate cron expression → invalid? fatal error, refuse to start
  │   │   │   ├─ write `/etc/cron.d/pg-backup` (see [backup.md](backup.md#cron-schedule))
  │   │   │   └─ start crond
  │   │   └─ BACKUP_SCHEDULE unset → fatal error, refuse to start
  │   │       (WAL archiving without scheduled base backups produces an
  │   │        unrestorable backup set — operator must set BACKUP_SCHEDULE)
  │   └─ no prefix → skip (archive_command stays /bin/true, image behaves as plain PostgreSQL)
  │
  └─ 6. HAND OFF
      └─ exec docker-entrypoint.sh "$@" -c config_file=/etc/postgresql/postgresql.conf
```

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Wrapper vs fork | Wraps official `docker-entrypoint.sh` via `exec` | Fork/patch upstream entrypoint | Upstream entrypoint handles `initdb`, `POSTGRES_PASSWORD`, extension loading, `docker-entrypoint-initdb.d/` scripts. No reason to reimplement. `exec` replaces the process — PG becomes PID 1 and receives signals correctly. |
| Feature ordering | Version check → stash → prefix/env file → restore → backup → handoff | Various | Version check blocks unsafe startup first. Restore needs WAL-G credentials and prefix resolution before fetching, but cron should start only after restore decisions are complete. |
| Temporary PostgreSQL before handoff | `pg_ctl` child process, stopped before `exec` | Restart PID 1 PostgreSQL inside the same container | Upgrade and restore validation sometimes need a live server before normal startup. Child processes can be stopped without triggering container restart; PID 1 PostgreSQL cannot. |
| Graceful degradation | Each feature is independently skippable | All-or-nothing | No WAL-G prefix → backup setup skips. No restore env → restore skips. The image still works as a plain PostgreSQL container with zero config. |

## Configuration

No configuration specific to the entrypoint itself. It reads env vars documented in each feature:

| Variable | Feature | Doc |
|---|---|---|
| `PG_UPGRADE` | Major upgrade gate | [upgrade-major.md](upgrade-major.md) |
| `WALG_S3_PREFIX` / `WALG_GS_PREFIX` / `WALG_AZ_PREFIX` | Backup path (first set wins, version-suffixed at runtime) | [backup.md](backup.md) |
| `PG_RESTORE` / `PG_RESTORE_FROM` / `PG_RESTORE_TARGET_TIME` / `PG_RESTORE_REQUEST_ID` | Startup restore | [restore.md](restore.md) |
| `PG_RESTORE_OVERWRITE` / `PG_RESTORE_ROLLBACK` | Restore overwrite and local rollback gates | [restore.md](restore.md) |
| `BACKUP_SCHEDULE` | Cron expression | [backup.md](backup.md) |
| `LOG_LEVEL` | Script verbosity (`ERROR`, `WARN`, `INFO`, `DEBUG`) | [logging.md](logging.md) |

## Failure Modes

| Failure | Behavior |
|---|---|
| Version mismatch without `PG_UPGRADE` | Refuses to start with clear error message. See [upgrade-major.md](upgrade-major.md). |
| Upgrade starts temporary PostgreSQL | It must be stopped before handoff. A failure exits the container with PGDATA restored to a retryable state where possible. |
| Restore fails before swap | Container fails to start. Existing PGDATA is untouched. |
| Restore env remains after success | The completed request marker causes startup to skip the already-applied request. |
| PostgreSQL fails during WAL replay | Container fails to start. Operator can set `PG_RESTORE_ROLLBACK=true` to restore `pre-restore`. |
| Cron daemon fails to start | Warning logged, PG starts anyway. WAL archiving still works (driven by PG, not cron). Scheduled base backups don't run. |
| Invalid `BACKUP_SCHEDULE` | Refuses to start with clear error message. Fix the cron expression. |
| `BACKUP_SCHEDULE` missing with WAL-G prefix set | Refuses to start. WAL archiving without base backups produces an unrestorable backup set. Set `BACKUP_SCHEDULE` in the manifest. |
| Invalid `ARCHIVE_TIMEOUT` | Refuses to start with clear error message. Must be a non-negative integer. |
| `docker-entrypoint.sh` fails | Container fails to start. Standard PG entrypoint errors (bad password config, initdb failure, etc.). |

## Testing

### E2E — `tests/startup.test.js`

Each scenario uses a fresh container with different env vars (see [testing.md](testing.md)):

- No env vars → PG starts as plain PostgreSQL, no cron, no WAL-G
- `WALG_S3_PREFIX` set → cron running, WAL archiving configured
- `WALG_S3_PREFIX` set without `BACKUP_SCHEDULE` → container refuses to start
- `WALG_S3_PREFIX` set with invalid `ARCHIVE_TIMEOUT` → container refuses to start
- `PG_RESTORE=true` without `PG_RESTORE_REQUEST_ID` → container refuses to start
- `PG_RESTORE=true` with existing PGDATA and no overwrite gate → container refuses to start
- `PG_RESTORE=true` + `PG_RESTORE_OVERWRITE=true` → startup restore is prepared
- same `PG_RESTORE_REQUEST_ID` after completed restore → restore skipped
- `PG_RESTORE_ROLLBACK=true` → `pre-restore` is restored before handoff
- same rollback request ID after completed rollback → rollback skipped
- `PG_RESTORE_FROM` + empty PGDATA → clone/restore triggered
- `PG_RESTORE_FROM` + existing PGDATA + no overwrite gate → container refuses to start
- Version match → normal startup
- Version mismatch + no gate → container refuses to start
- Binary stash exists after startup
- PG is PID 1 (or direct child via `exec`) — signals delivered correctly

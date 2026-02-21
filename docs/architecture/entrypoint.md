# Entrypoint Orchestration

## Purpose

Single startup script that ties all image features together. Runs before `docker-entrypoint.sh` and decides what needs to happen based on the current state of PGDATA and environment variables.

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
  ├─ 4. CLONE DETECTION
  │   ├─ WALG_CLONE_FROM set?
  │   │   ├─ strip trailing slash (${WALG_CLONE_FROM%/}) before any validation
  │   │   ├─ reject with fatal error if value doesn't end with /<digits> (e.g. /18)
  │   │   │   (intentionally duplicated in restore.sh — defense-in-depth; restore.sh is independently callable)
  │   │   ├─ PGDATA empty (no PG_VERSION)?
  │   │   │   └─ restore.sh --bootstrap --from $WALG_CLONE_FROM [--target-time ...] [restore.md]
  │   │   └─ PGDATA exists → skip (idempotent)
  │   └─ not set → skip
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
| Feature ordering | Version check → stash → prefix → clone → backup → handoff | Various | Version check must be first (blocks startup on mismatch). Stash before prefix (stash uses unprefixed binary version). Stash runs unconditionally — it writes to `/var/lib/postgresql/.pg-binaries/` (outside PGDATA), so it's safe even on first boot before initdb. Clone before backup setup (clone must populate PGDATA before PG starts; backup setup writes to `/etc/` and doesn't depend on PGDATA). |
| Graceful degradation | Each feature is independently skippable | All-or-nothing | No `WALG_S3_PREFIX` → steps 3 and 5 skip. No `WALG_CLONE_FROM` → step 4 skips. The image always works as a plain PostgreSQL container with zero config. |

## Configuration

No configuration specific to the entrypoint itself. It reads env vars documented in each feature:

| Variable | Feature | Doc |
|---|---|---|
| `PG_UPGRADE` | Major upgrade gate | [upgrade-major.md](upgrade-major.md) |
| `WALG_S3_PREFIX` / `WALG_GS_PREFIX` / `WALG_AZ_PREFIX` | Backup path (first set wins, version-suffixed at runtime) | [backup.md](backup.md) |
| `WALG_CLONE_FROM` | Clone source prefix | [restore.md](restore.md) |
| `WALG_CLONE_TARGET_TIME` | Clone PITR target | [restore.md](restore.md) |
| `BACKUP_SCHEDULE` | Cron expression | [backup.md](backup.md) |
| `LOG_LEVEL` | Script verbosity (`ERROR`, `WARN`, `INFO`, `DEBUG`) | [logging.md](logging.md) |

## Failure Modes

| Failure | Behavior |
|---|---|
| Version mismatch without `PG_UPGRADE` | Refuses to start with clear error message. See [upgrade-major.md](upgrade-major.md). |
| Clone fails (`restore.sh` exits non-zero) | Container fails to start. Correct — no partial PGDATA. |
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
- `WALG_CLONE_FROM` + empty PGDATA → clone triggered
- `WALG_CLONE_FROM` + existing PGDATA → clone skipped (idempotent)
- Version match → normal startup
- Version mismatch + no gate → container refuses to start
- Binary stash exists after startup
- PG is PID 1 (or direct child via `exec`) — signals delivered correctly

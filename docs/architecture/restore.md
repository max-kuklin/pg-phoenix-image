# Restore

## Purpose

Recover a PostgreSQL instance from WAL-G backups during container startup.

| Scenario | Source | Target |
|---|---|---|
| Disaster recovery | Same instance's backups | Latest available state |
| Point-in-time recovery | Same instance's backups | Specific timestamp |
| Clone | Another instance's backups | Latest or specific timestamp |

All scenarios use the same PostgreSQL mechanism: `wal-g backup-fetch`, `recovery.signal`, `restore_command`, PostgreSQL startup, WAL replay, and promotion. The important project constraint is that restore is a startup operation. The image does not stop and restart a live PostgreSQL process from inside the running container.

## Concept

PostgreSQL is PID 1 after `docker-entrypoint.sh` hands off. A restore that stops PostgreSQL from inside the same container also terminates the container, so live in-place restore is the wrong lifecycle boundary. Operators request restore by changing environment variables; Kubernetes restarts the pod; the entrypoint prepares PGDATA before PostgreSQL starts.

```
entrypoint.sh
  |
  |-- write /etc/walg-env.sh when WAL-G is configured
  |-- restore requested?
  |     |-- request ID already completed? -> skip
  |     |-- rollback requested? -> swap pre-restore back to PGDATA, exit restore path
  |     |-- fetch backup into restore-tmp
  |     |-- write recovery.signal and restore settings
  |     |-- if PGDATA exists and overwrite allowed -> move PGDATA to pre-restore
  |     |-- move restore-tmp to PGDATA
  |
  |-- configure archiving and cron
  |-- exec docker-entrypoint.sh ... -c config_file=/etc/postgresql/postgresql.conf
```

The restore fetch happens before the existing data directory is moved. If `backup-fetch` fails, existing PGDATA is still in place. The swap happens only after the fetched directory has been prepared.

## PVC Layout

The PVC must be mounted at `/var/lib/postgresql`, not directly at PGDATA. The official PostgreSQL 18 image uses a versioned data directory under that mount, so restore can keep sibling directories on the same filesystem:

| Path | Purpose |
|---|---|
| `$PGDATA` | Active PostgreSQL data directory, for example `/var/lib/postgresql/18/docker` |
| `$PGDATA_PARENT/restore-tmp` | New data fetched by WAL-G before the swap |
| `$PGDATA_PARENT/pre-restore` | Previous active data kept for manual rollback |
| `$PGDATA_PARENT/failed-restore` | Data moved aside during explicit rollback, retained for inspection |
| `$PGDATA_PARENT/restore-state` | Completed restore and rollback request markers |

Sibling moves on the same PVC avoid cross-device copies and make the final directory swap fast. The trade-off is disk headroom: restoring over an existing database can temporarily require current PGDATA, fetched data, and retained pre-restore data to coexist.

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Restore timing | Startup-only | `kubectl exec restore.sh` against a live pod | Aligns with container lifecycle. PostgreSQL remains PID 1 and the pod restart is the operational boundary. |
| Existing data guard | Require `PG_RESTORE_OVERWRITE=true` when PGDATA exists | Overwrite whenever restore env is present | Prevents an accidental manifest change from replacing a live PVC. Clone into an empty PVC does not need the overwrite gate. |
| Restore idempotency | Require `PG_RESTORE_REQUEST_ID` for explicit restore and rollback | Trust operators to remove restore env before restart | Restore env can remain in a StatefulSet during retries or operational cleanup. A durable request marker makes repeated restarts skip an already-completed request instead of restoring recursively. |
| Restore staging | Fetch into `restore-tmp`, then swap | Move PGDATA first, fetch directly into PGDATA | Keeps existing data untouched until WAL-G has produced a complete fetched directory. |
| Local rollback | Keep `pre-restore` and require explicit rollback env | Auto-rollback after PostgreSQL startup failure | Once the entrypoint execs PostgreSQL, the container lifecycle owns failure handling. Explicit rollback is predictable and auditable. |
| Cross-instance restore | Full version-scoped `PG_RESTORE_FROM` | Reuse the instance write prefix | The restore source and the instance archive destination are different concepts. Source prefixes must already include the PostgreSQL major segment, such as `/18`. |
| PITR action | `recovery_target_action = 'promote'` | `pause` | Startup should produce a running primary without requiring a manual SQL resume. |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PG_RESTORE` | unset | Set to `true` to restore from the instance's own WAL-G prefix during startup. |
| `PG_RESTORE_FROM` | unset | Full version-scoped source prefix, for example `s3://bucket/source/18`. Overrides the fetch source for disaster recovery or clone. |
| `PG_RESTORE_TARGET_TIME` | unset | PITR target timestamp, passed to PostgreSQL as `recovery_target_time`. |
| `PG_RESTORE_OVERWRITE` | unset | Must be `true` when restoring over existing PGDATA. |
| `PG_RESTORE_REQUEST_ID` | unset | Required idempotency key for `PG_RESTORE`, `PG_RESTORE_FROM`, and `PG_RESTORE_ROLLBACK`. Change it to request another restore. |
| `PG_RESTORE_ROLLBACK` | unset | Set to `true` to move `pre-restore` back to PGDATA during startup. |

`PG_RESTORE_FROM` must be a full version-scoped path. The image appends the version suffix only to the instance's own archive prefix, not to arbitrary restore sources.

`PG_RESTORE_REQUEST_ID` may contain letters, numbers, dot, underscore, and dash. Treat it as an operator-controlled idempotency key, not as a timestamp parser or generated secret. Examples: `incident-2026-05-03-latest`, `pitr-2026-05-03-1430`, `rollback-incident-2026-05-03`.

## Implementation

### restore.sh

`restore.sh` is a startup restore preparer. It assumes PostgreSQL is not running and does not call `pg_ctl`.

Behavior:

1. Source `/etc/walg-env.sh` if present.
2. Require `RESTORE_REQUEST_ID` for explicit restore or rollback requests.
3. If the matching completion marker exists, log and skip.
4. If `RESTORE_ROLLBACK=true`, move current PGDATA to `failed-restore`, move `pre-restore` back to PGDATA, write a rollback completion marker, and exit.
5. Validate the restore source prefix when `--from` is used.
6. Refuse to overwrite existing PGDATA unless `RESTORE_OVERWRITE=true`.
7. Refuse to proceed when stale `restore-tmp` or `pre-restore` directories would make the result ambiguous.
8. Fetch `LATEST` into `restore-tmp`.
9. Write `recovery.signal`, `restore_command`, and optional PITR settings into the fetched data. When `--from` is used, `restore_command` overrides the active WAL-G prefix inline so WAL replay reads from the source prefix, while future archiving still uses the destination prefix from `/etc/walg-env.sh`.
10. Move existing PGDATA to `pre-restore` when present.
11. Move `restore-tmp` to PGDATA.
12. Write a restore completion marker.

The script intentionally leaves `pre-restore` after success. Removing it is an operator decision after validation and a fresh backup.

### Entrypoint Integration

Entrypoint performs restore before PostgreSQL starts:

- `PG_RESTORE=true` triggers restore from the instance's own prefix.
- `PG_RESTORE_FROM` triggers restore from a source prefix.
- `PG_RESTORE_REQUEST_ID` is passed as the restore idempotency key.
- `PG_RESTORE_ROLLBACK=true` swaps `pre-restore` back before handoff.

After restore preparation, the official entrypoint starts PostgreSQL. WAL replay and promotion are normal PostgreSQL startup behavior.

## Failure Modes

| Failure | Data state | Behavior |
|---|---|---|
| `backup-fetch` fails | Existing PGDATA untouched | Container exits before PostgreSQL starts. Fix the source and retry. |
| Restore env remains after success | Restored PGDATA active | Completed request marker causes future restarts to skip. |
| Restore request has no request ID | Existing PGDATA untouched | Container exits before PostgreSQL starts. |
| Existing PGDATA without overwrite gate | Existing PGDATA untouched | Container exits with a clear error. |
| Stale `pre-restore` exists | Existing PGDATA untouched | Container exits. Operator must keep, remove, or roll back explicitly. |
| WAL replay fails during PostgreSQL startup | Restored PGDATA active, previous data in `pre-restore` | Container fails. Set `PG_RESTORE_ROLLBACK=true` and restart to revert locally. |
| Target time before oldest backup | Existing PGDATA untouched | `backup-fetch` fails. |
| Target time after latest WAL | Restored PGDATA active | PostgreSQL replays available WAL and promotes at the last reachable point. Monitor logs to confirm recovery endpoint. |

## Testing

Restore behavior belongs in E2E tests because correctness depends on PostgreSQL, WAL-G, object storage, and WAL replay.

Current implemented E2E coverage includes startup restore to latest, startup PITR, clone from `PG_RESTORE_FROM` into an empty PVC, completed request ID idempotency on restart, failed fetch preserving existing PGDATA, explicit rollback, and completed rollback request ID idempotency. The remaining target coverage is:

- restore over existing PGDATA requires `PG_RESTORE_OVERWRITE=true`
- explicit restore and rollback require `PG_RESTORE_REQUEST_ID`
- restart after clone skips by completed request ID

Contract tests should remain limited to source prefix validation, argument parsing, and generated restore settings that are hard to diagnose through container logs.

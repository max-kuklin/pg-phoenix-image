# Restore

## Purpose

Recover a PostgreSQL instance from WAL-G backups. Three scenarios, same mechanism:

| Scenario | Source | Target |
|---|---|---|
| **Disaster recovery** | Same instance's backups | Latest available state |
| **Point-in-time recovery** | Same instance's backups | Specific timestamp (undo bad migration, accidental delete) |
| **Clone** | *Another* instance's backups | Latest or specific timestamp (staging refresh, migration) |

All three: `backup-fetch` → `recovery.signal` → start PG → WAL replay → promote. Differences are which S3 prefix to read from and whether `recovery_target_time` is set.

## Concept

`restore.sh` is the single restore engine. It's safe to run regardless of current state — it handles stopping PG, snapshotting data, fetching backups, and rolling back on any failure. The operator (or entrypoint) never has to manually recover.

```
restore.sh [--from SOURCE_PREFIX] [--target-time TIMESTAMP] [--bootstrap]
  │
  ├─ PG running? → stop it
  ├─ PGDATA non-empty? → move to PGDATA.pre-restore
  ├─ backup-fetch LATEST
  │   └─ FAIL → restore PGDATA.pre-restore, restart PG, exit 1
  ├─ write recovery.signal + restore_command
  │   └─ if --from → embed source prefix in restore_command (WAL fetch from source, not instance prefix)
  ├─ if --target-time → add recovery_target_time + promote
  │
  ├─ --bootstrap? → return (PG startup delegated to docker-entrypoint.sh)
  │
  ├─ start PG (WAL replay → promote)
  │   ├─ poll: while postgres process alive + pg_is_in_recovery() = true → keep waiting
  │   └─ process exits or becomes unresponsive → stop PG, restore PGDATA.pre-restore, restart PG, exit 1
  ├─ cleanup recovery settings from postgresql.auto.conf
  └─ remove PGDATA.pre-restore
```

**Entrypoint calls the same script** with `--bootstrap` for clone/bootstrap:

```
entrypoint.sh
  │
  ├─ WALG_CLONE_FROM set + PGDATA empty?
  │   └─► restore.sh --bootstrap --from $WALG_CLONE_FROM [--target-time $WALG_CLONE_TARGET_TIME]
  │
  ├─ setup backup cron (if WALG_S3_PREFIX set)
  └─ exec docker-entrypoint.sh
```

`--bootstrap` tells `restore.sh` to stop after fetching the backup and writing `recovery.signal` — it does **not** start PG. `docker-entrypoint.sh` handles PG startup, detects the `recovery.signal` file, and starts PG in recovery mode (WAL replay → promote).

**Why skipping PG startup is safe here**: `--bootstrap` is only used on the clone path, where PGDATA is empty. There is no pre-existing data, so there's nothing to snapshot or roll back — the auto-rollback steps (restore `.pre-restore`, restart PG on old data) are inherently no-ops. If `backup-fetch` fails, `restore.sh` exits non-zero and the container fails to start. If WAL replay fails after `docker-entrypoint.sh` starts PG, the container also crashes — but there's no prior state to recover, so rollback would be meaningless either way. The operator retries the clone or fixes the source.

Manual `restore.sh` (without `--bootstrap`) retains the full lifecycle — PG start, replay failure detection, and rollback to `.pre-restore` — because it operates on instances with existing data where rollback is both possible and critical.

After first boot, `PG_VERSION` exists in PGDATA, so the clone guard prevents re-running even if `WALG_CLONE_FROM` is still set.

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Single script | `restore.sh` handles all scenarios via flags (`--bootstrap` for entrypoint, full lifecycle for manual use) | Separate clone/restore scripts, duplicated logic in entrypoint | One implementation to test and maintain. `--bootstrap` skips PG startup so `docker-entrypoint.sh` controls the PG lifecycle on first boot. Safe because the clone path always has empty PGDATA — no prior state exists to roll back to (see entrypoint integration above). |
| Script manages PG lifecycle | Stops PG if running, starts after restore, restarts old data on failure | Caller manages stop/start | Makes the script safe to invoke from anywhere — no preconditions. Operator can't forget to stop PG first. |
| Auto-rollback on failure | Any failure → restore `.pre-restore`, restart PG on old data | Manual rollback, or just fail | Operator never inherits a broken state. Worst case: restore fails, PG comes back on previous data. |
| Pre-restore snapshot | Move PGDATA to `.pre-restore` | Wipe PGDATA, rely on backups | Local rollback without another backup-fetch cycle. Costs 2x disk temporarily. Skipped when PGDATA is empty (clone path). |
| `recovery_target_action` | `promote` (default) | `pause` | Fully automated flow. `pause` requires `pg_wal_replay_resume()` which complicates scripting and testing. |
| Auto-cleanup of recovery settings | Script resets `recovery_target_time` etc. from `postgresql.auto.conf` after promotion | Leave them (harmless after promote) | Stale settings in auto.conf are a maintenance hazard even if PG ignores them without `recovery.signal`. |
| Cross-instance restore | `--from` flag / `WALG_CLONE_FROM` env var, separate from the instance's own prefix | Single prefix, manual override | The instance's own prefix = "where this instance archives to" (version suffix appended at runtime — see [backup.md](backup.md)). `--from` = "where to read from" (full version-scoped path on the same cloud backend, e.g. `s3://bucket/source/18`). Temporarily overrides the active prefix for the fetch — does not change where the instance archives after restore. Cross-cloud restore is not supported. |
| WAL replay wait strategy | Process monitoring (poll `pg_is_in_recovery()` while postgres is alive) | Fixed timeout (`RESTORE_TIMEOUT=300s`) | PostgreSQL has no built-in replay timeout — it replays until done. WAL replay duration is unpredictable: it depends on WAL volume (hours/days of changes since the base backup), disk I/O throughput, and operation complexity — not on data size. A 1GB database with 24h of heavy writes takes longer than a 100GB database with 30min of idle WAL. Any fixed timeout is either too short (kills valid long replays) or too long (delays failure detection). Monitoring the process directly is both correct and simpler. |

## Implementation

### restore.sh

Accepts `--from SOURCE_PREFIX`, `--target-time TIMESTAMP`, and `--bootstrap` flags.

Behavior:

1. Stops PG if running (`pg_ctl status` check first)
2. If PGDATA has data (`PG_VERSION` exists) → moves to `PGDATA.pre-restore`
3. Defines a `rollback()` function that restores `.pre-restore` and restarts PG; registers it as a `trap` handler for `EXIT` / `SIGTERM` so pod drains or unexpected termination trigger automatic cleanup instead of leaving orphaned `.pre-restore` state
4. If `--from` specified → strips trailing slash (`${from%/}`), then validates it matches `/[0-9]+$` (a slash followed by one or more digits at the end, e.g. `/18`). Paths like `s3://bucket/pg18` (no slash before digits) are rejected with a fatal error: "--from must end with a version segment, e.g. s3://bucket/source/18". Trailing slashes (e.g. `s3://bucket/source/18/`) are handled gracefully by stripping before validation — consistent with how the entrypoint handles the instance's own prefix. This validation is intentionally duplicated from the entrypoint (defense-in-depth) — `restore.sh` enforces its own contract regardless of caller. Overrides the active prefix variable (whichever of `WALG_S3_PREFIX` / `WALG_GS_PREFIX` / `WALG_AZ_PREFIX` is set)
5. Runs `backup-fetch LATEST` → on failure calls `rollback`, exits 1
6. Writes `recovery.signal` to PGDATA. Appends `restore_command` to the `postgresql.auto.conf` already present in the fetched backup data (`backup-fetch` populates PGDATA including the source instance's `postgresql.auto.conf` — the script appends to it, not creates from scratch). If `--from` was specified, the `restore_command` embeds the source prefix inline so WAL segments are fetched from the correct location:
   - **Same-instance**: `restore_command = '. /etc/walg-env.sh && wal-g wal-fetch %f %p'`
   - **Cross-instance** (`--from`): `restore_command = '. /etc/walg-env.sh && WALG_S3_PREFIX=<source_prefix> wal-g wal-fetch %f %p'`
   This is critical for the `--bootstrap` clone path, where `walg-env.sh` is not yet written (entrypoint step 5 runs after clone detection in step 4) — and even for manual cross-instance restores, where `walg-env.sh` contains the instance's own prefix, not the source's
7. If `--target-time` set → appends `recovery_target_time` + `recovery_target_action = promote` to `postgresql.auto.conf`
8. If `--bootstrap` → returns here (PG startup delegated to `docker-entrypoint.sh`)
9. Starts PG and monitors WAL replay: polls `pg_is_in_recovery()` while the postgres process is alive. Replay duration is unbounded — it depends on WAL volume, not data size (see design note below). If the process exits or becomes unresponsive → calls `rollback`, exits 1
10. Resets recovery settings via `ALTER SYSTEM RESET`
11. Removes `.pre-restore`

### Entrypoint integration

In `entrypoint.sh`, before handing off to `docker-entrypoint.sh`:

- If `WALG_CLONE_FROM` set and PGDATA empty (`PG_VERSION` missing) → calls `restore.sh --bootstrap --from $WALG_CLONE_FROM` with optional `--target-time`
- `docker-entrypoint.sh` then sees populated PGDATA with `recovery.signal`, starts PG in recovery mode
- After first boot, `PG_VERSION` exists → clone guard prevents re-running

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WALG_CLONE_FROM` | — | Full version-scoped prefix of the source instance on the same cloud backend (e.g. `s3://bucket/source/18`). Triggers auto-restore on empty PGDATA. |
| `WALG_CLONE_TARGET_TIME` | — | Timestamp for PITR (e.g. `2026-02-13 12:00:00 UTC`). Omit for latest. |
`restore.sh` without `--from` uses the instance's own prefix (with version suffix already applied) and credentials — no additional config needed.

## Security Considerations

| Concern | Mitigation |
|---|---|
| `WALG_CLONE_FROM` grants read access to another instance's backups | Scope IAM role: clone needs only `s3:GetObject` + `s3:ListBucket` on the source prefix. No write/delete. |
| Restored data bypasses application-level access controls | Restored instance has the same PG users/roles as the source. Rotate passwords if cloning across trust boundaries. |
| `WALG_CLONE_FROM` left in config after bootstrap | Harmless — guarded by `PG_VERSION` check. Remove to avoid confusion. |
| Pre-restore snapshot doubles disk usage | Temporary — removed after success or rollback. Ensure PVC has headroom. |

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| `backup-fetch` fails (no backup, S3 error) | No restore | `.pre-restore` moved back, PG restarted on old data. Exit 1. |
| WAL gap (missing segments) | PG fails to start | Auto-rollback to `.pre-restore`. |
| Disk full during restore | `backup-fetch` or WAL replay fails | Auto-rollback to `.pre-restore`. May need to free space first. |
| Target time before oldest backup | No valid backup found | `backup-fetch` fails → auto-rollback. |
| Target time after latest WAL | PG replays all available WAL and promotes at that point | Silent partial success. PG logs actual recovery endpoint — monitor and compare. |
| Clone on non-empty PGDATA | Guarded by `PG_VERSION` check | Skipped. No action. |
| PG fails to start after successful fetch | Database inconsistent | Auto-rollback to `.pre-restore`. |

## Testing

### E2E — `tests/backup-restore.test.js`

Restore scenarios run in the shared PG + MinIO container pair, consuming backups created by the backup test group (see [testing.md](testing.md)):

- **PITR**: insert A → archive → insert B → `restore.sh --target-time <between A and B>` → A exists, B doesn't
- **DR (latest)**: insert data → `restore.sh` (no target) → all data present
- **Rollback on fetch failure**: mock `backup-fetch` failure → PG running on old data
- **Rollback on start failure**: mock PG start failure after fetch → PG running on old data
- **Idempotent stop**: run `restore.sh` when PG already stopped → no error
- **Empty PGDATA**: run `restore.sh` on empty dir → no `.pre-restore`, fetch + start
- **Recovery settings cleanup**: after PITR restore → `postgresql.auto.conf` does not contain `recovery_target_time` or `restore_command`
- **Bootstrap flag**: `restore.sh --bootstrap --from <prefix>` on empty PGDATA → `recovery.signal` exists, PGDATA populated, PG is NOT running

### E2E — `tests/clone.test.js`

Spins up two pg-phoenix-image containers + MinIO via Testcontainers (see [testing.md](testing.md)):

- **Clone latest**: instance A with data → instance B with `WALG_CLONE_FROM=A` → B has A's data
- **Clone with PITR**: insert at T1 and T2 → clone with `WALG_CLONE_TARGET_TIME=T1` → only T1 data
- **Clone idempotency**: restart B → `WALG_CLONE_FROM` ignored (PGDATA non-empty)
- **Clone bad source**: nonexistent prefix → container fails with clear error

# Restore Runbook

Three procedures, same tool. Pick the one matching your scenario. For design rationale and failure mode details, see [architecture/restore.md](architecture/restore.md).

## Pre-Flight Checklist

Before any restore:

- [ ] Confirm the target backup exists: `wal-g backup-list`
- [ ] Confirm WAL continuity to your target time: `wal-g wal-verify integrity`
- [ ] Ensure PVC has 2x free space (pre-restore snapshot temporarily doubles usage)
- [ ] Notify stakeholders — PG will be unavailable during restore

## Procedure 1: Disaster Recovery (Restore to Latest)

Recover to the most recent available state. Use when data is lost or corrupted.

```bash
# Exec into the pod
kubectl exec -it -n db pg-phoenix-image-0 -- sh

# Run restore — PG will stop, restore, replay all WAL, and restart
restore.sh
```

`restore.sh` handles everything: stop PG → snapshot PGDATA → fetch backup → replay WAL → start PG → clean up. If anything fails, it rolls back and restarts PG on the old data.

### Verify

```bash
# PG is running
pg_isready -U postgres

# Check data
psql -U postgres -c "SELECT count(*) FROM <your_table>;"
```

## Procedure 2: Point-in-Time Recovery

Recover to a specific timestamp. Use after accidental `DROP TABLE`, bad migration, or data corruption at a known time.

```bash
kubectl exec -it -n db pg-phoenix-image-0 -- sh

# Restore to a specific time (UTC)
restore.sh --target-time "2026-02-13 14:30:00 UTC"
```

PG replays WAL up to the target time and stops there. Transactions after that timestamp are discarded.

### Finding the Right Timestamp

```bash
# Check PG logs for when the bad event happened
cat /var/lib/postgresql/data/log/postgresql-$(date +%a).log | grep "DROP\|DELETE\|TRUNCATE"

# Or check backup coverage
wal-g backup-list
```

The target time must be between the oldest backup's start time and the latest archived WAL.

### Verify

```bash
psql -U postgres -c "SELECT max(created_at) FROM <your_table>;"
# Should be ≤ your target time
```

## Procedure 3: Clone from Another Instance

Create a new instance pre-loaded from another instance's backups. Use for staging refresh, migration, or cross-region DR.

### Option A: Via Manifest (Recommended)

Set these env vars on a **new** StatefulSet with an **empty PVC**:

```yaml
env:
  - name: WALG_CLONE_FROM
    value: "s3://bucket/source-instance/18"  # full version-scoped prefix
  # Optional: clone to a specific point in time
  - name: WALG_CLONE_TARGET_TIME
    value: "2026-02-12 09:00:00 UTC"
```

Deploy. The entrypoint detects empty PGDATA + `WALG_CLONE_FROM` and restores automatically. After first successful boot, remove `WALG_CLONE_FROM` from the manifest to avoid confusion.

`WALG_CLONE_FROM` must be the full version-scoped path — see [architecture/backup.md](architecture/backup.md) for the prefix layout.

### Option B: Manual

```bash
kubectl exec -it -n db pg-phoenix-image-new-0 -- sh

restore.sh --from "s3://bucket/source-instance/18"
# Or with PITR:
restore.sh --from "s3://bucket/source-instance/18" --target-time "2026-02-11 18:45:00 UTC"
```

The `--from` path must be the full version-scoped prefix (note the `/18` suffix) — see [architecture/backup.md](architecture/backup.md) for the prefix layout.

### Post-Clone Checklist

- [ ] Change `WALG_S3_PREFIX` to point to the new instance's own backup path (not the source's)
- [ ] Rotate passwords if crossing trust boundaries
- [ ] Remove `WALG_CLONE_FROM` from the manifest
- [ ] Take a fresh full backup: `backup.sh`

## Rollback

If a restore goes wrong, `restore.sh` automatically rolls back to the pre-restore snapshot (`.pre-restore` directory) and restarts PG on the old data.

If the restore succeeded but the data isn't what you expected, run `restore.sh` again with different parameters. The previous restore becomes the new pre-restore snapshot.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `backup-fetch` fails: "no backups found" | Wrong prefix, or no backups taken yet | Verify `WALG_S3_PREFIX` and run `wal-g backup-list` to confirm. |
| WAL replay stops before target time | WAL gap — missing segments between backup and target | Check `wal-g wal-verify integrity`. Take a fresh backup to anchor a new chain going forward. |
| "PGDATA is not empty" on clone | PVC already has data, clone guard prevents re-running | Use a fresh PVC, or wipe PGDATA manually before cloning. |
| Restore succeeded but PG won't accept connections | Recovery didn't complete promotion | Check PG logs. May need to run `SELECT pg_wal_replay_resume();` if paused. |
| Disk full during restore | PVC too small for backup + pre-restore snapshot | Free space or expand PVC. `restore.sh` will roll back if it detects failure. |

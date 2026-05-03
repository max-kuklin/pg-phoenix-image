# Restore Runbook

Restore is requested through environment variables and runs during pod startup. Do not run `restore.sh` manually in a live PostgreSQL pod; stopping PostgreSQL inside the container terminates the container lifecycle.

For design rationale and failure modes, see [architecture/restore.md](architecture/restore.md).

## Pre-Flight Checklist

- [ ] Confirm the target backup exists with `wal-g backup-list`.
- [ ] Confirm WAL continuity to the target time with `wal-g wal-verify integrity`.
- [ ] Confirm the PVC is mounted at `/var/lib/postgresql`.
- [ ] Confirm PVC headroom. Restoring over existing data can temporarily require current PGDATA, fetched data, and `pre-restore` to coexist.
- [ ] Choose a unique `PG_RESTORE_REQUEST_ID`. Keep it stable while retrying the same request; change it for a new restore.
- [ ] Stop application writes or route traffic away before restarting the pod.

## Restore to Latest

Set restore env vars on the StatefulSet:

```yaml
env:
  - name: PG_RESTORE
    value: "true"
  - name: PG_RESTORE_REQUEST_ID
    value: "incident-2026-05-03-latest"
  - name: PG_RESTORE_OVERWRITE
    value: "true"
```

Apply the manifest and restart the pod. The entrypoint fetches the latest backup from the instance's active WAL-G prefix, keeps the previous data directory as `pre-restore`, then starts PostgreSQL for WAL replay and promotion.

After validation, remove `PG_RESTORE` and `PG_RESTORE_OVERWRITE` from the manifest and restart during the next controlled maintenance window.

## Point-In-Time Recovery

Use the same startup flow with a target time:

```yaml
env:
  - name: PG_RESTORE
    value: "true"
  - name: PG_RESTORE_REQUEST_ID
    value: "incident-2026-05-03-pitr-1430"
  - name: PG_RESTORE_OVERWRITE
    value: "true"
  - name: PG_RESTORE_TARGET_TIME
    value: "2026-02-13 14:30:00 UTC"
```

The target time must be between the oldest usable base backup and the latest archived WAL needed for that point.

## Clone from Another Instance

For a new StatefulSet with an empty PVC:

```yaml
env:
  - name: PG_RESTORE_FROM
    value: "s3://bucket/source-instance/18"
  - name: PG_RESTORE_REQUEST_ID
    value: "staging-refresh-2026-05-03"
  - name: PG_RESTORE_TARGET_TIME
    value: "2026-02-12 09:00:00 UTC"
  - name: WALG_S3_PREFIX
    value: "s3://bucket/new-instance"
```

`PG_RESTORE_FROM` must include the source PostgreSQL major suffix. `WALG_S3_PREFIX` remains the destination instance's own backup prefix; after startup, backups are written under the destination prefix with the current major suffix appended by the image.

Remove `PG_RESTORE_FROM`, `PG_RESTORE_REQUEST_ID`, and `PG_RESTORE_TARGET_TIME` after the clone has booted successfully.

## Cross-Instance Restore Over Existing Data

Use `PG_RESTORE_FROM` when replacing an existing PVC from a source prefix:

```yaml
env:
  - name: PG_RESTORE
    value: "true"
  - name: PG_RESTORE_REQUEST_ID
    value: "incident-2026-05-03-cross-instance"
  - name: PG_RESTORE_FROM
    value: "s3://bucket/source-instance/18"
  - name: PG_RESTORE_OVERWRITE
    value: "true"
```

This reads from the source prefix for restore only. The instance continues archiving to its configured `WALG_S3_PREFIX` after PostgreSQL starts.

## Verify

Watch startup logs:

```bash
kubectl logs -f -n db pg-phoenix-image-0
```

Check PostgreSQL and application-level data:

```bash
kubectl exec -n db pg-phoenix-image-0 -- pg_isready -U postgres
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT count(*) FROM <your_table>;"
```

After a successful restore, take a fresh backup:

```bash
kubectl exec -n db pg-phoenix-image-0 -- backup.sh
```

## Rollback

If PostgreSQL starts but the restored data is not acceptable, roll back to the previous local data directory:

```yaml
env:
  - name: PG_RESTORE_ROLLBACK
    value: "true"
  - name: PG_RESTORE_REQUEST_ID
    value: "rollback-incident-2026-05-03"
```

Apply and restart the pod. The entrypoint moves current PGDATA to `failed-restore`, moves `pre-restore` back to PGDATA, then starts PostgreSQL on the previous data.

Remove `PG_RESTORE_ROLLBACK` after the rollback succeeds.

## Cleanup

After validation and a fresh backup:

- Remove restore or clone env vars from the StatefulSet.
- Decide whether to keep or delete `pre-restore`.
- Keep `failed-restore` only long enough for investigation.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `backup-fetch` reports no backups | Wrong prefix or no usable base backup | Verify source prefix and `wal-g backup-list`. |
| Restore refuses because request ID is missing | Explicit restore or rollback does not have an idempotency key | Add `PG_RESTORE_REQUEST_ID` and retry. |
| Restore env remains after a successful restore | Manifest cleanup has not happened yet | The completed request marker skips repeated restore. Remove restore env during cleanup. |
| Restore refuses to overwrite PGDATA | Missing `PG_RESTORE_OVERWRITE=true` | Add the overwrite gate only after confirming the target PVC is correct. |
| Restore refuses because `pre-restore` exists | Previous restore has not been cleaned up or rolled back | Validate the existing rollback point before removing it or set `PG_RESTORE_ROLLBACK=true`. |
| PostgreSQL fails during WAL replay | WAL gap, invalid target time, or incompatible restored data | Inspect PostgreSQL logs, then retry restore or roll back from `pre-restore`. |
| Disk full during restore | PVC lacks room for staged restore | Expand the PVC or remove unneeded retained restore directories. |

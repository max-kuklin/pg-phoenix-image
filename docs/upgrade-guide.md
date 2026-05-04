# Upgrade Guide

## Minor Upgrades (e.g. 18.1 → 18.2)

Minor upgrades are automatic when using Renovate. For design details, see [architecture/upgrade-minor.md](architecture/upgrade-minor.md).

### How It Works

1. Renovate detects a new `postgres:18` digest
2. Opens a PR updating the digest pin in the Dockerfile
3. CI builds → tests → merges (automerge if configured)
4. New `pg-phoenix-image:18-latest` image is pushed

### Deploying

Update the image tag in your StatefulSet and redeploy:

```bash
kubectl set image statefulset/pg-phoenix-image postgres=<registry>/pg-phoenix-image:18-latest -n db
```

Or update via GitOps (ArgoCD, Flux) — they pick up the new tag automatically if configured.

### Verify

```bash
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT version();"
```

No data migration needed. PG restarts on existing PGDATA — binary compatible.

---

## Major Upgrades (e.g. 18 → 19)

Operator-initiated. Requires an explicit gate. For design details and rollback phases, see [architecture/upgrade-major.md](architecture/upgrade-major.md).

### Pre-Upgrade Checklist

- [ ] Read the [PG release notes](https://www.postgresql.org/docs/release/) for breaking changes
- [ ] Confirm backups are healthy: `wal-g backup-list` + `wal-g wal-verify integrity`
- [ ] Confirm binary stash exists for current version:
  ```bash
  kubectl exec -n db pg-phoenix-image-0 -- ls /var/lib/postgresql/.pg-binaries/18/bin/postgres
  ```
  The stash is created on every boot, so it should always exist unless manually deleted.
- [ ] Test the upgrade in a non-production environment first (clone + upgrade)
- [ ] Schedule a maintenance window — PG will be unavailable during upgrade
- [ ] Adjust probes for the maintenance window — normal PostgreSQL is intentionally down until the upgrade finishes, so liveness must not restart the pod mid-upgrade. Temporarily disable liveness or use a `startupProbe` / failure threshold that covers backup, `pg_upgrade`, ANALYZE, and the first post-upgrade backup.
- [ ] Decide how long to retain the old version backup prefix. The upgrade freezes `.../18` and starts writing to `.../19`; keep the old prefix through the rollback window.

### Procedure

**1. Update image tag + set upgrade gate:**

```yaml
containers:
  - name: postgres
    image: <registry>/pg-phoenix-image:19-latest
    env:
      - name: PG_UPGRADE
        value: "true"
```

**2. Apply:**

```bash
kubectl apply -f statefulset.yaml -n db
```

The pod restarts. The entrypoint:
1. Detects version mismatch (PGDATA=18, binary=19) + `PG_UPGRADE=true`
2. Starts PG 18 from stashed binaries (non-standard port on localhost-only to prevent external clients from connecting during the backup)
3. Pushes a pre-upgrade backup to `.../18` prefix
4. Stops PG 18
5. Initializes `$PGDATA.new` with the PG 19 binaries
6. Runs `pg_upgrade --check` (dry run)
7. Runs `pg_upgrade --link`
8. Swaps data directories
9. Starts PG 19 as a temporary child process
10. Runs `ANALYZE`
11. Takes first backup on `.../19` prefix
12. Stops temporary PG 19, then hands off to normal container PostgreSQL

> Step 3 auto-verifies backup freshness (< 1 hour). If the latest backup is stale or missing, a fresh one is pushed automatically. If the backup push fails, the upgrade is refused.
>
> The PostgreSQL processes in steps 2 and 9 are not PID 1. They are `pg_ctl`-managed child processes owned by the upgrade script, so stopping them does not restart the container. PostgreSQL becomes the container's main process only after the final entrypoint handoff.

**3. Monitor the pod logs:**

```bash
kubectl logs -f -n db pg-phoenix-image-0
```

Expected phase markers:

- `starting PostgreSQL 18 for pre-upgrade backup`
- `pushing pre-upgrade backup`
- `checking PostgreSQL major upgrade`
- `running PostgreSQL major upgrade`
- `starting PostgreSQL 19 for post-upgrade verification`
- `running post-upgrade analyze`
- `pushing post-upgrade backup`
- `major upgrade completed; remove PG_UPGRADE=true before the next rollout`

**4. Remove the upgrade gate after success:**

```yaml
env:
  # Remove PG_UPGRADE=true
```

Reapply. Next restart proceeds normally on PG 19.

**5. Verify:**

```bash
# Version
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT version();"

# Data intact
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT count(*) FROM <your_table>;"

# New backup exists
kubectl exec -n db pg-phoenix-image-0 -- wal-g backup-list

# Post-upgrade table stats were refreshed
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c "SELECT relname, last_analyze FROM pg_stat_user_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY last_analyze NULLS FIRST LIMIT 10;"
```

Run one application-level smoke check before ending the maintenance window. The image proves PostgreSQL upgraded and backups resumed; it cannot prove application SQL semantics across a major PostgreSQL release.

### After the Rollout

- Remove `PG_UPGRADE=true` after the successful rollout. A restart with the gate still set is tolerated once PGDATA matches the image major, but leaving the gate in the manifest weakens the operator signal for the next major upgrade.
- Keep the old backup prefix until the rollback window closes. Then delete it manually or with a scoped object-storage lifecycle rule.
- Re-enable normal liveness settings if they were relaxed for the maintenance window.

### Rollback

| When you notice | What to do |
|---|---|
| **During upgrade** (pod logs show failure) | Automatic — data rolled back, container exits. Revert image to `pg-phoenix-image:18-latest`, remove `PG_UPGRADE`, redeploy. |
| **After upgrade** (app breaks on PG 19) | Revert image to `pg-phoenix-image:18-latest`, remove `PG_UPGRADE`, and request startup restore from the pre-upgrade backup on the `.../18` prefix. See [restore-runbook.md](restore-runbook.md). |

### Testing in Non-Production

Clone production, then upgrade the clone:

```yaml
# 1. Deploy a clone
env:
  - name: PG_RESTORE_FROM
    value: "s3://bucket/pg-phoenix-image-prod/18"
  - name: PG_RESTORE_REQUEST_ID
    value: "upgrade-test-clone-2026-05-03"
  - name: WALG_S3_PREFIX
    value: "s3://bucket/pg-phoenix-image-staging"

# 2. After clone boots, update image + set gate
image: <registry>/pg-phoenix-image:19-latest
env:
  - name: PG_UPGRADE
    value: "true"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "FATAL: PGDATA is version 18 but this image runs PostgreSQL 19" | `PG_UPGRADE` not set | Add `PG_UPGRADE=true` to env, or revert image to match data version. |
| "no stashed binaries for version 18" | Stash manually deleted or PVC mount issue | Restart once on current image to recreate, or verify PVC is mounted at `/var/lib/postgresql/`. |
| `pg_upgrade --check` fails | Incompatible extension, locale mismatch, etc. | Read the error in pod logs. Fix the issue (e.g. install missing extension on new version). |
| Pod restarts while upgrade is still running | Liveness probe is checking normal port 5432 before handoff | Disable liveness for the upgrade rollout or add a startup window long enough for the full upgrade. Then redeploy and retry. |
| Upgrade succeeded but app errors | PG 19 behavioral changes | Check PG release notes. Revert if needed (see Rollback above). |

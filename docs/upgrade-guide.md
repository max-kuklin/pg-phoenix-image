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
5. Runs `pg_upgrade --check` (dry run)
6. Runs `pg_upgrade --link`
7. Swaps data directories
8. Starts PG 19
9. Runs `ANALYZE`
10. Takes first backup on `.../19` prefix

> Step 3 auto-verifies backup freshness (< 1 hour). If the latest backup is stale or missing, a fresh one is pushed automatically. If the backup push fails, the upgrade is refused.

**3. Monitor the pod logs:**

```bash
kubectl logs -f -n db pg-phoenix-image-0
```

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
```

### Rollback

| When you notice | What to do |
|---|---|
| **During upgrade** (pod logs show failure) | Automatic — data rolled back, container exits. Revert image to `pg-phoenix-image:18-latest`, remove `PG_UPGRADE`, redeploy. |
| **After upgrade** (app breaks on PG 19) | Revert image to `pg-phoenix-image:18-latest`, remove `PG_UPGRADE`, redeploy. If PG 19 already wrote data, also run `restore.sh` from the pre-upgrade backup on the `.../18` prefix. See [restore-runbook.md](restore-runbook.md). |

### Testing in Non-Production

Clone production, then upgrade the clone:

```yaml
# 1. Deploy a clone
env:
  - name: WALG_CLONE_FROM
    value: "s3://bucket/pg-phoenix-image-prod/18"
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
| Upgrade succeeded but app errors | PG 19 behavioral changes | Check PG release notes. Revert if needed (see Rollback above). |

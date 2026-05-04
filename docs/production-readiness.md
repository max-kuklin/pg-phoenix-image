# Production Readiness Plan

This plan validates the implemented single-primary backup, restore, clone, rollback, and major-upgrade paths against the target infrastructure. It does not add new product scope; it proves the current operational contract outside the SeaweedFS test topology.

## Supported Boundary

Readiness applies to one PostgreSQL primary running `pg-phoenix-image` with WAL-G backups to object storage. The supported operations are deployment, WAL archiving, scheduled base backups, latest restore, PITR, clone from a version-scoped prefix, local restore rollback, minor image rollout, and explicit major-version upgrade.

Out of scope for this pass: streaming replicas, automatic failover, manual switchover, PgDog, live restore of a running PostgreSQL process, cross-region recovery guarantees, and application SQL compatibility across PostgreSQL major releases.

## Required Access

Use a disposable namespace, PVC, database name, and object-storage prefix. The tester needs enough access to create and delete only those scoped resources.

| Area | Required access | Why |
|---|---|---|
| Kubernetes | Create, update, restart, log, exec, and delete StatefulSets, Services, Secrets, ConfigMaps, ServiceAccounts, and PVCs in the test namespace | The operational guides are executed through normal rollout and pod lifecycle changes |
| Container registry | Push and pull the candidate image, plus an old-major image when testing major upgrade | Upgrade validation needs both current and target PostgreSQL image versions |
| Object storage | Scoped list, read, write, and delete permissions under the test prefix | Backup, restore, retention, WAL fetch, and cleanup all touch the prefix |
| IAM or static credentials | Ability to bind the scoped object-store identity to the pod | The pass must validate the same credential path intended for deployment |
| DNS and network policy | Pod egress to the object-store endpoint and registry | WAL-G failures from blocked egress must be distinguishable from credential failures |
| PostgreSQL client access | `kubectl exec` into the pod and application-level smoke queries | The image can prove PostgreSQL health; the tester must verify workload-specific data |
| Monitoring stack | Ability to add or inspect exporter scrape config and alerts, if monitoring is in scope for the release | Backup and database health alerts are part of the operator story |

For S3-compatible stores, the identity must be able to list the bucket with the chosen prefix, put objects, get objects, and delete objects under that prefix. Bucket-wide administration is not required. For AWS S3, include multipart upload permissions if the bucket policy restricts them separately.

## Test Data

Use data that exercises backup and restore time without making the first pass expensive. Start with a small smoke dataset, then repeat the restore and upgrade paths with a larger dataset sized to the expected maintenance window. Record database size, backup duration, restore duration, WAL replay duration, upgrade duration, and peak PVC usage.

The dataset should include at least one normal table, one index, one extension used by the workload, and enough writes after a base backup to prove PITR and WAL replay.

## Operational Guides To Execute Verbatim

Run these docs as written. Only substitute environment-specific names, image tags, bucket prefixes, credentials, namespaces, and table names.

| Order | Guide | Sections |
|---|---|---|
| 1 | [deployment.md](deployment.md) | Prerequisites, StatefulSet, Secret, Storage, Verification |
| 2 | [backup-setup.md](backup-setup.md) | Prerequisites, bucket setup, credentials, enable backups, verify, WAL continuity |
| 3 | [monitoring.md](monitoring.md) | Exporter sidecar, monitoring user, scrape config, backup health alerts |
| 4 | [restore-runbook.md](restore-runbook.md) | Pre-flight checklist, restore to latest, PITR, clone from another instance, rollback, cleanup |
| 5 | [upgrade-guide.md](upgrade-guide.md) | Minor upgrades, major upgrade checklist, procedure, verification, after-rollout cleanup, rollback decision table |

If a guide cannot be followed as written, treat that as a documentation defect or product gap. Do not silently patch the procedure during the pass.

## Scenario Matrix

### Baseline

Deploy the image without backup configuration and verify PostgreSQL starts, accepts connections, loads `pg_stat_statements`, and uses the shipped config with optional `conf.d` overrides. This proves the image still behaves as plain PostgreSQL when WAL-G is not configured.

### Backup

Enable backups with the target credential path and object-store prefix. Verify startup writes the WAL-G env file, archiving is active, a manual base backup appears in `wal-g backup-list`, WAL continuity passes, retention keeps the configured number of full backups, and no objects are written outside the version-scoped prefix.

### Provider Failure Modes

Repeat backup and restore attempts with deliberately scoped credential or prefix failures:

- missing credentials
- wrong bucket or prefix
- write denied during backup
- read denied during restore
- list denied for backup discovery
- empty source prefix for clone

The expected result is a clear startup or backup failure with existing PGDATA preserved when restore fetch fails before the swap.

### Restore And Clone

Execute latest restore, PITR, clone into an empty PVC, cross-instance restore over existing data, and explicit rollback. Verify the same `PG_RESTORE_REQUEST_ID` skips repeated startup safely, then remove one-shot restore env vars during cleanup so the steady-state manifest is clean.

### Upgrade

Run a non-production clone first, then perform the major upgrade flow on that clone. The upgrade script should automatically verify a recent pre-upgrade WAL-G backup, push one if needed, refuse to continue if it cannot verify the result, run `pg_upgrade --check`, run `pg_upgrade --link`, start the new PostgreSQL version, analyze, and push the first post-upgrade backup.

After success, remove `PG_UPGRADE=true`. Leaving it set is tolerated while PGDATA already matches the image major, but it weakens the operator signal for the next major-image rollout.

### Restart And Cleanup

Restart the pod after each one-shot operation before and after cleanup. Confirm idempotency markers prevent repeated restores or rollbacks for the same request ID, normal startup resumes after cleanup, and retained `pre-restore` or `failed-restore` directories are either intentionally kept or removed after the rollback window.

## Evidence To Capture

Record the image tag or digest, PostgreSQL major versions, WAL-G version, object-store provider, bucket/prefix, Kubernetes version, storage class, dataset size, timings, peak PVC usage, and links to pod logs for each scenario.

The pass is complete when every operational guide above has been executed verbatim in the target environment, all expected failures fail closed, and the remaining limitations are documented as release notes rather than hidden assumptions.

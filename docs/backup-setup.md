# Backup Setup

One-time configuration to enable continuous WAL archiving and scheduled base backups. For design rationale, see [architecture/backup.md](architecture/backup.md).

## Prerequisites

- pg-phoenix-image deployed and running (see [deployment.md](deployment.md))
- S3 bucket (or GCS/Azure equivalent) created
- IAM credentials or IRSA configured

## 1. S3 Bucket

Create a bucket with:
- **Versioning**: enabled (protects against accidental overwrites)
- **Server-side encryption**: AES256 or aws:kms
- **Lifecycle policy** (optional safety net): expire objects after 90 days

Bucket policy — restrict to the pod's IAM role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:DeleteObject"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket/pg-phoenix-image-prod/*",
        "arn:aws:s3:::your-bucket"
      ]
    }
  ]
}
```

## 2. Credentials

**Preferred: IRSA (IAM Roles for Service Accounts)**

No static keys. The pod assumes an IAM role via the service account:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: pg-phoenix-image
  namespace: db
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam:::<account>:role/pg-phoenix-image-backup
```

Add `serviceAccountName: pg-phoenix-image` to the StatefulSet pod spec.

**Fallback: Static keys via Secret**

```yaml
env:
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: pg-phoenix-image-backup-credentials
        key: access-key
  - name: AWS_SECRET_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: pg-phoenix-image-backup-credentials
        key: secret-key
  - name: AWS_REGION
    value: "us-east-1"
```

## 3. Enable Backups

Add these env vars to the StatefulSet:

```yaml
env:
  - name: WALG_S3_PREFIX
    value: "s3://your-bucket/pg-phoenix-image-prod"
  # Optional — defaults shown
  - name: WALG_COMPRESSION_METHOD
    value: "lz4"
  - name: WALG_S3_SSE
    value: "AES256"
  - name: WALG_DELTA_MAX_STEPS
    value: "7"
  # Required when WALG_S3_PREFIX is set — entrypoint refuses to start without it
  - name: BACKUP_SCHEDULE
    value: "0 2 * * *"
  - name: BACKUP_RETAIN_FULL
    value: "5"
  - name: ARCHIVE_TIMEOUT
    value: "60"
```

The image appends the PG major version to the prefix automatically (e.g. `s3://your-bucket/pg-phoenix-image-prod/18`). See [architecture/backup.md](architecture/backup.md) for why.

All supported variables and defaults: [architecture/backup.md — Configuration](architecture/backup.md#configuration).

Redeploy the StatefulSet. The entrypoint sets up WAL archiving and cron scheduling on next start.

## 4. Verify

```bash
# Check WAL archiving is active
kubectl exec -n db pg-phoenix-image-0 -- psql -U postgres -c \
  "SELECT archived_count, failed_count, last_archived_wal FROM pg_stat_archiver;"

# List backups
kubectl exec -n db pg-phoenix-image-0 -- wal-g backup-list

# Trigger a manual base backup
kubectl exec -n db pg-phoenix-image-0 -- backup.sh

# Verify backup appeared
kubectl exec -n db pg-phoenix-image-0 -- wal-g backup-list
```

## 5. Verify WAL Continuity

After backups are flowing, check for gaps:

```bash
kubectl exec -n db pg-phoenix-image-0 -- wal-g wal-verify integrity
```

## Tuning

All defaults are documented in [architecture/backup.md — Configuration](architecture/backup.md#configuration). Common adjustments:

| Change | Setting | Trade-off |
|---|---|---|
| Lower RPO | `ARCHIVE_TIMEOUT=30` | More S3 PUTs, lower data-at-risk |
| Longer retention | `BACKUP_RETAIN_FULL=10` | More storage cost |
| Faster backups | `WALG_COMPRESSION_METHOD=none` | Larger objects, faster push |
| Different schedule | `BACKUP_SCHEDULE="0 */6 * * *"` | More frequent base backups, faster restore (less WAL to replay) |

## Monitoring

Set up alerts for:
- `pg_stat_archiver.failed_count` increasing → WAL archiving broken
- No new backup in 48 hours → cron or script issue
- Disk usage rising → WAL backlog (archiving can't keep up)

See [monitoring.md](monitoring.md) for Prometheus alert rules.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `backup-list` returns empty | Backups not configured, or first backup hasn't run yet | Check `WALG_S3_PREFIX` is set. Run `backup.sh` manually. |
| `pg_stat_archiver.failed_count` > 0 | S3 credentials, bucket policy, or network issue | Check pod logs for `archive_command` errors. Verify IAM role/credentials. |
| WAL accumulating on disk | `archive_command` failing repeatedly | Same as above. PG retries automatically once the issue is fixed. |
| `wal-g wal-verify` shows gaps | Pod restarted before WAL was archived | Gaps mean PITR can't cross them. Take a new full backup to anchor a fresh chain. |

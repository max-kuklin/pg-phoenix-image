# Automatic Backups

## Purpose

Logical backup layer independent of the underlying storage. Block-level snapshots (EBS, etc.) protect against disk failure but not against `DROP TABLE`, application bugs, or corruption. WAL archiving to object storage provides:

- PITR to any second within the retention window (see [restore.md](restore.md))
- Cloning / disaster recovery (see [restore.md](restore.md))
- Configurable RPO — default 60s, bounded by `archive_timeout`

## Concept

WAL-G archives WAL segments to object storage as they complete. A forced segment switch every `archive_timeout` seconds bounds the RPO during idle periods. Periodic base backups anchor the WAL chain — any point between the oldest base backup and now is recoverable.

Delta (incremental) base backups store only pages changed since the last backup. After `WALG_DELTA_MAX_STEPS` deltas, a new full is forced:

```
FULL ──► delta ──► delta ──► delta ──► FULL ──► delta ──► ...
```

## Design Decisions

| Decision | Choice | Alternatives Considered | Rationale |
|---|---|---|---|
| Backup tool | WAL-G | pgBackRest, Barman | Official precompiled release binary (see [image.md](image.md)). Native S3/GCS/Azure, delta backups, lz4/zstd. Proven at scale (Spilo, Crunchy, Supabase). pgBackRest is more feature-rich but heavier to embed. |
| Version-prefixed S3 path | `$WALG_S3_PREFIX/<major>/` appended automatically | Single flat prefix, manual version directories | WAL-G has no concept of PG version — base backups, deltas, and WAL from different major versions would mix in the same directory. Delta backups could chain across the version boundary (corrupt). `delete retain` could remove the pre-upgrade backup. `wal-verify` reports false continuity. Appending `/<major>/` at runtime isolates each version cleanly. See [upgrade-major.md](upgrade-major.md) for prefix switch during upgrades. |
| Scheduling | In-container cron | Kubernetes CronJob | CronJob needs its own binary, credentials, and network access. In-container cron shares the existing env and PVC. |
| Compression | lz4 (default) | zstd, brotli | Best speed/ratio tradeoff for WAL where latency matters. Configurable. |
| Delta max steps | 7 | Full-only | Bounds restore time (at most 7 deltas to replay) while reducing daily backup size. |
| Retention | 5 full chains | Time-based | Predictable storage. With daily backups + 7 deltas/chain ≈ 40 days coverage. |
| Archive timeout | 60s | 0, 300s | Bounds RPO at 60s. Lower = more S3 PUTs; higher = more data at risk. |

## Implementation

### postgresql.conf

Key settings: `archive_mode = on`, `archive_command` calls `wal-g wal-push`, `wal_level = replica`. The base config sets `archive_timeout = 0` (disabled) — the entrypoint writes the operator's desired value (default 60s via `ARCHIVE_TIMEOUT`) to `conf.d/walg.conf` at startup, so forced WAL switches only happen when archiving is active.

### Version-prefixed S3 path

The entrypoint detects the active prefix variable (`WALG_S3_PREFIX` → `WALG_GS_PREFIX` → `WALG_AZ_PREFIX`, first set wins), strips any trailing slash (`${prefix%/}`), then appends `/<major>/`:

```
User sets:    WALG_S3_PREFIX=s3://bucket/pg-phoenix-image-prod
Runtime:      WALG_S3_PREFIX=s3://bucket/pg-phoenix-image-prod/18
```

This is transparent — the operator sets a base prefix, the image handles the version suffix. All WAL-G commands (archive, backup, restore) see the version-scoped prefix.

After a major upgrade (18 → 19), the prefix automatically changes to `.../19`. The old `.../18` prefix is frozen and retained for the rollback window.

### backup.sh

Before doing any work, checks `pg_isready`. If PG is not accepting connections (first boot, shutdown in progress), logs a warning and exits 0 — cron will retry on the next trigger.

Acquires an exclusive lock (`flock -n /var/run/backup.lock`) to prevent overlapping runs — if a prior backup is still running when cron fires again, the new invocation logs a warning and exits cleanly. The lock file lives on `/var/run` (tmpfs), so stale locks are impossible after container restart.

Sources WAL-G env, runs `wal-g backup-push`, then `wal-g delete retain FULL $BACKUP_RETAIN_FULL --confirm` for cleanup. On success, writes the current epoch to `/var/lib/postgresql/.last-backup-time` for external monitoring (see [metrics.md](metrics.md)).

Executed by cron.

### Entrypoint integration

On startup (only when a WAL-G prefix is set — `WALG_S3_PREFIX`, `WALG_GS_PREFIX`, or `WALG_AZ_PREFIX`):

1. Write all backup-related env vars to `/etc/walg-env.sh` — WAL-G vars (`WALG_*`, `AWS_*`) plus operational vars (`BACKUP_RETAIN_FULL`, `LOG_LEVEL`). The file must be **POSIX `/bin/sh`-sourceable** because it is sourced from both `archive_command` (executed via `/bin/sh -c`) and the cron job.

    Format: one line per variable:
    - `export NAME='VALUE'`

    Quoting/escaping:
    - Use POSIX single-quote escaping: wrap the value in single quotes and replace every `'` with `'"'"'` (close quote → literal single quote → reopen quote).
    - **Reject** values containing NUL (`\0`) or literal newlines (`\n`). NUL is not representable in shell strings; newlines make the env file multi-line and fragile.

    Then apply: `chown postgres:postgres`, `chmod 600`.
2. Write `/etc/postgresql/conf.d/walg.conf` — sets `archive_command = '. /etc/walg-env.sh && wal-g wal-push %p'` and `archive_timeout = $ARCHIVE_TIMEOUT` (overrides the placeholder `/bin/true` and default `60` from `postgresql.conf`)
3. If `BACKUP_SCHEDULE` is set → validate cron expression (reject malformed values with fatal error), write `/etc/cron.d/pg-backup` (see Cron schedule section below). If unset → **fatal error, refuse to start**. WAL archiving without scheduled base backups produces an unrestorable backup set — WAL segments are archived but `wal-g backup-fetch` requires at least one base backup to restore from.
4. Validate `ARCHIVE_TIMEOUT` is a non-negative integer (`^[0-9]+$`). Invalid → fatal error, refuse to start.
5. Start cron daemon
6. Hand off to standard PostgreSQL entrypoint

No WAL-G prefix set → backup setup is skipped entirely (including `BACKUP_SCHEDULE` and `ARCHIVE_TIMEOUT` validation). `archive_command` stays as `/bin/true` (completed WAL segments are discarded). Image behaves as plain PostgreSQL.

### Cron schedule

The `cron` daemon is installed at image build time (`apt-get install cron` in the Dockerfile). The crontab **entry** is created at runtime by the entrypoint because `BACKUP_SCHEDULE` is a dynamic env var. The entrypoint writes `/etc/cron.d/pg-backup`:

    SHELL=/bin/bash
    PATH=/usr/local/bin:/usr/bin:/bin
    $BACKUP_SCHEDULE postgres /usr/local/bin/backup.sh

Uses `/etc/cron.d/` (system crontab directory — entries include a user field) rather than `crontab -u postgres` to keep the configuration visible in the filesystem. The entry runs as the `postgres` user. `backup.sh` sources `/etc/walg-env.sh` internally for WAL-G credentials. The file must end with a trailing newline — Debian cron silently ignores entries without one.

### Object storage layout

```
s3://bucket/pg-phoenix-image-prod/
├── 18/                            ← PG 18 backups (isolated)
│   ├── basebackups_005/
│   │   ├── base_..._000010/       # full
│   │   ├── base_..._000020_D_.../  # delta
│   └── wal_005/
│       ├── 000000010000000000000001.lz4
│       └── ...
└── 19/                            ← PG 19 backups (after upgrade)
    ├── basebackups_005/
    └── wal_005/
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WALG_S3_PREFIX` | — | S3 base prefix. Required to enable backups. The PG major version is appended automatically at runtime (e.g. `s3://bucket/prefix` → `s3://bucket/prefix/18`). |
| `AWS_ACCESS_KEY_ID` | — | Static credentials (prefer IRSA instead) |
| `AWS_SECRET_ACCESS_KEY` | — | |
| `AWS_REGION` | — | |
| `WALG_COMPRESSION_METHOD` | `lz4` | `lz4`, `zstd`, `brotli`, `none` |
| `WALG_S3_SSE` | — | `AES256` or `aws:kms` |
| `WALG_DELTA_MAX_STEPS` | `7` | Deltas before forcing a full |
| `BACKUP_SCHEDULE` | — | Cron expression (UTC). **Required when any WAL-G prefix is set** — the entrypoint refuses to start without it because WAL archiving without base backups produces an unrestorable backup set. Must be a valid cron expression — invalid values cause startup failure. |
| `BACKUP_RETAIN_FULL` | `5` | Full chains to keep |
| `ARCHIVE_TIMEOUT` | `60` | Seconds before forced WAL switch. Must be a non-negative integer. Written to `conf.d/walg.conf` at startup. |

GCS/Azure: substitute `WALG_GS_PREFIX` / `WALG_AZ_PREFIX` and matching credentials. The entrypoint detects the active storage backend by checking prefix env vars in order: `WALG_S3_PREFIX` → `WALG_GS_PREFIX` → `WALG_AZ_PREFIX` (first set wins, warning logged if multiple are set). Version suffix is appended the same way. See [WAL-G docs](https://github.com/wal-g/wal-g#configuration).

## Security Considerations

| Concern | Mitigation |
|---|---|
| Credentials in env / process list | Prefer IRSA (no static keys). Fallback: Kubernetes Secrets, never plain manifests. |
| Backup data at rest | `WALG_S3_SSE=AES256` or `aws:kms`. Optional client-side encryption via `WALG_LIBSODIUM_KEY`. |
| Backup data in transit | WAL-G uses HTTPS by default. Enforce via S3 bucket policy (`aws:SecureTransport`). |
| Over-privileged IAM | Scope policy to the specific S3 prefix. Deny `s3:DeleteObject` if retention is handled separately. |
| Backup integrity | WAL-G checksums on upload/fetch. Enable S3 versioning. Periodic `wal-g backup-verify`. |
| Retention failure | Monitor backup age via Prometheus. S3 lifecycle policy (e.g. 90d) as safety net. |

## Failure Modes

| Failure | Detection | Impact | Recovery |
|---|---|---|---|
| `archive_command` fails | PG retries + logs. `pg_stat_archiver.failed_count` rises. WAL accumulates on disk. | No data loss while disk has space. Prolonged failure → disk full → downtime. | Fix cause. PG auto-retries the backlog. |
| Base backup fails | Script exits non-zero, logged. | WAL archiving continues. Restore window doesn't advance. | Fix issue, run manual backup. |
| S3 inaccessible | archive_command + backup failures. | Cannot backup or restore. Running DB unaffected. | Restore bucket or redirect to new location. |
| Disk full from WAL backlog | PG refuses writes. Health check fails. | Downtime. | Fix archiving. PG resumes and reclaims space. Or: remove oldest WAL (gap in PITR). |
| `BACKUP_SCHEDULE` missing with prefix set | Entrypoint refuses to start. | Container won't start. | Set `BACKUP_SCHEDULE` in manifest. |
| Invalid `ARCHIVE_TIMEOUT` | Entrypoint refuses to start. | Container won't start. | Fix value to a non-negative integer. |

## Testing

### E2E — `tests/backup-restore.test.js`

Backup scenarios run in the shared PG + MinIO container pair (see [testing.md](testing.md)):

- WAL-G configured and cron scheduled on startup
- `backup.sh` creates a base backup visible in `wal-g backup-list`
- Insert data → force WAL switch → segment exists in MinIO
- Delta backup created when full already exists
- Retention removes chains beyond limit
- No credentials configured → backup skipped gracefully (no crash)
- `archive_timeout` forces WAL switch during idle
- Version-prefixed path: set `WALG_S3_PREFIX=s3://minio/test` → backup lands under `s3://minio/test/18/`, not `s3://minio/test/`
- `wal-g backup-list` operates against the version-scoped prefix (only sees backups for current major version)

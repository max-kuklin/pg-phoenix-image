# Major Version Upgrades

## Purpose

Upgrade PostgreSQL across major versions (e.g. 18 → 19) in-place using `pg_upgrade --link`. Major versions change the on-disk data format — a binary swap is not enough, data must be migrated.

This is a deliberate, operator-initiated operation with an explicit gate, mandatory backup verification, and automatic rollback on failure.

## Concept

`pg_upgrade --link` converts the data directory using hard links — near-instant regardless of data size. It requires both old and new PG binaries simultaneously.

The image stashes a copy of its PG binaries on the PVC at every startup. When the operator bumps the image to a new major version and sets `PG_UPGRADE=true`, the entrypoint detects the version mismatch and runs the upgrade using the stashed old binaries. No network download, no fat image, no init container.

## Pre-Upgrade Checklist

Before deploying the new image with `PG_UPGRADE=true`:

1. **WAL-G compatibility** — verify the pinned WAL-G version (`WALG_VERSION` build arg) supports the target PG major version. Check [WAL-G release notes](https://github.com/wal-g/wal-g/releases). If a WAL-G upgrade is needed, do it in a separate image build first.
2. **Debian release match** — confirm `postgres:N` and `postgres:N+1` use the same Debian release (e.g. both bookworm). If not, the binary stash approach won't work — stashed binaries will fail with `libssl`/`libreadline` soname mismatches. Fall back to a two-image init-container approach.
3. **Test on a clone first** — use `WALG_CLONE_FROM` to spin up a copy of production, then upgrade the clone. Catches extension incompatibilities, locale issues, and `pg_upgrade --check` failures without risking the real instance.
4. **PVC headroom** — ensure at least 2× PGDATA free space. `pg_upgrade --link` uses hard links (minimal extra), but the swap step retains `$PGDATA.old` until post-upgrade cleanup. See [image.md](image.md) PVC sizing table.
5. **Verify recent backup** — the upgrade script refuses to proceed without a verified WAL-G backup within `PG_UPGRADE_BACKUP_MAX_AGE` (default 3600s). Confirm `wal-g backup-list` shows a recent entry, or let the upgrade script force one.

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Binary stash location | `/var/lib/postgresql/.pg-binaries/<major>/bin/` | Inside PGDATA, download from `apk` at upgrade time, fat image with N and N-1, init container | On the PVC but outside PGDATA. No network dependency. No fat image. No extra container. ~15MB per major version. Outside PGDATA means the stash runs unconditionally on every boot (including first) — no initdb hook needed. Survives `backup-fetch` (which replaces PGDATA). Reachable by both old and new PG versions during a major upgrade (`pg_upgrade` creates a new data directory adjacent to PGDATA, stash path is unaffected). |
| Binary stash timing | Every startup (idempotent) | Only when version changes | Simple — always current. If Debian patches a point release binary between restarts, the stash stays fresh. Skip if already matches (checksum). |
| Upgrade trigger | `PG_UPGRADE=true` env var | Auto-detect and upgrade, CLI flag | Explicit gate. Auto-upgrade on version mismatch is dangerous — operator must opt in. Without the gate, version mismatch → container refuses to start with clear error. |
| pg_upgrade mode | `--link` (hard links) | `--copy`, `--clone` (reflink) | `--link` is instant regardless of data size. Requires old and new data directories on the same filesystem (satisfied by default — `$PGDATA.new` is adjacent to `$PGDATA` on the same PVC). `--clone` requires a reflink-capable filesystem (not EBS/ext4). `--copy` doubles disk and time. |
| Pre-upgrade backup | Mandatory — refuse to upgrade without a verified recent WAL-G backup | Optional, trust the operator | The backup is the only rollback path from a post-upgrade failure. Without it, rollback means data loss. Non-negotiable. |
| Backup prefix after upgrade | Automatic — version suffix switches from `.../18` to `.../19` | Manual prefix change, single flat prefix | WAL-G has no concept of PG version. Mixed-version files in one prefix cause corrupt delta chains, broken `wal-verify`, and retention deleting the pre-upgrade backup. Version suffix is appended at runtime by the entrypoint — see [backup.md](backup.md). Old prefix is frozen for the rollback window. |
| Rollback — during upgrade | Data rolled back, container exits, operator reverts image | Auto-start old version from stash | `--link` doesn't modify old files. Script restores old PGDATA and exits with a clear message telling the operator to revert the image tag. No degraded-mode PG running on mismatched binaries. |
| Rollback — after upgrade | Operator reverts image + `restore.sh` from pre-upgrade backup | Automatic rollback | Can't auto-detect "new version subtly breaks my app." Human determines it's bad, reverts image. If new PG wrote data, `restore.sh` recovers from pre-upgrade backup. |
| Shared library compatibility | Assume consecutive PG major images share the same Debian release (bookworm) | Stash `/usr/lib/` deps, fat image with both PG versions, init container | Stashing binaries only works if system libraries match. Official `postgres:N` images track the same Debian release across adjacent majors. If a future PG version switches Debian release (bookworm → trixie), the stash approach breaks — fall back to a fat image or init container for that transition. |

## Implementation

### Binary Stash

On every startup, before PG is started:

1. Read current PG major version from `postgres --version`
2. Compute checksum of key binaries (`postgres`, `pg_upgrade`, `pg_ctl`, `pg_resetwal`, `pg_dump`, `pg_dumpall`)
3. Compare to `/var/lib/postgresql/.pg-binaries/<major>/checksum`
4. If missing or different → copy binaries from `/usr/local/bin/` to stash, write checksum
5. If match → skip

The stash lives at `/var/lib/postgresql/.pg-binaries/` — on the PVC but outside PGDATA. This is deliberate: PGDATA must be empty for `initdb` on first boot, and the stash path must be version-independent so both old and new PG versions can find it during an upgrade. The stash is a sibling of PGDATA on the same PVC, unaffected by `pg_upgrade`'s temporary data directories.

Stash structure:
```
/var/lib/postgresql/.pg-binaries/
└── 18/
    ├── bin/
    │   ├── postgres
    │   ├── pg_upgrade
    │   ├── pg_ctl
    │   ├── pg_resetwal
    │   ├── pg_dump
    │   └── pg_dumpall
    └── checksum
```

**Prerequisite**: The PVC must be mounted at `/var/lib/postgresql/`. This is the default for official `postgres:*` images (PGDATA is `/var/lib/postgresql/data`), so the stash directory is always a sibling of the data directory on the same filesystem.

**Constraint**: The stashed binaries are dynamically linked against Debian system libraries. This approach assumes that `postgres:N` and `postgres:N+1` share the same Debian base release. Verify this before each major upgrade — if the new image uses a different Debian release, the stashed old binaries may fail with `libssl`/`libreadline` soname mismatches. In that case, use a two-image init-container approach instead.

### Startup Version Check

Before handing off to `docker-entrypoint.sh`:

1. If PGDATA empty → normal first boot, no check
2. Read `$PGDATA/PG_VERSION` → data version (e.g. `18`)
3. Read running binary version (e.g. `19`)
4. If match → proceed normally
5. If mismatch + `PG_UPGRADE=true` → run upgrade flow
6. If mismatch + no gate → **refuse to start**, log error:
   ```
   FATAL: PGDATA is version 18 but this image runs PostgreSQL 19.
   Set PG_UPGRADE=true to perform an in-place major upgrade.
   Ensure you have a verified backup before proceeding.
   ```

### Upgrade Flow

**WAL-G compatibility**: Before upgrading PG major version, verify the pinned WAL-G version (`WALG_VERSION` build arg) supports the target PG version. Check [WAL-G release notes](https://github.com/wal-g/wal-g/releases). If a WAL-G upgrade is needed, do it in a separate image build and deploy *before* the PG major upgrade — never combine both changes.

The upgrade script registers a `trap` handler for `EXIT` / `SIGTERM` that cleans up partial state: removes `$PGDATA.new` if incomplete, swaps `$PGDATA.old` back to `$PGDATA` if the swap was interrupted. This ensures pod drains or unexpected termination during upgrade don't leave the PVC in an unrecoverable state.

```
upgrade (entrypoint detects version mismatch + PG_UPGRADE=true)
  │
  ├─ verify old binaries exist at /var/lib/postgresql/.pg-binaries/18/bin/
  │   └─ MISSING → refuse, log "no stashed binaries for version 18"
  │
  ├─ save original (un-suffixed) prefix: BASE_PREFIX=$WALG_S3_PREFIX
  │
  ├─ PRE-UPGRADE BACKUP (must use old PG + old prefix)
  │   ├─ start PG 18 from stashed binaries on localhost:5433:
  │   │     /var/lib/postgresql/.pg-binaries/18/bin/pg_ctl start -D $PGDATA \
  │   │       -o "-c listen_addresses=localhost -p 5433"
  │   ├─ export PGHOST=localhost PGPORT=5433
  │   │     (WAL-G reads PGHOST/PGPORT for connection discovery —
  │   │      must be set before any wal-g command against the temporary instance)
  │   ├─ set WALG_S3_PREFIX to $BASE_PREFIX/18 (old version prefix)
  │   ├─ verify recent backup (wal-g backup-list, latest within PG_UPGRADE_BACKUP_MAX_AGE)
  │   │   └─ no backup or stale → run wal-g backup-push
  │   │       └─ FAILS → stop PG 18, refuse to upgrade, exit 1
  │   ├─ stop PG 18: pg_ctl stop -m fast
  │   └─ unset PGHOST PGPORT (restore default connection settings for pg_upgrade and subsequent steps)
  │
  ├─ mkdir -p /tmp/pg_upgrade && cd /tmp/pg_upgrade
  │   (deterministic CWD — pg_upgrade writes helper scripts to CWD)
  │
  ├─ pg_upgrade --check (dry run)
  │   └─ FAILS → log incompatibility, exit 1 (PGDATA untouched)
  │
  ├─ pg_upgrade --link \
  │     --old-bindir=/var/lib/postgresql/.pg-binaries/18/bin \
  │     --new-bindir=/usr/local/bin \
  │     --old-datadir=$PGDATA \
  │     --new-datadir=$PGDATA.new
  │   └─ FAILS → remove $PGDATA.new, log error, exit 1:
  │     "UPGRADE FAILED during pg_upgrade. PGDATA is intact on version 18.
  │      Revert image to pg-phoenix-image:18-latest and redeploy."
  │
  ├─ swap: mv $PGDATA $PGDATA.old ; mv $PGDATA.new $PGDATA
  │
  ├─ start PG 19 on new data (using image binaries)
  │   └─ FAILS → swap back ($PGDATA.old → $PGDATA), log error, exit 1:
  │     "UPGRADE FAILED: new PG would not start. Data rolled back to version 18.
  │      Revert image to pg-phoenix-image:18-latest and redeploy."
  │
  ├─ run recommended post-upgrade steps:
  │   ├─ run `/tmp/pg_upgrade/analyze_new_cluster.sh` generated by `pg_upgrade`
  │   │   (executes `vacuumdb --all --analyze-in-place` to update optimizer statistics)
  │   └─ if PG_UPGRADE_KEEP_OLD=true → log size and path, keep $PGDATA.old
  │      else → rm -rf $PGDATA.old, log reclaimed space
  │
  ├─ set WALG_S3_PREFIX to $BASE_PREFIX/19 (new version prefix)
  ├─ take immediate full backup on new prefix (wal-g backup-push)
  │   (PG 19 is still running — backup-push requires a live server)
  ├─ old prefix ($BASE_PREFIX/18) frozen — retained for rollback window
  │
  ├─ stop PG 19: pg_ctl stop -m fast
  │
  ├─ restore original prefix: WALG_S3_PREFIX=$BASE_PREFIX
  │   (entrypoint step 3 will append /<major>/ as usual)
  │
  ├─ stash new version binaries to /var/lib/postgresql/.pg-binaries/19/
  ├─ remove old version stash (/var/lib/postgresql/.pg-binaries/18/)
  ├─ rm -rf /tmp/pg_upgrade
  └─ log reminder to remove PG_UPGRADE from manifest
```

**Why start old PG for the backup**: `wal-g backup-push` requires a running PostgreSQL. At this point the container image is PG 19 but PGDATA is PG 18 — the image binaries can't start on old data. The stashed PG 18 binaries are used to start PG briefly on `localhost:5433`, push the backup to the `.../18` prefix, then stop cleanly before `pg_upgrade` runs. Using a non-standard port on localhost-only prevents external clients from connecting during the backup window. The script exports `PGHOST=localhost` and `PGPORT=5433` before any `wal-g` command so WAL-G discovers the temporary instance, then unsets both after stopping PG 18 to avoid affecting `pg_upgrade` and subsequent steps. Note: `default_transaction_read_only=on` cannot be used here because `wal-g backup-push` calls `pg_backup_start()`, which writes to WAL and is rejected in a read-only transaction.

**Prefix handling during upgrade**: The upgrade script saves the original (un-suffixed) prefix in a local variable (`BASE_PREFIX`) before any WAL-G operations. It temporarily overrides `WALG_S3_PREFIX` to `$BASE_PREFIX/18` for the pre-upgrade backup and `$BASE_PREFIX/19` for the post-upgrade backup, then restores the original un-suffixed value before returning to the entrypoint. This ensures entrypoint step 3 (version-prefix) can apply the correct `/<major>/` suffix without producing a double-suffix like `.../18/19`.

`pg_upgrade` creates a **new** data directory — not in-place mutation. The `--link` flag makes this fast by hard-linking data files from old to new. The swap step (`mv`) is atomic on the same filesystem.

### Rollback Phases

| Phase | What failed | Data state | Recovery |
|---|---|---|---|
| Pre-upgrade checks | Backup missing, `--check` fails, no stashed binaries | PGDATA untouched | Fix issue and retry, or revert image |
| `pg_upgrade --link` | Upgrade itself fails | Old PGDATA untouched (`--link` doesn't modify source) | Container exits → operator reverts image tag |
| New PG startup | PG won't start on new data | Script swaps old data dir back | Container exits → operator reverts image tag |
| Post-upgrade (app breakage) | Discovered later by operator | New PG has been writing data | Operator reverts image + runs `restore.sh` from pre-upgrade WAL-G backup. Loses writes since upgrade. |

### Old Prefix Cleanup

After a successful upgrade, the old version prefix (e.g., `$BASE_PREFIX/18`) is frozen — no new backups are written to it, but its data is retained for rollback. If the operator needs to revert (see rollback phases above), `restore.sh` fetches from this prefix.

**Recommended approach**: retain the old prefix for a fixed rollback window (7 days minimum), then purge:

1. Verify the upgraded instance is stable and the new prefix has healthy backup chains (`wal-g backup-list`)
2. Purge: `WALG_S3_PREFIX=s3://bucket/prod/18 wal-g delete everything --confirm`
3. As a safety net, configure an S3 lifecycle policy scoped to old version prefixes (e.g., expire objects after 90 days)

No automation — major upgrades are infrequent and the cleanup decision requires operator judgment. The old prefix consumes storage but poses no operational risk if left indefinitely.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PG_UPGRADE` | — (unset) | Set to `true` to enable major version upgrade. Remove after successful upgrade. |
| `PG_UPGRADE_KEEP_OLD` | `false` | If `true`, retain `$PGDATA.old` after successful upgrade for manual inspection. If `false`, delete immediately after post-upgrade ANALYZE and backup complete. |
| `PG_UPGRADE_BACKUP_MAX_AGE` | `3600` | Maximum age (seconds) of the most recent backup before upgrade proceeds without forcing a fresh one. Set to `0` to always force a fresh backup. |

## Security Considerations

| Concern | Mitigation |
|---|---|
| Stashed binaries could be tampered with on a compromised PVC | Checksum verification before use. However, if the PVC is compromised, the entire database is too — this is not a new attack surface. |
| `pg_upgrade` runs as postgres user | Same privilege level as PG itself. No escalation. |
| Pre-upgrade backup contains all data | Same security boundary as regular backups — IAM-scoped S3 access, server-side encryption. |

## Failure Modes

| Failure | Phase | Impact | Behavior |
|---|---|---|---|
| No stashed old binaries | Pre-upgrade | Can't upgrade | Refuses to start. Stash should always exist (created on every boot including the first). If manually deleted, restart once on the current version to recreate it. |
| `pg_upgrade --check` fails | Pre-upgrade | Can't upgrade | PGDATA untouched. Incompatible extension, locale mismatch, etc. Operator fixes the issue or stays on old version. |
| `pg_upgrade --link` fails mid-run | During upgrade | New data dir incomplete | Old PGDATA untouched (link, not copy). Script removes partial new dir. Container exits with message: revert image to old version. |
| New PG fails to start | Post-upgrade | New data dir exists but PG won't run | Script swaps old data dir back. Container exits with message: revert image to old version. |
| New PG starts but app breaks (discovered later) | Post-upgrade, post-start | Running but broken | Operator reverts image tag. If data was written on new version, operator runs `restore.sh` from pre-upgrade WAL-G backup. Loses writes since upgrade. |
| WAL-G backup fails before upgrade | Pre-upgrade | Can't upgrade | Refuses to proceed without verified backup. Operator fixes backup issue first. |

## Testing

### E2E — `tests/upgrade.test.js`

Spins up pg-phoenix-image (two major versions) + MinIO containers via Testcontainers (see [testing.md](testing.md)):

**Upgrade flow:**
- Version mismatch without gate → container refuses to start with clear error
- Version mismatch with `PG_UPGRADE=true` → upgrade completes, data intact
- Pre-upgrade backup gate: no backup → upgrade refused
- Rollback on `pg_upgrade` failure: mock failure → PGDATA intact, container exits
- Rollback on post-upgrade start failure: mock PG crash → old data restored, container exits
- Backup prefix switch: after upgrade, `wal-g backup-list` on the new version prefix returns at least one backup; pre-upgrade backup exists on the old version prefix
- Post-upgrade ANALYZE: `pg_stat_user_tables.last_analyze` is recent after upgrade completes
- Stash lifecycle: after upgrade, `.pg-binaries/19/` exists, `.pg-binaries/18/` removed
- `PG_UPGRADE=true` left set after success: restart with matching versions + gate still set → normal startup, no re-upgrade

**Binary stash:**
- Fresh start → stash created
- Restart with same version → stash unchanged (idempotent)
- Stash checksum matches actual binaries
- Minor upgrade (same major) → stash updated with new checksum

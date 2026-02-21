# Docker Image

## Purpose

Define how the image is built, what goes into each layer, and why. The image is the single deliverable — everything else (K8s manifests, scripts, config) only matters if they're baked in or mountable at runtime.

## Concept

Single-stage build. Extends the official `postgres:18` (Debian bookworm) image, downloads the precompiled WAL-G release binary, copies in scripts, config, and minimal runtime packages.

```
┌─────────────────────────────────┐
│  postgres:18 (Debian bookworm)  │
│  ├─ apt: cron                   │
│  ├─ WAL-G release binary        │
│  ├─ COPY scripts/               │
│  ├─ COPY config/                │
│  └─ ENTRYPOINT                  │
└─────────────────────────────────┘
```

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Base image | `postgres:18` (Debian bookworm) | `postgres:18-alpine` (~80MB) | Debian allows using official precompiled WAL-G release binaries directly — no build stage, no Go toolchain, simpler Dockerfile. Alpine requires building WAL-G from source (`CGO_ENABLED=0`) because release binaries are glibc-linked. The ~320MB size increase is acceptable given the simpler build, broader package compatibility, and reduced maintenance burden (no musl edge cases). |
| WAL-G installation | Precompiled release binary from GitHub | Build from source (multi-stage), distro package | Release binaries are glibc-linked (why Debian, not Alpine). Pinned to an exact release tag with SHA-256 verification. Single `curl` + `tar` — no Go toolchain, no multi-stage build, no build cache invalidation on Go module updates. |
| Cron provider | Debian `cron` package | `busybox` crond, `dcron`, `supercrond` | Standard Debian cron daemon for scheduled base backups. No extra dependencies beyond base repos. |
| Config approach | Ship `postgresql.conf` with `include_dir = 'conf.d'` | Env-var templating, full ConfigMap override | No custom scripting layer. Users mount a ConfigMap into `conf.d/` to override individual settings without replacing the entire file. See [slow-query-log.md](slow-query-log.md) for precedence details. |
| pg_stat_statements | Built-in (Debian image includes contrib) | External build | `postgres:18` ships with contrib modules. Just needs `shared_preload_libraries` in `postgresql.conf`. |

## Build

Base: `postgres:18` (Debian bookworm)

Runtime packages (via `apt-get install --no-install-recommends`):

| Package | Purpose |
|---|---|
| `cron` | Cron daemon for backup scheduling |
| `curl` | Fetches WAL-G binary during build (purged after) |

WAL-G installation:

1. Download release tarball from GitHub (`wal-g-pg-ubuntu-20.04-amd64.tar.gz`)
2. Extract binary to `/usr/local/bin/wal-g`
3. Remove tarball and purge `curl`

Copied artifacts:

| Source | Destination | Purpose |
|---|---|---|
| `scripts/*` | `/usr/local/bin/` | Entrypoint, backup, restore, upgrade |
| `config/postgresql.conf` | `/etc/postgresql/postgresql.conf` | Defaults with `include_dir = 'conf.d'` |
| `config/pg_hba.conf` | `/etc/postgresql/pg_hba.conf` | Auth config |

Directories created:

| Path | Purpose |
|---|---|
| `/etc/postgresql/conf.d/` | Mount point for ConfigMap overrides |

### Entrypoint

Wraps the official `docker-entrypoint.sh` — see [entrypoint.md](entrypoint.md) for orchestration details.

### Config Loading

The image's `postgresql.conf` lives at `/etc/postgresql/postgresql.conf`, outside PGDATA. The entrypoint passes `-c config_file=/etc/postgresql/postgresql.conf` when handing off to `docker-entrypoint.sh`, overriding the default PGDATA-relative lookup. This keeps the shipped config separate from user data while still allowing runtime overrides via `conf.d/`, `ALTER SYSTEM`, or `-c` flags (see [slow-query-log.md](slow-query-log.md) for precedence).

### HEALTHCHECK

The Dockerfile includes a `HEALTHCHECK` using `pg_isready` for `docker run` users. Kubernetes deployments should configure liveness/readiness probes independently (see [deployment.md](../deployment.md)).

`--start-period=60s` accounts for `initdb` and normal startup but not WAL replay during restore or clone. Operators running PITR or clone scenarios via `docker run` should override with `--health-start-period=<duration>` or disable the healthcheck and rely on external monitoring.

## Security Considerations

| Concern | Mitigation |
|---|---|
| Debian CVEs | Rebuild regularly. Pin base image digest in CI for reproducibility, update digest when patching. |
| WAL-G supply chain | Pin to a release tag. Verify SHA-256 checksum of the downloaded binary in the Dockerfile. |
| Unnecessary packages | Only `cron` added beyond base. `curl` is purged after WAL-G download. Debian ships more packages than Alpine by default — review `dpkg -l` periodically. |
| Root vs postgres user | Scripts run as `postgres` user (inherited from base image). Only cron setup requires root during entrypoint init, then drops privileges. |

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| WAL-G download fails (GitHub/network) | Image build fails | CI catches it. Pin a known-good WAL-G tag. Cache the tarball in CI if GitHub rate-limits. |
| Debian base image unavailable | Image build fails | Use digest pinning — cache works even if Docker Hub is slow. |
| `cron` not found at runtime | Backup scheduling fails, PG itself works fine | Entrypoint logs a warning and continues without scheduled backups. WAL archiving still works (triggered by PG, not cron). |

## PVC Sizing

Minimum PVC headroom depends on which features are active:

| Operation | Temporary disk cost | Duration |
|---|---|---|
| Normal operation | PGDATA + WAL backlog (bounded by archiving speed) + logs (bounded by `log_rotation_size`) | Ongoing |
| Restore (`restore.sh`) | 2× PGDATA (`.pre-restore` snapshot) | Until restore completes or rolls back |
| Major upgrade (`upgrade.sh`) | PGDATA + `$PGDATA.new` (minimal with `--link` — hard links, not copies) + `$PGDATA.old` (retained until post-upgrade cleanup) | Until post-upgrade cleanup |
| Binary stash | ~15MB per major version | Permanent |

**Recommendation**: provision at least 2.5× the expected data size. This covers the restore snapshot with headroom for WAL backlog and logs. Major upgrades need less additional space than restores because `--link` avoids copying data.

## Testing

### E2E — `tests/pg-only.test.js`

Image scenarios run in the shared PG-only container (see [testing.md](testing.md)):

- PG accepts connections with default config
- Config file location: `SHOW config_file` returns `/etc/postgresql/postgresql.conf`
- `conf.d/` override: mount `override.conf` with `work_mem = 128MB` → `SHOW work_mem` returns `128MB`
- WAL-G binary exists and runs `wal-g --version`
- `cron` binary exists

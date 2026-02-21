# Prometheus Metrics

## Purpose

Expose PostgreSQL internals to Prometheus. The image's role is limited: enable `pg_stat_statements` and create the extension. The exporter sidecar and scrape configuration are deployment concerns, not image concerns.

## What the Image Provides

### pg_stat_statements

Tracks execution statistics (calls, total time, rows, blocks) for every SQL statement. This is the primary data source for query performance monitoring.

Enabled via `postgresql.conf`:
```
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 5000
pg_stat_statements.track = all
track_io_timing = on
```

`shared_preload_libraries` requires a restart — it's set in the image's base `postgresql.conf`, active from first boot. `track_io_timing` enables I/O timing in `pg_stat_statements` (`blk_read_time` / `blk_write_time` columns) — negligible overhead on modern kernels.

### Extension Init Script

The image ships a `docker-entrypoint-initdb.d/` script that runs on first `initdb`:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

This creates the extension in the default database. For additional databases, the operator creates it manually or via an init script.

### Backup Age

`backup.sh` writes the current epoch to `/var/lib/postgresql/.last-backup-time` after each successful backup (see [backup.md](backup.md)). This provides a simple, dependency-free way to monitor backup recency:

- **Exporter textfile collector**: configure the postgres-exporter sidecar to read the file as a custom gauge metric (`pg_phoenix_last_backup_epoch`). Alert if `time() - pg_phoenix_last_backup_epoch > threshold`.
- **Direct file age check**: monitor the file's mtime from a liveness/readiness probe or external script. No PG connection required.

The image does not expose this metric natively — the exporter sidecar configuration is a deployment concern (see [monitoring.md](../monitoring.md)).

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| `pg_stat_statements` enabled by default | Yes — `shared_preload_libraries` in base config | Disabled by default, opt-in | Negligible overhead (~0.1% CPU). The data is essential for performance analysis. Every production PG should have this. |
| `pg_stat_statements.track` | `all` | `top`, `none` | `top` misses queries inside functions/procedures. `all` captures everything. Slightly more memory but bounded by `max`. |
| `pg_stat_statements.max` | `5000` | `1000`, `10000` | Tracks up to 5000 distinct query fingerprints. Sufficient for most workloads. Each entry ~500 bytes → ~2.5MB total. Override via `conf.d/` mount. |
| Exporter in image? | No — sidecar at deployment time | Baked into image | Exporter version, config, and resource limits are deployment-specific. Sidecar pattern keeps the image focused on PG. |

## Configuration

All settings in `postgresql.conf` with sensible defaults. Override via `conf.d/` mount or `ALTER SYSTEM`:

| Setting | Default | Requires Restart | Description |
|---|---|---|---|
| `shared_preload_libraries` | `pg_stat_statements` | Yes | Must include `pg_stat_statements`. |
| `pg_stat_statements.max` | `5000` | Yes | Max tracked statements. |
| `pg_stat_statements.track` | `all` | No (reload) | `all`, `top`, or `none`. |
| `track_io_timing` | `on` | No (reload) | Enables I/O timing for `blk_read_time` / `blk_write_time` in `pg_stat_statements`. |

### Exporter Sidecar (deployment-level)

Not part of the image. At deployment time, add a `postgres-exporter` sidecar container (e.g. `quay.io/prometheuscommunity/postgres-exporter`) to the pod spec. It connects to PG on localhost and exposes metrics on port 9187. See [monitoring.md](../monitoring.md) for the sidecar manifest and scrape configuration.

## Security Considerations

| Concern | Mitigation |
|---|---|
| `pg_stat_statements` exposes full query text | Query text may contain PII. Access is restricted to superuser and `pg_read_all_stats` role by default. The exporter sidecar should connect as a dedicated monitoring user with minimal privileges. |
| Statement reset clears monitoring data | `pg_stat_statements_reset()` is superuser-only. Don't grant it to the monitoring user. |

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| `shared_preload_libraries` missing | Extension can't be created | PG starts fine but `CREATE EXTENSION pg_stat_statements` fails. Requires config fix + restart. |
| Extension not created in a database | Exporter queries fail for that database | Create it manually: `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` |
| `pg_stat_statements.max` too low | Least-used statements evicted | Queries disappear from tracking. Increase max, restart. |

## Testing

### E2E — `tests/pg-only.test.js`

Metrics scenarios run in the shared PG-only container (see [testing.md](testing.md)):

- `pg_stat_statements` extension exists after first boot
- Run queries → `pg_stat_statements` view returns rows with call counts
- `pg_stat_statements.track = all` captures queries inside functions
- `pg_stat_statements.max` matches configured value

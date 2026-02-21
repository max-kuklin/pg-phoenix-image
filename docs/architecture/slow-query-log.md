# Slow Query Log

## Purpose

Surface queries that exceed a duration threshold — the primary tool for identifying performance regressions, missing indexes, and N+1 patterns in production without adding runtime overhead to every query.

## Concept

PostgreSQL's built-in `log_min_duration_statement` logs any query that exceeds the configured threshold. No sampling, no external agent, no performance overhead on queries that finish under the threshold. Logged queries include the full SQL text, duration, user, database, application name, and client host.

Logs are written to rotating files on the data volume (persisted across restarts) and optionally to stderr for Kubernetes log collection (Fluentd, Loki, CloudWatch).

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Mechanism | `log_min_duration_statement` | `auto_explain`, `pg_stat_statements` with `min_exec_time`, external proxy logging | Native PG feature, zero overhead for fast queries. `auto_explain` adds EXPLAIN plans but has measurable CPU cost. `pg_stat_statements` aggregates but doesn't log individual executions. |
| Default threshold | `-1` (disabled) | — | Workload-specific. Users enable and tune via `ALTER SYSTEM` or config mount. |
| Log destination | File (default), optionally stderr | stderr-only, syslog | File logging persists across restarts and doesn't depend on K8s log collection. stderr is useful for centralized log pipelines but loses data if the container is evicted before collection. Both can be enabled simultaneously. |
| Log rotation | Weekly (7-day cycle), 100MB max, truncate on rotation | Size-only, external logrotate | PG's built-in `logging_collector` handles rotation. `%a` filename pattern produces 7 files (one per weekday) that overwrite after one week. Truncate-on-rotation prevents unbounded disk growth. |

## Implementation

### postgresql.conf defaults

The image ships a `postgresql.conf` with these defaults. The file ends with `include_dir = 'conf.d'`, so users can override any setting by mounting a ConfigMap into `conf.d/` without replacing the entire file. `ALTER SYSTEM` and `-c` flags also work.

- `log_min_duration_statement = -1` — disabled by default. Set to a positive value (ms) to enable.
- `log_statement = 'none'` — avoids double-logging (the duration log already includes the query text)
- `log_duration = off` — only slow queries get logged, not all
- `logging_collector = on` — PG manages its own log files
- `log_destination = 'stderr'` — can be changed to `'csvlog'` or `'jsonlog'`
- `log_directory = 'log'` — relative to PGDATA, persisted on PVC
- `log_filename = 'postgresql-%a.log'` — 7-day weekly rotation (overwrites same weekday, bounding disk to 7 × `log_rotation_size`)
- `log_line_prefix = '%t %a %u@%d %h '` — timestamp, app name, user@database, remote host
- `log_rotation_size = 100MB` — additional rotation if a single day produces large logs
- `log_truncate_on_rotation = on` — overwrites old files to bound disk usage

No entrypoint templating — these are plain `postgresql.conf` values. The final line `include_dir = 'conf.d'` allows partial overrides.

## Configuration

All settings are in `postgresql.conf` with sensible defaults. Override options (last-value-wins):

1. **`conf.d/` override** — mount a ConfigMap into `/etc/postgresql/conf.d/` with only the settings you want to change. The image's `postgresql.conf` includes `include_dir = 'conf.d'` at the end, so these take precedence.
2. **`ALTER SYSTEM`** — runtime change, persisted in `postgresql.auto.conf` (loaded after `conf.d/`). Some settings require `SELECT pg_reload_conf()`, others require restart.
3. **`-c` flag** — pass settings via container args (e.g. `postgres -c log_min_duration_statement=100`). Highest precedence.

| Setting | Default | Requires Restart | Description |
|---|---|---|---|
| `log_min_duration_statement` | `-1` | No (reload) | Threshold in ms. `-1` = disabled. |
| `log_line_prefix` | `%t %a %u@%d %h ` | No (reload) | Prefix for each log line. [Placeholders reference](https://www.postgresql.org/docs/current/runtime-config-logging.html#GUC-LOG-LINE-PREFIX). |
| `log_destination` | `stderr` | No (reload) | `stderr`, `csvlog`, `jsonlog` |
| `logging_collector` | `on` | Yes | PG manages log files. |
| `log_directory` | `PGDATA/log/` | No (reload) | Log file location. |
| `log_filename` | `postgresql-%a.log` | No (reload) | 7-day weekly rotation. `%a` = abbreviated weekday — files overwrite after one week. |
| `log_rotation_size` | `100MB` | No (reload) | Max file size before rotation. |
| `log_truncate_on_rotation` | `on` | No (reload) | Overwrite old files on rotation. |



## Security Considerations

| Concern | Mitigation |
|---|---|
| Slow query logs contain full SQL text, which may include sensitive data (passwords in `CREATE USER`, PII in `WHERE` clauses) | Logs are on the PVC — same access boundary as the database itself. If streaming to stderr for centralized collection, ensure the log pipeline has appropriate access controls. Consider `log_min_duration_statement` for DDL-heavy workloads where credentials may appear. |
| Log files fill disk | `log_rotation_size` + `log_truncate_on_rotation` + `%a` filename pattern cap disk to 7 × `log_rotation_size` (700MB default). |

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| Log directory disk full | PG continues operating but stops writing logs. Warnings in stderr. | PG doesn't crash — logging degrades gracefully. Free disk space or reduce retention. |
| `logging_collector` fails to start | PG starts without file logging. Logs go to stderr only. | Check PG startup logs for collector errors. |
| Threshold too low (e.g. 1ms) | Massive log volume, disk fills quickly | Increase `log_min_duration_statement`. Rotation/truncation provides some protection. |

## Testing

### E2E — `tests/pg-only.test.js`

Slow-query-log scenarios run in the shared PG-only container (see [testing.md](testing.md)):

- Default (`-1`): `pg_sleep(1)` does NOT appear in log — disabled by default
- Enable via `ALTER SYSTEM`: set to `500`, reload → `pg_sleep(1)` logged, `SELECT 1` not logged
- Custom threshold: set to `100`, reload → 200ms query logged, 50ms query not logged
- Disable: set back to `-1`, reload → slow query not logged
- Log rotation: verify log filename matches `postgresql-%a.log` pattern (abbreviated weekday)
- Log line prefix: enable logging, run slow query → log line contains timestamp, user@database, and client host

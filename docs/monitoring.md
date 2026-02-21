# Monitoring

How to connect pg-phoenix-image to Prometheus and set up useful alerts. For image-level metrics configuration, see [architecture/metrics.md](architecture/metrics.md).

## Exporter Sidecar

Add `postgres-exporter` as a sidecar in the StatefulSet pod spec:

```yaml
- name: postgres-exporter
  image: quay.io/prometheuscommunity/postgres-exporter:0.16.0
  ports:
    - name: metrics
      containerPort: 9187
  env:
    - name: DATA_SOURCE_URI
      value: "localhost:5432/postgres?sslmode=disable"
    - name: DATA_SOURCE_USER
      value: "monitoring"
    - name: DATA_SOURCE_PASS
      valueFrom:
        secretKeyRef:
          name: pg-phoenix-image-credentials
          key: monitoring-password
  resources:
    requests:
      cpu: 10m
      memory: 32Mi
    limits:
      memory: 64Mi
```

### Monitoring User

Create a dedicated low-privilege user (run once after first boot):

```sql
CREATE ROLE monitoring LOGIN PASSWORD '<password>';
GRANT pg_read_all_stats TO monitoring;
GRANT CONNECT ON DATABASE postgres TO monitoring;
```

Do **not** grant `pg_stat_statements_reset()` to this user.

### Prometheus Scrape

Add annotations to the StatefulSet pod template, or use a ServiceMonitor:

**Annotations approach:**

```yaml
metadata:
  annotations:
    prometheus.io/scrape: "true"
    prometheus.io/port: "9187"
    prometheus.io/path: "/metrics"
```

**ServiceMonitor (Prometheus Operator):**

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: pg-phoenix-image
  namespace: db
spec:
  selector:
    matchLabels:
      app: pg-phoenix-image
  endpoints:
    - port: metrics
      interval: 30s
```

## Key Metrics

### Query Performance (pg_stat_statements)

| Metric | What it tells you |
|---|---|
| `pg_stat_statements_calls` | Query frequency — spikes indicate traffic changes or runaway loops |
| `pg_stat_statements_mean_exec_time_seconds` | Per-query latency — watch for regressions after deploys |
| `pg_stat_statements_rows` | Rows processed — sudden jumps hint at missing indexes or seq scans |

### Database Health

| Metric | What it tells you |
|---|---|
| `pg_up` | 0 = exporter can't reach PG. First thing to alert on. |
| `pg_stat_activity_count` | Active connections by state. Watch `idle in transaction`. |
| `pg_stat_bgwriter_buffers_backend` | Backend writes — high values mean shared_buffers is undersized |
| `pg_replication_lag` | If using streaming replicas, lag in bytes/seconds |

### Backup Health

WAL-G doesn't export Prometheus metrics natively. Monitor via:

- **Backup age**: Use `/var/lib/postgresql/.last-backup-time` written by the backup script.
- **WAL archive lag**: `pg_stat_archiver.last_archived_time` — how long since the last WAL was archived.
- **Failed archives**: `pg_stat_archiver.failed_count` — should be 0.

## Alerting Rules

```yaml
groups:
  - name: pg-phoenix-image
    rules:
      - alert: PostgresDown
        expr: pg_up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "PostgreSQL is unreachable"

      - alert: WALArchiveLag
        expr: time() - pg_stat_archiver_last_archive_time > 3600
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "No WAL archived in the last hour"

      - alert: ArchiveFailures
        expr: rate(pg_stat_archiver_failed_count[5m]) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "WAL archiving failures detected"

      - alert: TooManyConnections
        expr: pg_stat_activity_count > 80
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Connection count approaching max_connections (100)"

      - alert: HighIdleInTransaction
        expr: pg_stat_activity_count{state="idle in transaction"} > 5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Multiple sessions stuck in 'idle in transaction'"

      - alert: SlowQueryLogSpike
        expr: rate(pg_stat_statements_calls{queryid!=""}[5m]) > 1000
        for: 5m
        labels:
          severity: info
        annotations:
          summary: "Unusual query call rate — check slow query log"
```

Tune thresholds to your workload. `max_connections` default is 100; adjust `TooManyConnections` if you change it.

## Grafana

No bundled dashboard. Recommended community dashboards:

- [PostgreSQL Database (ID 9628)](https://grafana.com/grafana/dashboards/9628) — general overview
- [pg_stat_statements (ID 12485)](https://grafana.com/grafana/dashboards/12485) — query-level drill-down

Import via Grafana UI → Dashboards → Import → paste ID. Point the data source at your Prometheus instance.

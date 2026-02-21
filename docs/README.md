# Documentation

## Architecture (design rationale)

How and why each feature works. Read these to understand design decisions, trade-offs, and failure modes.

| Doc | Covers |
|---|---|
| [image.md](architecture/image.md) | Docker image build, base image choice, WAL-G installation |
| [entrypoint.md](architecture/entrypoint.md) | Startup orchestration — version check, clone, backup setup, handoff |
| [backup.md](architecture/backup.md) | WAL archiving, base backups, delta chains, version-prefixed S3 paths |
| [restore.md](architecture/restore.md) | Disaster recovery, PITR, clone — single script, auto-rollback |
| [upgrade-major.md](architecture/upgrade-major.md) | In-place `pg_upgrade --link`, binary stash, rollback phases |
| [upgrade-minor.md](architecture/upgrade-minor.md) | Renovate-driven rebuild cycle, digest pinning |
| [metrics.md](architecture/metrics.md) | `pg_stat_statements` setup, exporter sidecar boundary |
| [slow-query-log.md](architecture/slow-query-log.md) | `log_min_duration_statement`, rotation, `conf.d/` override mechanism |
| [logging.md](architecture/logging.md) | Script logging library, verbosity levels, output format |

## Operational Guides (how-to)

Step-by-step procedures for running the system.

| Guide | When to use |
|---|---|
| [deployment.md](deployment.md) | First-time deploy of the StatefulSet, services, storage, spot setup |
| [backup-setup.md](backup-setup.md) | Enable WAL archiving and scheduled base backups |
| [monitoring.md](monitoring.md) | Prometheus exporter sidecar, alerts, Grafana dashboards |
| [restore-runbook.md](restore-runbook.md) | Disaster recovery, PITR, or cloning from backups |
| [upgrade-guide.md](upgrade-guide.md) | Minor and major PostgreSQL version upgrades |

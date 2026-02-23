# pg-phoenix-image

<p align="center">
  <img src="assets/logo.png" alt="pg-phoenix-image logo" width="300">
</p>

Custom PostgreSQL Docker image based on postgres:18 (Debian), built to rise again — automatically and quickly recover on Kubernetes with spot-instance nodes. Ships with simple operational scripts for automated WAL-G backups, point-in-time recovery, and safe major-version upgrades. Fully e2e tested.

Born after 5+ years of running PostgreSQL on Kubernetes+Istio with Patroni/Spilo and a desire for simpler, more reliable operations.

> [!CAUTION]
> This is a work in progress. Not in usable state yet.

## Features

- **Automatic Backups** — continuous WAL archiving + scheduled base backups via WAL-G
- **Restore & Clone** — PITR to any timestamp, disaster recovery, clone from another instance's backups
- **Safe Major-Version Upgrades** — in-place `pg_upgrade --link` with automatic rollback on failure
- **Minor Version Tracking** — CI rebuilds on base image changes, fully tested before push
- **Prometheus Metrics** — `pg_stat_statements` + postgres_exporter sidecar support
- **Slow Query Log** — log queries exceeding a configurable duration threshold
- **Spot Instance Optimized** — fast shutdown, instant startup, no cold downloads (deployment-level, see `docs/deployment.md`)
- **Complete Test Suite** — e2e integration tests for every feature above (Node.js + Testcontainers)

## Project Structure

```
pg-phoenix-image/
├── Dockerfile
├── renovate.json      # base image digest tracking
├── scripts/           # entrypoint, backup, restore, bootstrap, upgrade, healthcheck
├── config/            # postgresql.conf, pg_hba.conf
├── tests/             # e2e tests (Node.js + Testcontainers)
└── docs/
    ├── architecture/  # feature design docs (backup, restore, upgrades, metrics, etc.)
    └── *.md           # operational guides (deployment, backup-setup, restore, upgrade, monitoring)
```

## Quick Start

```bash
# Build
docker build -t pg-phoenix-image:18-latest .

# Run (no backups)
docker run -d -e POSTGRES_PASSWORD=changeme -p 5432:5432 pg-phoenix-image:18-latest

# Run tests
npm test                   # e2e (PG + MinIO via Testcontainers)
```

See [docs/](docs/) for backup configuration, Kubernetes deployment, PITR procedures, and upgrade runbooks.

## Planned Features (not yet implemented) 

- Streaming replication / Read replicas
- Automatic failover / Manual switchover
- PgDog connection pooling

## License

[Apache License 2.0](LICENSE)

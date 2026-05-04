# pg-phoenix-image

<p align="center">
  <img src="assets/logo.png" alt="pg-phoenix-image logo" width="300">
</p>

Custom PostgreSQL Docker image based on postgres:18 (Debian), built to rise again by keeping WAL-G backup and startup restore operations close to the database runtime.

Born after 5+ years of running PostgreSQL on Kubernetes+Istio with Patroni/Spilo and a desire for simpler, more reliable operations.

> [!CAUTION]
> This is a work in progress. Not in usable state yet.

## Implemented Features

- **PostgreSQL 18 image baseline** - shipped config, `pg_stat_statements`, WAL-G, cron, and `conf.d` override support.
- **Automatic backups** - WAL archiving plus scheduled base backups through WAL-G when a storage prefix is configured.
- **Startup restore and clone foundation** - restore latest backup or a PITR target during container startup, including request-id idempotency and local rollback staging.
- **Major-version upgrade foundation** - explicit `PG_UPGRADE` gate, stashed old PostgreSQL binaries, mandatory WAL-G backup verification, in-place `pg_upgrade --link`, rollback cleanup, and post-upgrade backup.
- **Container-first tests** - Bash contract tests plus container coverage for startup gates, image startup, WAL-G backup, and startup restore against SeaweedFS S3.

## Project Structure

```text
pg-phoenix-image/
|-- Dockerfile
|-- scripts/           # entrypoint, backup, restore, upgrade, shared Bash libs
|-- config/            # postgresql.conf, pg_hba.conf
|-- tests/             # contract and Testcontainers suites
`-- docs/
    |-- architecture/  # design docs and implementation plan
    `-- *.md           # operational guides
```

## Quick Start

```bash
# Build
docker build -t pg-phoenix-image:18-latest .

# Run without backups
docker run -d -e POSTGRES_PASSWORD=changeme -p 5432:5432 pg-phoenix-image:18-latest

# Run tests
npm test
```

See [docs/](docs/) for backup configuration, Kubernetes deployment, PITR procedures, and upgrade design notes.

## Planned Features

- Streaming replication / read replicas
- Automatic failover / manual switchover
- PgDog connection pooling

## License

[Apache License 2.0](LICENSE)

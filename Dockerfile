# pg-phoenix-image Dockerfile
# -----------------------------------------------
# postgres:18.3-bookworm + precompiled WAL-G + scripts + config

# Pin base image digest for reproducible builds. Release builds override this
# from release-tracks.json for each supported PostgreSQL major.
ARG PG_BASE=postgres:18.3-bookworm@sha256:80630f83606d8db77d30b3851b16a9f78be2d0d4dda6f7b82a1fdca5ebe3acba
FROM ${PG_BASE}

ARG PG_BASE
ARG WALG_VERSION=v3.0.8
ARG WALG_SHA256=8a0ca72ff3aa10d5a288cdb3e5b2a2e7bc6f8b4ffcf7b3046d718cfeee99a7e7
ARG IMAGE_SOURCE
ARG IMAGE_VERSION
ARG IMAGE_REVISION
ARG PG_TRACK_MAJOR
ARG PG_TRACK_MINOR

LABEL org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.pg-phoenix.postgres.base="${PG_BASE}" \
      org.pg-phoenix.postgres.major="${PG_TRACK_MAJOR}" \
      org.pg-phoenix.postgres.minor="${PG_TRACK_MINOR}"

# Runtime dependency (cron) + precompiled WAL-G binary
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates cron curl; \
    curl -fSL -o /tmp/wal-g.tar.gz \
        "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-20.04-amd64.tar.gz"; \
    echo "${WALG_SHA256}  /tmp/wal-g.tar.gz" | sha256sum -c -; \
    tar xzf /tmp/wal-g.tar.gz -C /usr/local/bin/; \
    mv /usr/local/bin/wal-g-pg-20.04-amd64 /usr/local/bin/wal-g; \
    chmod +x /usr/local/bin/wal-g; \
    rm /tmp/wal-g.tar.gz; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Logging library
COPY image/lib/logger.sh /usr/local/lib/logger.sh
COPY image/lib/walg.sh /usr/local/lib/walg.sh
COPY image/lib/restore-args.sh /usr/local/lib/restore-args.sh

# Scripts
COPY image/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY image/backup.sh     /usr/local/bin/backup.sh
COPY image/restore.sh    /usr/local/bin/restore.sh
COPY image/upgrade.sh    /usr/local/bin/upgrade.sh
COPY image/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh \
             /usr/local/bin/restore.sh /usr/local/bin/upgrade.sh

# Config
COPY config/postgresql.conf /etc/postgresql/postgresql.conf
COPY config/pg_hba.conf     /etc/postgresql/pg_hba.conf
RUN mkdir -p /etc/postgresql/conf.d

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD pg_isready -U postgres

ENTRYPOINT ["entrypoint.sh"]
CMD ["postgres"]

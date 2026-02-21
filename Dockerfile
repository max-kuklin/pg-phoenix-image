# pg-phoenix-image Dockerfile
# -----------------------------------------------
# postgres:18 (Debian) + precompiled WAL-G + scripts + config

# Pin base image digest for reproducible builds — Renovate Bot updates this.
# Get digest: docker pull postgres:18 && docker inspect --format='{{index .RepoDigests 0}}' postgres:18
# TODO: pin to postgres:18@sha256:<digest> once Renovate is configured (see docs/architecture/upgrade-minor.md)
ARG PG_BASE=postgres:18
FROM ${PG_BASE}

ARG WALG_VERSION=v3.0.3
ARG WALG_SHA256=e56f515e6219f4d498e729023b404b4c9068a4deaebbaf95ac6f4cf6bcd1a783

# Runtime dependency (cron) + precompiled WAL-G binary
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends cron curl; \
    curl -fSL -o /tmp/wal-g.tar.gz \
        "https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/wal-g-pg-ubuntu-20.04-amd64.tar.gz"; \
    echo "${WALG_SHA256}  /tmp/wal-g.tar.gz" | sha256sum -c -; \
    tar xzf /tmp/wal-g.tar.gz -C /usr/local/bin/; \
    mv /usr/local/bin/wal-g-pg-ubuntu-20.04-amd64 /usr/local/bin/wal-g; \
    chmod +x /usr/local/bin/wal-g; \
    rm /tmp/wal-g.tar.gz; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Logging library
COPY scripts/lib/logger.sh /usr/local/lib/logger.sh

# Scripts
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/backup.sh     /usr/local/bin/backup.sh
COPY scripts/restore.sh    /usr/local/bin/restore.sh
COPY scripts/upgrade.sh    /usr/local/bin/upgrade.sh
COPY scripts/docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
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

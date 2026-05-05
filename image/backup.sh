#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=backup
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"

WALG_ENV_FILE="${WALG_ENV_FILE:-/etc/walg-env.sh}"
BACKUP_LOCK_FILE="${BACKUP_LOCK_FILE:-/var/run/postgresql/backup.lock}"
PG_MAJOR="${PG_MAJOR:-18}"
PGDATA="${PGDATA:-/var/lib/postgresql/$PG_MAJOR/docker}"

if [[ "$PGDATA" == "/var/lib/postgresql/data" ]]; then
  PGDATA="/var/lib/postgresql/$PG_MAJOR/docker"
fi
export PGDATA

if ! pg_isready -q; then
  log_warn "PostgreSQL is not ready; skipping backup"
  exit 0
fi

if [[ ! -r "$WALG_ENV_FILE" ]]; then
  log_warn "WAL-G env file not found; skipping backup"
  exit 0
fi

. "$WALG_ENV_FILE"

(
  if ! flock -n 9; then
    log_warn "backup already running; skipping"
    exit 0
  fi

  log_phase "starting base backup"
  wal-g backup-push "$PGDATA"

  retain_full="${BACKUP_RETAIN_FULL:-5}"
  log_info "applying retention policy: keep $retain_full full backups"
  wal-g delete retain FULL "$retain_full" --confirm

  date +%s > /var/lib/postgresql/.last-backup-time
  log_info "base backup completed"
) 9>"$BACKUP_LOCK_FILE"

#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=upgrade
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"

PG_OLD_MAJOR="${PG_OLD_MAJOR:-}"
PG_NEW_MAJOR="${PG_NEW_MAJOR:-}"
PGDATA="${PGDATA:-}"
PG_BINARY_STASH_ROOT="${PG_BINARY_STASH_ROOT:-/var/lib/postgresql/.pg-binaries}"
PG_UPGRADE_BACKUP_MAX_AGE="${PG_UPGRADE_BACKUP_MAX_AGE:-3600}"
PG_UPGRADE_REQUIRED_OLD_BINARIES=(postgres pg_upgrade pg_ctl pg_resetwal pg_dump pg_dumpall)

validate_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

require_env() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    log_fatal "$name is required"
  fi
}

require_old_binaries() {
  local old_bin_dir="$PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/bin"
  local binary

  if [[ ! -d "$old_bin_dir" ]]; then
    log_fatal "no stashed PostgreSQL binaries for version $PG_OLD_MAJOR at $old_bin_dir"
  fi

  for binary in "${PG_UPGRADE_REQUIRED_OLD_BINARIES[@]}"; do
    if [[ ! -x "$old_bin_dir/$binary" ]]; then
      log_fatal "required stashed PostgreSQL $PG_OLD_MAJOR binary is missing or not executable: $old_bin_dir/$binary"
    fi
  done
}

require_env PG_OLD_MAJOR
require_env PG_NEW_MAJOR
require_env PGDATA

validate_non_negative_int "$PG_UPGRADE_BACKUP_MAX_AGE" || log_fatal "PG_UPGRADE_BACKUP_MAX_AGE must be a non-negative integer"

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  log_fatal "PGDATA does not contain PG_VERSION: $PGDATA"
fi

require_old_binaries

log_fatal "upgrade execution is not implemented yet"

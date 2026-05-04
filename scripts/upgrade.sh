#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=upgrade
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"
. "${WALG_LIB_PATH:-/usr/local/lib/walg.sh}"

PG_OLD_MAJOR="${PG_OLD_MAJOR:-}"
PG_NEW_MAJOR="${PG_NEW_MAJOR:-}"
PGDATA="${PGDATA:-}"
PG_BINARY_STASH_ROOT="${PG_BINARY_STASH_ROOT:-/var/lib/postgresql/.pg-binaries}"
PG_UPGRADE_BACKUP_MAX_AGE="${PG_UPGRADE_BACKUP_MAX_AGE:-3600}"
PG_UPGRADE_TEMP_PORT="${PG_UPGRADE_TEMP_PORT:-5433}"
WALG_ENV_FILE="${WALG_ENV_FILE:-/etc/walg-env.sh}"
PG_UPGRADE_REQUIRED_OLD_BINARIES=(postgres pg_upgrade pg_ctl pg_resetwal pg_dump pg_dumpall)
old_pg_started=false

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

old_bin_dir() {
  printf '%s/%s/bin\n' "$PG_BINARY_STASH_ROOT" "$PG_OLD_MAJOR"
}

as_postgres() {
  if [[ "$(id -u)" -eq 0 ]] && command -v gosu >/dev/null 2>&1; then
    gosu postgres "$@"
    return $?
  fi

  "$@"
}

write_walg_env_file() {
  local output="$WALG_ENV_FILE"
  local temp="${output}.tmp"
  local prefix_name="$1"
  local prefix_value="$2"
  local name

  : > "$temp"

  while IFS='=' read -r name _; do
    case "$name" in
      WALG_*|AWS_*|GOOGLE_*|AZURE_*|BACKUP_RETAIN_FULL|LOG_LEVEL)
        if [[ "$name" != "$prefix_name" ]]; then
          walg_write_export_line "$name" "${!name}" >> "$temp" || log_fatal "invalid newline in $name"
        fi
        ;;
    esac
  done < <(env)

  walg_write_export_line "$prefix_name" "$prefix_value" >> "$temp" || log_fatal "invalid newline in $prefix_name"

  chmod 600 "$temp"
  mv "$temp" "$output"
}

setup_old_walg_prefix() {
  local prefix_name
  local prefix_value
  local versioned_prefix

  prefix_name="$(walg_active_prefix_name || true)"
  if [[ -z "$prefix_name" ]]; then
    log_fatal "a WAL-G prefix is required before major upgrade"
  fi

  prefix_value="${!prefix_name}"
  versioned_prefix="$(walg_append_major "$prefix_value" "$PG_OLD_MAJOR")"
  export "$prefix_name=$versioned_prefix"
  write_walg_env_file "$prefix_name" "$versioned_prefix"
}

start_old_postgres() {
  local bin_dir
  local options

  bin_dir="$(old_bin_dir)"
  options="-p $PG_UPGRADE_TEMP_PORT -c listen_addresses='localhost' -c config_file=/etc/postgresql/postgresql.conf"

  log_phase "starting PostgreSQL $PG_OLD_MAJOR for pre-upgrade backup"
  as_postgres "$bin_dir/pg_ctl" -D "$PGDATA" -o "$options" -w start
  old_pg_started=true
  export PGHOST=localhost
  export PGPORT="$PG_UPGRADE_TEMP_PORT"
  export PGUSER="${PGUSER:-postgres}"
  if [[ -n "${POSTGRES_PASSWORD:-}" && -z "${PGPASSWORD:-}" ]]; then
    export PGPASSWORD="$POSTGRES_PASSWORD"
  fi
}

stop_old_postgres() {
  local bin_dir

  if [[ "$old_pg_started" != "true" ]]; then
    return 0
  fi

  bin_dir="$(old_bin_dir)"
  as_postgres "$bin_dir/pg_ctl" -D "$PGDATA" -m fast -w stop
  old_pg_started=false
  unset PGHOST
  unset PGPORT
}

cleanup() {
  stop_old_postgres
}

latest_backup_epoch() {
  local line
  local field
  local epoch
  local latest=""

  while IFS= read -r line; do
    for field in $line; do
      if [[ "$field" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]; then
        epoch="$(date -d "$field" +%s 2>/dev/null || true)"
        if [[ -n "$epoch" ]]; then
          if [[ -z "$latest" || "$epoch" -gt "$latest" ]]; then
            latest="$epoch"
          fi
        fi
      fi
    done
  done

  if [[ -z "$latest" ]]; then
    return 1
  fi

  printf '%s\n' "$latest"
}

backup_is_recent() {
  local latest
  local now
  local age

  latest="$(wal-g backup-list 2>/dev/null | latest_backup_epoch || true)"
  if [[ -z "$latest" ]]; then
    return 1
  fi

  now="$(date +%s)"
  age=$((now - latest))

  [[ "$age" -ge 0 && "$age" -le "$PG_UPGRADE_BACKUP_MAX_AGE" ]]
}

require_pre_upgrade_backup() {
  if [[ "$PG_UPGRADE_BACKUP_MAX_AGE" != "0" ]] && backup_is_recent; then
    log_info "recent pre-upgrade backup found for PostgreSQL $PG_OLD_MAJOR"
    return 0
  fi

  log_phase "pushing pre-upgrade backup"
  wal-g backup-push "$PGDATA"

  if [[ "$PG_UPGRADE_BACKUP_MAX_AGE" == "0" ]] || backup_is_recent; then
    log_info "pre-upgrade backup verified for PostgreSQL $PG_OLD_MAJOR"
    return 0
  fi

  log_fatal "pre-upgrade backup was not visible after backup-push"
}

require_env PG_OLD_MAJOR
require_env PG_NEW_MAJOR
require_env PGDATA

validate_non_negative_int "$PG_UPGRADE_BACKUP_MAX_AGE" || log_fatal "PG_UPGRADE_BACKUP_MAX_AGE must be a non-negative integer"

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  log_fatal "PGDATA does not contain PG_VERSION: $PGDATA"
fi

require_old_binaries
trap cleanup EXIT

setup_old_walg_prefix
start_old_postgres
require_pre_upgrade_backup
stop_old_postgres

log_fatal "upgrade execution is not implemented yet"

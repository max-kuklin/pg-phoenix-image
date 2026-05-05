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
PG_UPGRADE_REQUIRED_OLD_BINARIES=(postgres pg_upgrade pg_ctl pg_controldata pg_resetwal pg_dump pg_dumpall)
old_pg_started=false
new_pg_started=false
upgrade_swapped=false
upgrade_complete=false
upgrade_work_dir="${PG_UPGRADE_WORK_DIR:-/tmp/pg_upgrade}"
new_pgdata="${PGDATA}.new"
old_pgdata="${PGDATA}.old"

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

  if [[ ! -d "$PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/lib" ]]; then
    log_fatal "stashed PostgreSQL $PG_OLD_MAJOR library directory is missing: $PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/lib"
  fi

  if [[ ! -d "$PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/share" ]]; then
    log_fatal "stashed PostgreSQL $PG_OLD_MAJOR share directory is missing: $PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/share"
  fi

  for binary in "${PG_UPGRADE_REQUIRED_OLD_BINARIES[@]}"; do
    if [[ ! -x "$old_bin_dir/$binary" ]]; then
      log_fatal "required stashed PostgreSQL $PG_OLD_MAJOR binary is missing or not executable: $old_bin_dir/$binary"
    fi
  done
}

install_old_share_dir() {
  local target="/usr/share/postgresql/$PG_OLD_MAJOR"

  if [[ -d "$target" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  ln -s "$PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR/share" "$target"
}

old_bin_dir() {
  printf '%s/%s/bin\n' "$PG_BINARY_STASH_ROOT" "$PG_OLD_MAJOR"
}

new_bin_dir() {
  dirname "$(command -v postgres)"
}

as_postgres() {
  if [[ "$(id -u)" -eq 0 ]] && command -v gosu >/dev/null 2>&1; then
    gosu postgres "$@"
    return $?
  fi

  "$@"
}

chown_postgres_if_available() {
  if getent passwd postgres >/dev/null 2>&1; then
    chown -R postgres:postgres "$@"
  fi
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
  export PGDATABASE="${PGDATABASE:-postgres}"
  export PGSSLMODE="${PGSSLMODE:-disable}"
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
  unset PGDATABASE
  unset PGSSLMODE
}

start_new_postgres() {
  local bin_dir
  local options

  bin_dir="$(new_bin_dir)"
  options="-p $PG_UPGRADE_TEMP_PORT -c listen_addresses='localhost' -c config_file=/etc/postgresql/postgresql.conf"

  log_phase "starting PostgreSQL $PG_NEW_MAJOR for post-upgrade verification"
  as_postgres "$bin_dir/pg_ctl" -D "$PGDATA" -o "$options" -w start
  new_pg_started=true
  export PGHOST=localhost
  export PGPORT="$PG_UPGRADE_TEMP_PORT"
  export PGUSER="${PGUSER:-postgres}"
  export PGDATABASE="${PGDATABASE:-postgres}"
  export PGSSLMODE="${PGSSLMODE:-disable}"
  if [[ -n "${POSTGRES_PASSWORD:-}" && -z "${PGPASSWORD:-}" ]]; then
    export PGPASSWORD="$POSTGRES_PASSWORD"
  fi
}

stop_new_postgres() {
  local bin_dir

  if [[ "$new_pg_started" != "true" ]]; then
    return 0
  fi

  bin_dir="$(new_bin_dir)"
  as_postgres "$bin_dir/pg_ctl" -D "$PGDATA" -m fast -w stop
  new_pg_started=false
  unset PGHOST
  unset PGPORT
  unset PGDATABASE
  unset PGSSLMODE
}

cleanup() {
  stop_new_postgres
  stop_old_postgres

  if [[ "$upgrade_complete" == "true" ]]; then
    return 0
  fi

  if [[ "$upgrade_swapped" == "true" ]]; then
    log_warn "upgrade did not complete; restoring PostgreSQL $PG_OLD_MAJOR data directory"
    rm -rf "$PGDATA"
    if [[ -d "$old_pgdata" ]]; then
      mv "$old_pgdata" "$PGDATA"
    fi
  else
    rm -rf "$new_pgdata"
  fi
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

prepare_new_pgdata() {
  local bin_dir
  local old_bin
  local checksum_version
  local checksum_arg

  bin_dir="$(new_bin_dir)"
  old_bin="$(old_bin_dir)"
  checksum_version="$("$old_bin/pg_controldata" "$PGDATA" | awk -F: '/Data page checksum version/ { gsub(/^[ \t]+/, "", $2); print $2 }')"

  if [[ "$checksum_version" == "0" ]]; then
    checksum_arg="--no-data-checksums"
  else
    checksum_arg="--data-checksums"
  fi

  rm -rf "$new_pgdata"
  mkdir -p "$new_pgdata"
  chown_postgres_if_available "$new_pgdata"

  log_phase "initializing PostgreSQL $PG_NEW_MAJOR data directory"
  as_postgres "$bin_dir/initdb" "$checksum_arg" -D "$new_pgdata"
}

run_pg_upgrade() {
  local old_bin
  local new_bin

  old_bin="$(old_bin_dir)"
  new_bin="$(new_bin_dir)"

  rm -rf "$upgrade_work_dir"
  mkdir -p "$upgrade_work_dir"
  chown_postgres_if_available "$upgrade_work_dir"

  log_phase "checking PostgreSQL major upgrade"
  (
    cd "$upgrade_work_dir"
    as_postgres "$new_bin/pg_upgrade" \
      --old-bindir="$old_bin" \
      --new-bindir="$new_bin" \
      --old-datadir="$PGDATA" \
      --new-datadir="$new_pgdata" \
      --check
  )

  log_phase "running PostgreSQL major upgrade"
  (
    cd "$upgrade_work_dir"
    as_postgres "$new_bin/pg_upgrade" \
      --old-bindir="$old_bin" \
      --new-bindir="$new_bin" \
      --old-datadir="$PGDATA" \
      --new-datadir="$new_pgdata" \
      --link
  )
}

swap_pgdata() {
  rm -rf "$old_pgdata"
  mv "$PGDATA" "$old_pgdata"
  mv "$new_pgdata" "$PGDATA"
  upgrade_swapped=true
}

run_post_upgrade_analyze() {
  local analyze_script="$upgrade_work_dir/analyze_new_cluster.sh"
  local bin_dir

  log_phase "running post-upgrade analyze"
  if [[ ! -x "$analyze_script" ]]; then
    bin_dir="$(new_bin_dir)"
    as_postgres "$bin_dir/vacuumdb" --all --analyze-in-stages --missing-stats-only
    as_postgres "$bin_dir/vacuumdb" --all --analyze-only
    return 0
  fi

  as_postgres "$analyze_script"
}

setup_new_walg_prefix() {
  local prefix_name
  local prefix_value
  local base_prefix
  local versioned_prefix

  prefix_name="$(walg_active_prefix_name || true)"
  if [[ -z "$prefix_name" ]]; then
    log_fatal "a WAL-G prefix is required before post-upgrade backup"
  fi

  prefix_value="${!prefix_name}"
  base_prefix="${prefix_value%/$PG_OLD_MAJOR}"
  versioned_prefix="$(walg_append_major "$base_prefix" "$PG_NEW_MAJOR")"
  export "$prefix_name=$versioned_prefix"
  write_walg_env_file "$prefix_name" "$versioned_prefix"
}

push_post_upgrade_backup() {
  log_phase "pushing post-upgrade backup"
  wal-g backup-push "$PGDATA"
  log_info "post-upgrade backup completed for PostgreSQL $PG_NEW_MAJOR"
}

cleanup_success() {
  if [[ "${PG_UPGRADE_KEEP_OLD:-false}" == "true" ]]; then
    log_info "retaining old PostgreSQL data directory at $old_pgdata"
  else
    rm -rf "$old_pgdata"
  fi

  rm -rf "$PG_BINARY_STASH_ROOT/$PG_OLD_MAJOR"
  rm -rf "$upgrade_work_dir"
  upgrade_complete=true
  log_info "major upgrade completed; remove PG_UPGRADE=true before the next rollout"
}

require_env PG_OLD_MAJOR
require_env PG_NEW_MAJOR
require_env PGDATA

validate_non_negative_int "$PG_UPGRADE_BACKUP_MAX_AGE" || log_fatal "PG_UPGRADE_BACKUP_MAX_AGE must be a non-negative integer"

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  log_fatal "PGDATA does not contain PG_VERSION: $PGDATA"
fi

require_old_binaries
install_old_share_dir
trap cleanup EXIT

setup_old_walg_prefix
start_old_postgres
require_pre_upgrade_backup
stop_old_postgres

prepare_new_pgdata
run_pg_upgrade
swap_pgdata
setup_new_walg_prefix
start_new_postgres
run_post_upgrade_analyze
push_post_upgrade_backup
stop_new_postgres
cleanup_success

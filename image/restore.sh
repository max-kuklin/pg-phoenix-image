#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=restore
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"
. "${WALG_LIB_PATH:-/usr/local/lib/walg.sh}"
. "${RESTORE_ARGS_LIB_PATH:-/usr/local/lib/restore-args.sh}"

PG_MAJOR="${PG_MAJOR:-18}"
PGDATA="${PGDATA:-/var/lib/postgresql/$PG_MAJOR/docker}"
if [[ "$PGDATA" == "/var/lib/postgresql/data" ]]; then
  PGDATA="/var/lib/postgresql/$PG_MAJOR/docker"
fi
export PGDATA

WALG_ENV_FILE="${WALG_ENV_FILE:-/etc/walg-env.sh}"
RESTORE_OVERWRITE="${RESTORE_OVERWRITE:-false}"
RESTORE_ROLLBACK="${RESTORE_ROLLBACK:-false}"
RESTORE_REQUEST_ID="${RESTORE_REQUEST_ID:-}"

pgdata_parent="${PGDATA%/*}"
if [[ "$pgdata_parent" == "$PGDATA" ]]; then
  pgdata_parent="."
fi

restore_tmp="${RESTORE_TMP:-$pgdata_parent/restore-tmp}"
pre_restore="${PRE_RESTORE:-$pgdata_parent/pre-restore}"
failed_restore="${FAILED_RESTORE:-$pgdata_parent/failed-restore}"
restore_state="${RESTORE_STATE_DIR:-$pgdata_parent/restore-state}"
restore_prefix_name=

set +e
restore_parse_args "$@"
parse_status="$?"
set -e
if [[ "$parse_status" -ne 0 ]]; then
  case "$parse_status" in
    3) log_fatal "--from must end with a version segment, e.g. s3://bucket/source/18" ;;
    *) log_fatal "usage: restore.sh [--from SOURCE_PREFIX] [--target-time TIMESTAMP] [--bootstrap]" ;;
  esac
fi

if [[ -r "$WALG_ENV_FILE" ]]; then
  . "$WALG_ENV_FILE"
fi

move_dir() {
  local from="$1"
  local to="$2"

  if [[ -e "$to" ]]; then
    log_fatal "$to already exists"
  fi

  mv "$from" "$to"
}

validate_request_id() {
  local value="$1"

  [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]]
}

request_marker() {
  local suffix="$1"

  printf "%s/%s.%s\n" "$restore_state" "$RESTORE_REQUEST_ID" "$suffix"
}

complete_request() {
  local suffix="$1"
  local marker

  marker="$(request_marker "$suffix")"
  mkdir -p "$restore_state"
  printf "%s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"
}

require_request_id() {
  if [[ -z "$RESTORE_REQUEST_ID" ]]; then
    log_fatal "PG_RESTORE_REQUEST_ID is required for restore and rollback requests"
  fi

  validate_request_id "$RESTORE_REQUEST_ID" || log_fatal "PG_RESTORE_REQUEST_ID may contain only letters, numbers, dot, underscore, and dash"
}

request_completed() {
  local suffix="$1"
  local marker

  marker="$(request_marker "$suffix")"
  [[ -e "$marker" ]]
}

restore_rollback() {
  log_phase "rolling back restore"
  require_request_id

  if request_completed "rollback-completed"; then
    log_info "restore rollback request already completed; skipping"
    return 0
  fi

  if [[ ! -d "$pre_restore" ]]; then
    log_fatal "cannot roll back restore: $pre_restore does not exist"
  fi

  rm -rf "$restore_tmp"
  rm -rf "$failed_restore"

  if [[ -e "$PGDATA" ]]; then
    move_dir "$PGDATA" "$failed_restore"
  fi

  move_dir "$pre_restore" "$PGDATA"
  complete_request "rollback-completed"
  log_info "pre-restore data restored"
}

write_recovery_settings() {
  local auto_conf="$restore_tmp/postgresql.auto.conf"
  local restore_command

  restore_command=". $WALG_ENV_FILE && wal-g wal-fetch %f %p"
  if [[ -n "$restore_from" ]]; then
    restore_command=". $WALG_ENV_FILE && $restore_prefix_name=$(walg_shell_quote "$restore_from") wal-g wal-fetch %f %p"
  fi

  {
    printf "restore_command = '%s'\n" "${restore_command//\'/\'\'}"
    if [[ -n "$restore_target_time" ]]; then
      printf "recovery_target_time = '%s'\n" "${restore_target_time//\'/\'\'}"
      printf "recovery_target_action = 'promote'\n"
    fi
  } >> "$auto_conf"

  touch "$restore_tmp/recovery.signal"
}

prepare_restore() {
  if [[ "$restore_bootstrap" != "true" ]]; then
    require_request_id

    if request_completed "completed"; then
      log_info "restore request already completed; skipping"
      return 0
    fi
  fi

  if [[ -n "$restore_from" ]]; then
    restore_prefix_name="$(walg_active_prefix_name || true)"
    if [[ -z "$restore_prefix_name" ]]; then
      log_fatal "--from requires an active WAL-G prefix variable"
    fi

    export "$restore_prefix_name=$restore_from"
  fi

  if [[ -e "$PGDATA/PG_VERSION" && "$RESTORE_OVERWRITE" != "true" ]]; then
    log_fatal "PGDATA exists; set PG_RESTORE_OVERWRITE=true to restore over existing data"
  fi

  if [[ -e "$restore_tmp" ]]; then
    log_fatal "$restore_tmp already exists"
  fi

  if [[ -e "$pre_restore" && -e "$PGDATA/PG_VERSION" ]]; then
    log_fatal "$pre_restore already exists; remove it or set PG_RESTORE_ROLLBACK=true"
  fi

  mkdir -p "$pgdata_parent"

  log_phase "fetching backup"
  wal-g backup-fetch "$restore_tmp" LATEST

  write_recovery_settings

  if command -v chown >/dev/null 2>&1; then
    chown -R postgres:postgres "$restore_tmp" || true
  fi

  if [[ -e "$PGDATA/PG_VERSION" ]]; then
    move_dir "$PGDATA" "$pre_restore"
  else
    rm -rf "$PGDATA"
  fi

  move_dir "$restore_tmp" "$PGDATA"
  if [[ "$restore_bootstrap" != "true" ]]; then
    complete_request "completed"
  fi
  log_info "restore prepared for PostgreSQL startup"
}

if [[ "$RESTORE_ROLLBACK" == "true" ]]; then
  restore_rollback
  exit 0
fi

prepare_restore

#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=restore
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"
. "${WALG_LIB_PATH:-/usr/local/lib/walg.sh}"
. "${RESTORE_ARGS_LIB_PATH:-/usr/local/lib/restore-args.sh}"

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
WALG_ENV_FILE="${WALG_ENV_FILE:-/etc/walg-env.sh}"

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

if [[ -n "$restore_from" ]]; then
  prefix_name="$(walg_active_prefix_name || true)"
  if [[ -z "$prefix_name" ]]; then
    log_fatal "--from requires an active WAL-G prefix variable"
  fi

  export "$prefix_name=$restore_from"
fi

mkdir -p "$PGDATA"

if pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  log_phase "stopping PostgreSQL"
  pg_ctl -D "$PGDATA" -m fast stop
fi

snapshot="${PGDATA}.pre-restore"
had_snapshot=false

rollback() {
  local exit_code="$1"

  if [[ "$exit_code" -eq 0 ]]; then
    return 0
  fi

  if [[ "$had_snapshot" == "true" && -d "$snapshot" ]]; then
    log_warn "restore failed; rolling back to pre-restore data"
    rm -rf "$PGDATA"
    mv "$snapshot" "$PGDATA"
    pg_ctl -D "$PGDATA" -w start || true
  fi
}

trap 'rollback "$?"' EXIT

if [[ -e "$PGDATA/PG_VERSION" ]]; then
  rm -rf "$snapshot"
  mv "$PGDATA" "$snapshot"
  mkdir -p "$PGDATA"
  had_snapshot=true
fi

log_phase "fetching backup"
wal-g backup-fetch "$PGDATA" LATEST

touch "$PGDATA/recovery.signal"

{
  printf "restore_command = '. %s && wal-g wal-fetch %%f %%p'\n" "$WALG_ENV_FILE"
  if [[ -n "$restore_target_time" ]]; then
    printf "recovery_target_time = '%s'\n" "${restore_target_time//\'/\'\'}"
    printf "recovery_target_action = 'promote'\n"
  fi
} >> "$PGDATA/postgresql.auto.conf"

if [[ "$restore_bootstrap" == "true" ]]; then
  log_info "backup fetched for bootstrap restore"
  trap - EXIT
  exit 0
fi

log_phase "starting PostgreSQL"
pg_ctl -D "$PGDATA" -w start

rm -rf "$snapshot"
trap - EXIT
log_info "restore completed"

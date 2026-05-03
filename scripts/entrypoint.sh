#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=entrypoint
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"
. "${WALG_LIB_PATH:-/usr/local/lib/walg.sh}"

PG_MAJOR="$(postgres -V | awk '{print $3}' | cut -d. -f1)"

validate_non_negative_int() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

validate_cron_schedule() {
  local schedule="$1"
  local field_count

  field_count="$(awk '{print NF}' <<< "$schedule")"
  [[ "$field_count" -eq 5 ]]
}

write_walg_env_file() {
  local output="/etc/walg-env.sh"
  local temp="${output}.tmp"
  local prefix_name="$1"
  local prefix_value="$2"
  local name

  : > "$temp"

  while IFS='=' read -r name _; do
    case "$name" in
      WALG_*|AWS_*|GOOGLE_*|AZURE_*|BACKUP_RETAIN_FULL|LOG_LEVEL)
        walg_write_export_line "$name" "${!name}" >> "$temp" || log_fatal "invalid newline in $name"
        ;;
    esac
  done < <(env)

  walg_write_export_line "$prefix_name" "$prefix_value" >> "$temp" || log_fatal "invalid newline in $prefix_name"

  chown postgres:postgres "$temp"
  chmod 600 "$temp"
  mv "$temp" "$output"
}

setup_walg_env() {
  local prefix_name
  local prefix_value
  local versioned_prefix
  local retain_full="${BACKUP_RETAIN_FULL:-5}"

  prefix_name="$(walg_active_prefix_name || true)"
  if [[ -z "$prefix_name" ]]; then
    return 0
  fi

  prefix_value="${!prefix_name}"
  versioned_prefix="$(walg_append_major "$prefix_value" "$PG_MAJOR")"
  export "$prefix_name=$versioned_prefix"
  export BACKUP_RETAIN_FULL="$retain_full"

  write_walg_env_file "$prefix_name" "$versioned_prefix"
}

setup_backup() {
  local prefix_name
  local archive_timeout="${ARCHIVE_TIMEOUT:-60}"

  prefix_name="$(walg_active_prefix_name || true)"
  if [[ -z "$prefix_name" ]]; then
    return 0
  fi

  validate_non_negative_int "$archive_timeout" || log_fatal "ARCHIVE_TIMEOUT must be a non-negative integer"

  if [[ -z "${BACKUP_SCHEDULE:-}" ]]; then
    log_fatal "BACKUP_SCHEDULE is required when WAL-G archiving is enabled"
  fi

  validate_cron_schedule "$BACKUP_SCHEDULE" || log_fatal "BACKUP_SCHEDULE must contain exactly 5 cron fields"

  cat > /etc/postgresql/conf.d/walg.conf <<EOF
archive_command = '. /etc/walg-env.sh && wal-g wal-push %p'
archive_timeout = ${archive_timeout}
EOF

  cat > /etc/cron.d/pg-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
${BACKUP_SCHEDULE} postgres /usr/local/bin/backup.sh
EOF

  chmod 0644 /etc/cron.d/pg-backup

  if command -v cron >/dev/null 2>&1; then
    cron
  else
    log_warn "cron binary not found; scheduled backups disabled"
  fi
}

pgdata_exists() {
  [[ -e "${PGDATA:-/var/lib/postgresql/$PG_MAJOR/docker}/PG_VERSION" ]]
}

run_restore_if_requested() {
  local args=()
  local target_time="${PG_RESTORE_TARGET_TIME:-}"

  if [[ "${PG_RESTORE_ROLLBACK:-}" == "true" ]]; then
    RESTORE_ROLLBACK=true RESTORE_REQUEST_ID="${PG_RESTORE_REQUEST_ID:-}" restore.sh
    return 0
  fi

  if [[ -n "${PG_RESTORE_FROM:-}" ]]; then
    args+=(--from "$PG_RESTORE_FROM")
  elif [[ -n "${WALG_CLONE_FROM:-}" ]]; then
    if pgdata_exists; then
      return 0
    fi

    args+=(--from "$WALG_CLONE_FROM" --bootstrap)
    target_time="${WALG_CLONE_TARGET_TIME:-}"
  elif [[ "${PG_RESTORE:-}" != "true" ]]; then
    return 0
  fi

  if [[ -n "$target_time" ]]; then
    args+=(--target-time "$target_time")
  fi

  RESTORE_OVERWRITE="${PG_RESTORE_OVERWRITE:-false}" RESTORE_REQUEST_ID="${PG_RESTORE_REQUEST_ID:-}" restore.sh "${args[@]}"
}

if [[ "${1:-}" == -* ]]; then
  set -- postgres "$@"
fi

if [[ "${1:-}" == "postgres" ]]; then
  setup_walg_env
  run_restore_if_requested
  setup_backup
  exec docker-entrypoint.sh "$@" -c config_file=/etc/postgresql/postgresql.conf
fi

exec docker-entrypoint.sh "$@"

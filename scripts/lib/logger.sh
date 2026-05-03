#!/usr/bin/env bash

_log_level_value() {
  case "${1:-INFO}" in
    ERROR) printf '0' ;;
    WARN) printf '1' ;;
    INFO) printf '2' ;;
    DEBUG) printf '3' ;;
    *) printf '2' ;;
  esac
}

_log_should_print() {
  local message_level="$1"
  local current_level="${LOG_LEVEL:-INFO}"

  [[ "$(_log_level_value "$message_level")" -le "$(_log_level_value "$current_level")" ]]
}

_log_write() {
  local level="$1"
  shift

  if ! _log_should_print "$level"; then
    return 0
  fi

  local component="${LOG_COMPONENT:-${0##*/}}"
  local timestamp
  timestamp="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  printf '%s %-5s [%s] %s\n' "$timestamp" "$level" "$component" "$*" >&2
}

log_error() {
  _log_write ERROR "$@"
}

log_warn() {
  _log_write WARN "$@"
}

log_info() {
  _log_write INFO "$@"
}

log_debug() {
  _log_write DEBUG "$@"
}

log_fatal() {
  log_error "$@"
  exit 1
}

log_phase() {
  log_info "------ $* ------"
}


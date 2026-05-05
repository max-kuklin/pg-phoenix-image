#!/usr/bin/env bash

walg_shell_quote() {
  local value="$1"

  if [[ "$value" == *$'\n'* ]]; then
    return 1
  fi

  printf "'%s'" "${value//\'/\'\"\'\"\'}"
}

walg_validate_version_prefix() {
  local prefix="${1%/}"

  [[ "$prefix" =~ /[0-9]+$ ]]
}

walg_append_major() {
  local prefix="${1%/}"
  local major="$2"

  printf '%s/%s\n' "$prefix" "$major"
}

walg_active_prefix_name() {
  if [[ -n "${WALG_S3_PREFIX:-}" ]]; then
    printf 'WALG_S3_PREFIX\n'
    return 0
  fi

  if [[ -n "${WALG_GS_PREFIX:-}" ]]; then
    printf 'WALG_GS_PREFIX\n'
    return 0
  fi

  if [[ -n "${WALG_AZ_PREFIX:-}" ]]; then
    printf 'WALG_AZ_PREFIX\n'
    return 0
  fi

  return 1
}

walg_write_export_line() {
  local name="$1"
  local value="$2"
  local quoted

  quoted="$(walg_shell_quote "$value")" || return 1
  printf 'export %s=%s\n' "$name" "$quoted"
}


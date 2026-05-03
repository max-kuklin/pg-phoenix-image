#!/usr/bin/env bash

restore_from=
restore_target_time=
restore_bootstrap=false

restore_parse_args() {
  restore_from=
  restore_target_time=
  restore_bootstrap=false

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --from)
        [[ "$#" -ge 2 ]] || return 2
        restore_from="${2%/}"
        shift 2
        ;;
      --target-time)
        [[ "$#" -ge 2 ]] || return 2
        restore_target_time="$2"
        shift 2
        ;;
      --bootstrap)
        restore_bootstrap=true
        shift
        ;;
      *)
        return 2
        ;;
    esac
  done

  if [[ -n "$restore_from" ]]; then
    walg_validate_version_prefix "$restore_from" || return 3
  fi
}


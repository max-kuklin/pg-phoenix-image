#!/usr/bin/env bash
set -euo pipefail

LOG_COMPONENT=entrypoint
. "${LOGGER_PATH:-/usr/local/lib/logger.sh}"

if [[ "${1:-}" == -* ]]; then
  set -- postgres "$@"
fi

if [[ "${1:-}" == "postgres" ]]; then
  exec docker-entrypoint.sh "$@" -c config_file=/etc/postgresql/postgresql.conf
fi

exec docker-entrypoint.sh "$@"


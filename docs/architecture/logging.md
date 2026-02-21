# Script Logging

## Purpose

Unified logging for all shell scripts (entrypoint, backup, restore, upgrade). Consistent output format across features, parseable by Kubernetes log collectors, colored for interactive debugging.

## Concept

All scripts source a shared library (`scripts/lib/logger.sh`) that provides leveled logging functions. Output goes to stderr — PG owns stdout via the official entrypoint. Kubernetes captures stderr as container logs. Colors are auto-detected: on for TTY (`kubectl exec`), off for pipe (Fluentd, Loki, CloudWatch).

## Output Format

```
2026-02-13 14:30:00 UTC INFO  [backup] base backup started
2026-02-13 14:30:05 UTC DEBUG [backup] prefix resolved to s3://bucket/prod/18
2026-02-13 14:30:45 UTC INFO  [backup] base backup completed (40s)
2026-02-13 15:00:00 UTC ERROR [restore] backup-fetch failed: no backups found
```

Fields: UTC timestamp, level (fixed-width 5 chars), component tag in brackets, message. Timestamps use the same format as PG's `log_line_prefix = '%t …'` (`YYYY-MM-DD HH:MM:SS UTC`), so `kubectl logs` output sorts correctly across PG and script lines.

Multi-step operations (restore, upgrade) use phase markers for scannable progress:

```
2026-02-13 14:30:00 UTC INFO  [restore] ────── stopping PostgreSQL ──────
2026-02-13 14:30:02 UTC INFO  [restore] ────── fetching backup ──────
2026-02-13 14:30:30 UTC INFO  [restore] ────── starting WAL replay ──────
```

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Output target | stderr (fd 2) | stdout, syslog, file | PG's `docker-entrypoint.sh` uses stdout for PG server output. Scripts use stderr to avoid interleaving with PG protocol output. Kubernetes captures both but they remain distinguishable. |
| Timestamp format | PG-compatible UTC (`%Y-%m-%d %H:%M:%S UTC`) | ISO 8601 `T`/`Z`, Unix epoch, local time | Identical to PG's `%t` output, so mixed PG + script lines in `kubectl logs` sort correctly. UTC avoids timezone confusion in distributed systems. |
| Color detection | TTY check on stderr (`[ -t 2 ]`) | Always on, always off, env var | Correct default for both use cases: `kubectl exec -it` gets colors for readability, `kubectl logs` and log collectors get plain text for parsing. No config needed. |
| Levels | ERROR, WARN, INFO, DEBUG | Syslog-style (8 levels), structured JSON | Four levels cover all script needs without over-engineering. ERROR = action required, WARN = degraded, INFO = operational milestones, DEBUG = internals. |
| Default level | INFO | WARN, DEBUG | INFO shows operational progress (backup started/completed, restore phases, upgrade steps) without internal details. DEBUG for troubleshooting only — it logs resolved env vars, checksums, file paths. |
| Component tag | Set via `LOG_COMPONENT` before sourcing, falls back to script basename | Hardcoded per function, passed per call | One-time setup per script. Every log line is filterable by feature: `kubectl logs pg-0 \| grep '\[restore\]'`. |
| Bash | `#!/usr/bin/env bash` + `set -euo pipefail` | POSIX sh, zsh | Bash gives `pipefail` (critical for pipeline error handling), `[[ ]]`, arrays, and string ops without subprocesses. Debian base image ships bash; Alpine portability is not a goal. |
| `log_fatal` | Logs ERROR + `exit 1` | Separate log + exit calls | Common pattern in every script. Reduces boilerplate and prevents forgetting the exit. |

### Why Not Structured JSON?

JSON logs are better for machine parsing, but shell scripts can't produce reliable JSON without a helper (`jq`, `printf` escaping for special characters in messages). The fixed-width format is `grep`-friendly and parseable by regex-based log collectors. If JSON is needed, configure the log collector to parse the format — it's consistent enough.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `INFO` | `ERROR`, `WARN`, `INFO`, `DEBUG`. Controls verbosity for all scripts. |

Set in the StatefulSet env:

```yaml
env:
  - name: LOG_LEVEL
    value: "DEBUG"   # for troubleshooting
```

## Usage in Scripts

Each script sources the library after setting its component name. Inside the container, the canonical path is `/usr/local/lib/logger.sh` (source: `scripts/lib/logger.sh` — see Dockerfile `COPY` step). All scripts use:

```bash
LOG_COMPONENT=backup
. /usr/local/lib/logger.sh
```

Component conventions:

| Script | `LOG_COMPONENT` |
|---|---|
| `entrypoint.sh` | `entrypoint` |
| `backup.sh` | `backup` |
| `restore.sh` | `restore` |
| `upgrade.sh` (within entrypoint) | `upgrade` |

`log_phase` marks major steps in multi-step operations, creating visual anchors in long log streams.

## Security Considerations

| Concern | Mitigation |
|---|---|
| DEBUG logs may print resolved env vars (S3 prefixes, paths) | No secrets are logged at any level. `WALG_S3_PREFIX` is not sensitive. AWS credentials are never echoed — they flow through WAL-G's own env handling. |
| Log output could be noisy at DEBUG in tight loops | DEBUG should only be enabled temporarily for troubleshooting. Default INFO produces ~10-20 lines per backup cycle, ~30 lines per restore. |

## Testing

Log output is verified as part of E2E tests — each test suite checks that expected log lines (level, component tag, phase markers) appear in container stderr.

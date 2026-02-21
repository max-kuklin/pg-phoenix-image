## Implementation Plan

> **Note**: The Dockerfile is committed in its final state — it references scripts from all phases. Phase 1 creates empty stub scripts (`entrypoint.sh`, `backup.sh`, `restore.sh`, `upgrade.sh`) so the image builds from Phase 2 onwards. Each subsequent phase replaces the stubs with real implementations.

### Phase 1 — Foundation

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 1 | `scripts/lib/logger.sh` + stub scripts (`entrypoint.sh`, `backup.sh`, `restore.sh`, `upgrade.sh`) | nothing | image builds, manual smoke test |
| 2 | `package.json` + `vitest.config.js` + `tests/helpers/containers.js` | nothing | `npm test` runs (no tests yet) |

Logger library is the leaf dependency — every script sources it. Stub scripts are minimal (`#!/usr/bin/env bash` + `exec "$@"` for entrypoint, exit 0 for others) so the Dockerfile builds. Test infra can be set up in parallel since it has no code dependencies on the scripts.

### Phase 2 — Image Validation

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 3 | `tests/pg-only.test.js` | steps 1-2 + existing Dockerfile/config | **write tests first** |

The image builds with stubs from Phase 1 (Dockerfile, postgresql.conf, pg_hba.conf, 01-extensions.sql, stub scripts all exist). This is the first test file because it validates the image itself — PG connects, config paths correct, WAL-G binary present, `pg_stat_statements` works, slow-query-log config. If this file passes, the image is sound and everything else builds on solid ground.

### Phase 3 — Backup + Restore

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 4 | `scripts/backup.sh` | step 1 | — |
| 5 | `scripts/restore.sh` | step 1 | — |
| 6 | `tests/backup-restore.test.js` | steps 2, 4, 5 | **write tests after both scripts** |

Backup and restore are tested together because restore consumes the backups that the backup tests create. Writing both scripts before the test file avoids a half-testable state. This is the core data-safety path — get it solid before building on top.

### Phase 4 — Entrypoint + Startup

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 7 | `scripts/entrypoint.sh` | steps 1, 4, 5 | — |
| 8 | `tests/startup.test.js` | steps 2, 7 | **write tests after entrypoint** |
| 9 | `tests/clone.test.js` | steps 2, 7 | **write tests after entrypoint** |

Entrypoint ties everything together: version check, binary stash, version-prefix, clone detection, backup cron setup, exec handoff. `startup.test.js` validates each env-var combination. `clone.test.js` validates the `WALG_CLONE_FROM` → `restore.sh --bootstrap` path. Tests 8 and 9 can be written in parallel — they're independent files.

### Phase 5 — Upgrade

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 10 | `scripts/upgrade.sh` | steps 1, 4, 7 | — |
| 11 | `tests/upgrade.test.js` | steps 2, 10 | **write tests after upgrade script** |

Saved for last — heaviest feature (two PG major versions, stashed binaries, `pg_upgrade --link`, rollback paths). Depends on backup (pre-upgrade backup gate), entrypoint (binary stash), and the full image. Also the slowest test file (~60s).

### Phase 6 — CI Glue

| Step | Deliverable | Depends on | Test |
|---|---|---|---|
| 12 | `renovate.json` | nothing | N/A (config only) |

Standalone config — can be added anytime but makes sense after the test suite is green.

---

### Dependency Graph

```
logger.sh ──► backup.sh ···► restore.sh ──► entrypoint.sh ──► upgrade.sh
  │            │              │               │                  │
  └──► test infra               │               ├──► startup.test.js
           ├──► pg-only.test.js       │               └──► clone.test.js
           ├──► backup-restore.test.js ◄──────┘
           └──► upgrade.test.js ◄────────────────────────────┘
```

Solid arrows (`──►`) represent implementation ordering. The dotted arrow (`···►`) between `backup.sh` and `restore.sh` is a test dependency only (not a code-level dependency). Test files depend on both `test infra` and the scripts they exercise: `backup-restore.test.js` requires `backup.sh` + `restore.sh`; `startup.test.js` and `clone.test.js` require `entrypoint.sh`; `upgrade.test.js` requires `upgrade.sh`.

### Summary

| Phase | Scripts | Tests | Running total |
|---|---|---|---|
| 1 — Foundation | `logger.sh`, stub scripts (4) | test infra (3 files) | 8 files |
| 2 — Image | — | `pg-only.test.js` | 9 files |
| 3 — Backup/Restore | `backup.sh`, `restore.sh` (replace stubs) | `backup-restore.test.js` | 10 files |
| 4 — Entrypoint | `entrypoint.sh` (replace stub) | `startup.test.js`, `clone.test.js` | 12 files |
| 5 — Upgrade | `upgrade.sh` (replace stub) | `upgrade.test.js` | 13 files |
| 6 — CI | `renovate.json` | — | 14 files |

Each phase ends with passing tests for everything built so far. No phase depends on a later phase.
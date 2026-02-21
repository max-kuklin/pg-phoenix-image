# Minor Version Upgrades

## Purpose

Keep PostgreSQL patched (security fixes, bug fixes) with zero operator involvement. Minor upgrades (e.g. 18.1 → 18.2) are binary compatible — no data migration, no `pg_upgrade`. Replace the binary, restart, done.

The challenge isn't the upgrade — it's **knowing when to rebuild**.

## Concept

The Dockerfile pins the base image by digest:

```dockerfile
FROM postgres:18@sha256:abc123...
```

Renovate Bot monitors this digest. When `postgres:18` gets a new build (security patch, minor PG release), Renovate opens a PR updating the pinned digest. CI builds the new image, runs the full test suite, and pushes only if tests pass.

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Delivery mechanism | Rebuild image on base image change | In-place `apk upgrade`, manual tag bumps | Immutable images. No runtime package management. CI guarantees every deployed image is tested. |
| Base image tracking | Renovate Bot with digest pinning | Dependabot, skopeo cron, Diun, manual monitoring | Renovate is purpose-built for this — tracks digest changes within the same tag, opens PRs, supports automerge. Dependabot only tracks tag version changes, not digest rebuilds. Free for all repos. |
| Digest pinning | `@sha256:...` in Dockerfile | Floating tag (`postgres:18`) | Pinning makes builds reproducible and makes Renovate's PRs visible (one-line diff). Without pinning, `docker build` silently picks up new base images with no audit trail. |
| Automerge | Optional — enabled via Renovate config | Manual PR review | Digest-only updates (same PG version, new Debian/security patches) are low risk. Automerge is safe if the test suite is solid. Disable for more conservative workflows. |

## Implementation

### Renovate Configuration

`renovate.json` in repo root:

```json
{
  "extends": [
    "config:recommended",
    "docker:pinDigests"
  ],
  "customManagers": [
    {
      "customType": "regex",
      "fileMatch": ["^Dockerfile$"],
      "matchStrings": ["ARG WALG_VERSION=(?<currentValue>v[\\d.]+)"],
      "datasourceTemplate": "github-releases",
      "depNameTemplate": "wal-g/wal-g"
    }
  ],
  "packageRules": [
    {
      "matchDatasources": ["docker"],
      "matchPackageNames": ["postgres"],
      "automerge": true,
      "automergeType": "pr",
      "schedule": ["every 6 hours"]
    },
    {
      "matchDatasources": ["github-releases"],
      "matchPackageNames": ["wal-g/wal-g"],
      "automerge": false,
      "schedule": ["every 6 hours"]
    }
  ]
}
```

What this does:
- `docker:pinDigests` — ensures `FROM` lines use `@sha256:...` pins
- `automerge: true` — merges postgres digest PRs automatically after CI passes
- `customManagers` — extracts `WALG_VERSION` from the Dockerfile `ARG` and tracks it against WAL-G GitHub releases. `WALG_SHA256` must be updated manually when accepting a version bump PR (download the new release binary, verify checksum, update the `ARG`)
- WAL-G tracked with `automerge: false` — requires manual review since upgrades could change backup format or drop PG version support

### CI Build Pipeline

Triggered by Renovate's PR merge (or any push to main):

1. Build pg-phoenix-image image from updated Dockerfile
2. Run full test suite (`npm test`)
3. If tests pass → push `pg-phoenix-image:18-<date>` + update `pg-phoenix-image:18-latest`
4. If tests fail → alert, don't push. Operator investigates.

### Image Tagging Convention

| Tag | Purpose |
|---|---|
| `pg-phoenix-image:18-latest` | Always the latest build for PG 18 |
| `pg-phoenix-image:18-20260213` | Date-stamped for auditability and rollback |
| `pg-phoenix-image:19-latest` | PG 19 track (when available) |

### Deployment

Operator or GitOps (ArgoCD, Flux) deploys the new image tag. Pod restarts, PG starts on existing PGDATA — binary compatible, no migration needed.

## Security Considerations

| Concern | Mitigation |
|---|---|
| Renovate GitHub App has repo access | Open source (20k+ stars), backed by Mend (security company). Only reads Dockerfile, writes one-line PRs. No access to secrets. Self-hosted option available for zero third-party access. |
| Automerge pushes untested code | Automerge only fires after CI passes. The test suite is the gate — if it's weak, disable automerge and review PRs manually. |
| Automated rebuilds could push a bad image | Full test suite gates every push. No untested image reaches a registry tag. |
| Base image introduces a regression | Tests gate the push. If regression is subtle (not caught by tests), operator pins to previous digest until fixed. |

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| Renovate misses an update | Delayed patching | Renovate polling has no SLA but is reliable in practice. Monitor Renovate dashboard for stale dependencies. |
| CI rebuild fails tests | No new image pushed | Alert sent. Old image continues running. No impact to production. |
| New base image breaks PG startup | Test suite catches it, image not pushed | Renovate PR stays open (automerge blocked). Operator investigates — may need to wait for upstream fix or pin to previous digest. |
| Renovate service outage | No PRs created | Temporary. Renovate is self-hostable as a GitHub Action if the hosted app is unreliable. |

## Testing

Covered by `tests/pg-only.test.js` (image validation) and `tests/startup.test.js` (binary stash) — see [testing.md](testing.md).

Additional case in `tests/startup.test.js`:

- Binary stash updated after restart with new image (checksum changed) — see [upgrade-major.md](upgrade-major.md) for stash details

# Minor Version Upgrades

## Purpose

Keep supported PostgreSQL major tracks patched with security and bug-fix releases. Minor upgrades, such as `18.2 -> 18.3`, are binary compatible: no data migration and no `pg_upgrade`. Replace the image, restart PostgreSQL on the same PGDATA, and verify.

The hard part is not the PostgreSQL restart. It is detecting upstream image changes across every supported major, testing the rebuilt image, and making the release intentional.

## Concept

[release-tracks.json](../../release-tracks.json) pins each supported PostgreSQL base image by minor tag and digest. Renovate monitors every `base` value. When the upstream `postgres:<major>.<minor>-bookworm` tag gets a new digest, or when a newer minor tag exists for that major, Renovate opens a PR updating the manifest. CI builds and tests the affected track; image publication remains a manual release step.

## Design Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Delivery mechanism | Rebuild immutable images on base image change | Runtime package upgrades, manual tag checks | Every deployed image is built and tested as a unit. No mutable runtime package state. |
| Base image tracking | Renovate custom manager over `release-tracks.json` | One Dockerfile per major, manual monitoring | One manifest keeps all supported tracks visible without duplicating Dockerfile logic. |
| Base tag shape | `postgres:<major>.<minor>-bookworm@sha256:...` | Floating `postgres:<major>`, unpinned digest, distro-less tag | Minor version is visible in our image tags, Debian release is explicit, and digest pinning keeps builds reproducible. |
| Automerge | Allowed only after required CI passes | Manual review for every digest PR | PostgreSQL base-image updates are low risk when the full image and E2E suites pass. WAL-G remains manual. |

## Renovate Configuration

`renovate.json` has two custom managers:

- `release-tracks.json` manager tracks `postgres:<major>.<minor>-bookworm@sha256:...` entries as Docker dependencies.
- Dockerfile manager tracks `WALG_VERSION` against WAL-G GitHub releases.

Renovate runs from the repository's scheduled GitHub Actions workflow using a short-lived GitHub App installation token created from `RENOVATE_APP_ID` and `RENOVATE_APP_PRIVATE_KEY` secrets. PostgreSQL base-image PRs are constrained to the current PostgreSQL major for each manifest entry. WAL-G PRs do not automerge because a WAL-G change can affect backup format, restore behavior, or PostgreSQL version support independently from the base image.

## CI Flow

For a Renovate PR:

1. Build the affected PostgreSQL track from the manifest entry.
2. Run image smoke tests for that track.
3. Run backup/restore E2E for that track.
4. Run adjacent major upgrade E2E when the changed track participates in a supported upgrade path.
5. Merge only when required checks pass.

The initial implementation may build all tracks on every PR for simplicity. It can be optimized later by detecting which manifest entries changed.

## Release Flow

Merging a Renovate PR does not publish an image. An operator creates a project release manually, then runs the image release workflow for the selected tracks. See [release.md](release.md) for the full tagging and publishing model.

Example release tags after a PostgreSQL 18 minor update:

| Tag | Purpose |
|---|---|
| `pg-phoenix-image:18` | Moving latest released PostgreSQL 18 image |
| `pg-phoenix-image:18.3` | Moving latest released PostgreSQL 18.3 image |
| `pg-phoenix-image:18.3-v0.4.0` | Immutable PostgreSQL 18.3 image from project release `v0.4.0` |

## Deployment

Operator or GitOps deploys the new image tag. PostgreSQL restarts on existing PGDATA; no migration is needed within the same major version.

Production manifests should prefer immutable tags or digests. Moving tags are useful for development and simple environments but make rollback less explicit.

## Failure Modes

| Failure | Impact | Behavior |
|---|---|---|
| Renovate misses an update | Delayed patching | Monitor Renovate dashboard for stale dependencies. |
| CI fails for a base-image PR | No release candidate | PR stays open; old released image remains available. |
| New base image breaks startup | Test suite should catch it | Hold the Renovate PR or pin to the previous digest until upstream or project code is fixed. |
| Renovate workflow outage | No PRs created | Fix the scheduled GitHub Actions run or dispatch it manually after the issue is resolved. |
| Manual release is delayed after merge | Patched image is not published yet | Intentional trade-off: releases are operator-controlled, not automatic on every merge. |

## Testing

Covered by image smoke tests, backup/restore E2E, startup/binary-stash tests, and adjacent major upgrade tests where relevant. See [testing.md](testing.md) and [release.md](release.md).

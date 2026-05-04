# Image Build and Release

## Purpose

Define how `pg-phoenix-image` is built, versioned, published, and consumed. The key constraint is that PostgreSQL data safety depends on the image tag being meaningful: operators must know which PostgreSQL major track they are deploying, whether the image was tested, and how to roll back to a previous build.

This design is the target release model. The current CI workflow builds and tests `pg-phoenix-image:test`; registry publishing should be added as a manual release workflow, not as an automatic publish on every merge to `main`.

## Release Tracks

Each supported PostgreSQL major version has its own image track. The initial supported set is PostgreSQL 14 through 18.

| Track | Meaning |
|---|---|
| `14` | PostgreSQL 14 image line |
| `15` | PostgreSQL 15 image line |
| `16` | PostgreSQL 16 image line |
| `17` | PostgreSQL 17 image line |
| `18` | PostgreSQL 18 image line |

Major tracks are intentionally separate because PostgreSQL major versions are not binary-compatible on disk. Moving from one track to another is a major upgrade and requires the explicit `PG_UPGRADE=true` flow described in [upgrade-major.md](upgrade-major.md).

Minor PostgreSQL updates stay within the same major track. A new `postgres:18.3-bookworm` base image produces a new `18` image build and a new `18.3` minor tag, but does not require `pg_upgrade`.

## Track Manifest

The Dockerfile stays generic and accepts `PG_BASE` as a build argument. Supported PostgreSQL tracks live in [release-tracks.json](../../release-tracks.json) so Renovate and CI can reason about every track without duplicating Dockerfiles.

Each manifest entry records the PostgreSQL major, the current upstream minor, and the pinned official `postgres:<major>.<minor>-bookworm@sha256:<digest>` base image. Renovate tracks each `base` value in the manifest. That lets it open PRs for both kinds of upstream change:

- same PostgreSQL minor tag, new digest: Debian/security rebuild
- new PostgreSQL minor tag: PostgreSQL minor release

The current Dockerfile default may stay on one track for local convenience, but release CI must pass `--build-arg PG_BASE=<manifest base>` for every supported track.

## Tagging Strategy

Publish immutable tags for audit and rollback, plus moving convenience tags for each PostgreSQL major and minor track.

| Tag | Mutable | Purpose |
|---|---:|---|
| `18` | yes | Latest tested image for the PostgreSQL 18 major track |
| `18.3` | yes | Latest tested image for the PostgreSQL 18.3 minor track |
| `18.3-v0.4.0` | no | Immutable image for PostgreSQL 18.3 from project release `v0.4.0` |
| `18.3-v0.4.0-sha-<shortsha>` | no | Optional source trace tag for that released image |
| image digest | no | Deployment pin for strict GitOps environments |

Deployments should prefer immutable tags or digests. Moving tags such as `18` and `18.3` are convenient for development and simple environments, but GitOps production manifests should pin an immutable tag or digest so rollouts are explicit and rollback is deterministic.

Do not publish generic `latest`. It hides the PostgreSQL major version and makes accidental major upgrades easier.

## Versioning

The project package version is not the image version. Image compatibility is primarily determined by:

- PostgreSQL major track (`18`, `19`, ...)
- PostgreSQL upstream minor version (`18.2`, `18.3`, ...)
- source commit
- base image digest
- WAL-G version and checksum

Use plain SemVer project releases to identify a coherent set of images across all supported PostgreSQL tracks. A release such as `v0.4.0` can publish one immutable image tag per supported track, for example `<postgres-minor>-v0.4.0`. The upstream prefix identifies the PostgreSQL minor version. The project suffix identifies the `pg-phoenix-image` release. The `v` prefix is part of the project release label, so tags read as `<postgres-version>-<project-release>`. If GitHub releases are added, release notes should be keyed by the project release (`v0.4.0`) and list every image tag and digest produced by that release.

Use SemVer maturity stages without pre-release suffixes:

| Stage | Version shape | Meaning |
|---|---|---|
| Alpha | early `0.x.y` | Not used for production data. Suitable for design validation, CI, disposable environments, and production-readiness dry runs. |
| Beta | later `0.x.y` | Limited production usage has started. Known limitations remain, but the supported workflows have been exercised against real infrastructure. |
| Stable | `1.0.0` and later | The project is mature enough to rely on for the documented support boundary. Release criteria should be explicit before the first stable release. |

Until the project reaches stable, version numbers stay below `1.0.0`. Breaking changes are allowed during alpha and beta, but they must be called out in release notes and must not silently reuse immutable tags.

## CI Pipeline

Pull requests should prove the change before merge. With multiple supported tracks, CI should build a matrix from the track manifest.

1. Install Node dependencies with `npm ci`.
2. Run Bash contract tests.
3. Build one image per supported track with `--build-arg PG_BASE=<track base>`.
4. Run image smoke tests for every supported track.
5. Run backup/restore E2E tests for every supported track.
6. Run major-upgrade E2E tests for adjacent supported major pairs.

The required upgrade matrix for PostgreSQL 14 through 18 is:

| Upgrade path | Required |
|---|---:|
| 14 -> 15 | yes |
| 15 -> 16 | yes |
| 16 -> 17 | yes |
| 17 -> 18 | yes |

Do not claim support for skipped major upgrades such as 14 -> 18 unless they are explicitly designed and tested. PostgreSQL major upgrades should proceed one major at a time.

The full matrix is expensive. If CI time becomes a problem, split jobs by suite and track, but keep all supported tracks and adjacent upgrade paths required before release publishing.

## CD Pipeline

Project releases should be created by a manual GitHub Actions workflow. Normal pushes to `main` build and test but do not create GitHub releases or publish images.

The project release workflow:

1. Runs from a selected commit on `main`.
2. Finds the latest `vMAJOR.MINOR.PATCH` tag.
3. Bumps the selected SemVer component.
4. Creates the new `v*` tag.
5. Creates a GitHub release with generated notes from commits and PRs since the previous tag.

Image publishing is a separate follow-up workflow that consumes a project release such as `v0.4.0`.

Target flow:

1. Operator creates a project release, for example `v0.4.0`.
2. Operator starts an image release workflow for that project release and PostgreSQL track set.
3. Workflow builds each selected track image once with the intended release metadata.
4. Workflow tests those exact local image tags.
5. Workflow logs in to the registry.
6. Workflow pushes immutable tags for each selected track:
   - `<major>.<minor>-<project-release>`
   - `<major>.<minor>-<project-release>-sha-<shortsha>` (optional trace tag)
7. Workflow pushes or updates moving tags:
   - `<major>.<minor>`
   - `<major>`
8. Workflow emits every image digest in the job summary.

The publish job should never rebuild after tests. Rebuilding creates a gap where the tested image and pushed image may differ if the base image tag or build context changes. The manifest pins each base image by digest; preserving the same local images through test and push keeps the guarantee simple.

Manual release inputs should include:

| Input | Purpose |
|---|---|
| commit/ref | Exact source revision to release; must resolve to `main` |
| project release | SemVer release identity shared by every image in the set, for example `v0.4.0` |
| tracks | Track list to publish, or `all` |
| publish moving tags | Usually true; can be false for release-candidate dry runs |

Release-candidate builds can use immutable tags such as `<major>.<minor>-v0.4.0-rc` without updating moving tags, but normal project releases should use plain SemVer.

## Registry

The default registry should be GitHub Container Registry unless a deployment requires a private registry:

```text
ghcr.io/<owner>/pg-phoenix-image:<tag>
```

Use GitHub Actions OIDC or repository-scoped package permissions for publishing. Avoid long-lived registry passwords in CI where the registry supports short-lived credentials.

## Minor Version Upgrades

Minor PostgreSQL upgrades are handled by rebuilding the same major track when the track manifest changes.

Renovate owns detection:

1. The track manifest pins `postgres:<major>.<minor>-bookworm@sha256:<digest>` for every supported major.
2. Renovate detects a new digest for the same minor tag or a new minor tag for that major.
3. Renovate opens a PR updating the affected manifest entry.
4. CI builds and tests the affected track. Release CI may build all tracks for simplicity.
5. If the PR merges, no image is published automatically.
6. An operator runs the manual release workflow for the affected track, producing a new immutable tag such as `18.3-v0.4.0` and updating moving tags `18.3` and `18`.
7. Operators deploy the new image normally; PostgreSQL restarts on the same PGDATA with no data migration.

PostgreSQL minor updates are allowed to automerge only if the full test suite is required and green. WAL-G version updates must remain manual because they can affect backup and restore compatibility independently from PostgreSQL.

## Major Version Releases

A new PostgreSQL major track is created deliberately:

1. Add a new manifest entry for the new `postgres:<major>.<minor>-bookworm` base.
2. Confirm WAL-G supports the target PostgreSQL major.
3. Confirm the old and new official PostgreSQL images use compatible Debian releases for the binary stash approach.
4. Run the full test suite with `PG_TEST_OLD=<old>` and `PG_TEST_NEW=<new>`.
5. Publish the new major track only after upgrade E2E passes.

Publishing `19` does not upgrade users by itself if they pin `18.*` tags or digests. Operators opt into the major upgrade by deploying the `19` track and setting `PG_UPGRADE=true`.

## Rollback

For minor image regressions, rollback is an image rollback within the same PostgreSQL major track. Deploy the previous immutable tag or digest; PGDATA remains compatible.

For major upgrade regressions after PostgreSQL has accepted writes on the new major, rollback is not an image-only operation. Follow [upgrade-major.md](upgrade-major.md) and [restore.md](restore.md): revert the image to the old major and restore from the pre-upgrade backup prefix.

## Required CI/CD Checks Before Enabling Publishing

- The publish workflow must be manually dispatched from a selected `main` commit.
- The publish workflow must push only after all current tests pass for the selected tracks.
- The pushed image digest must be recorded in workflow output.
- The workflow must publish immutable `<major>.<minor>-<project-release>` tags before updating moving `<major>.<minor>` and `<major>` tags.
- Renovate automerge must be blocked unless required CI checks include backup/restore and upgrade E2E.
- Registry retention must keep immutable release tags for the rollback window.
- Deployment docs must show immutable tags or digests for production examples.

## Open Decisions

| Decision | Default recommendation |
|---|---|
| Registry namespace | `ghcr.io/<owner>/pg-phoenix-image` |
| Track manifest path | `release-tracks.json` in the repository root |
| Production deployment reference | Immutable tag or digest, not moving `<major>` or `<major>.<minor>` tags |
| Release cadence | Manual release after reviewing merged changes and Renovate PRs |
| Generic `latest` tag | Do not publish |
| PostgreSQL digest PR automerge | Allowed only with full required CI |
| WAL-G version PR automerge | Disabled; manual checksum and restore review |

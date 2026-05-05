# Image Build and Release

## Purpose

Define how `pg-phoenix-image` is built, tagged, published, and consumed. The release model has two independent axes:

- **Project release**: our harness, scripts, defaults, Dockerfile, WAL-G pin, and tests.
- **PostgreSQL track**: the upstream `postgres:<major>.<minor>-bookworm@sha256:<digest>` base image.

Project releases are created only when this project changes. Upstream PostgreSQL minor or digest changes can publish refreshed images under the latest existing project release, but must not create a new project release.

## Tracks

Each supported PostgreSQL major has a separate track in [release-tracks.json](../../release-tracks.json). The Dockerfile stays generic and release builds pass the selected manifest entry as `--build-arg PG_BASE=<track base>`.

Major tracks stay separate because PostgreSQL major versions are not binary-compatible on disk. Moving from `17` to `18` is an explicit major upgrade using `PG_UPGRADE=true`; minor updates within a track restart on the same PGDATA and do not run `pg_upgrade`.

The manifest records:

| Field | Meaning |
|---|---|
| `major` | PostgreSQL major track, such as `17` |
| `minor` | Current upstream minor, such as `17.9` |
| `base` | Pinned official base image with digest |

Renovate monitors `base` values and opens PRs for both same-minor digest rebuilds and newer PostgreSQL minor tags. New PostgreSQL majors are proposed by the `Release Tracks` workflow and merged deliberately after upgrade compatibility review.

## Versioning

The project package version is not the image compatibility boundary. An image is identified by:

- PostgreSQL major
- PostgreSQL minor
- upstream base digest
- project release tag
- project release source commit
- WAL-G version and checksum

Plain SemVer project releases, such as `v0.4.0`, identify a tested harness version. A PostgreSQL refresh reuses that project release until the project itself changes.

## Tags

Publish immutable tags for audit and rollback, plus moving tags for controlled update channels. Do not publish generic `latest`.

| Tag | Mutable | Meaning |
|---|---:|---|
| `17.9-v0.4.0-base-0042a9d3d336` | no | Exact project release, PostgreSQL minor, and base digest |
| `17.9-v0.4.0-sha-<shortsha>` | no | Exact project release source trace |
| `17-v0.4.0` | yes | Latest PostgreSQL 17 image tested with project release `v0.4.0` |
| `17` | yes | Latest project release and latest PostgreSQL 17 track |
| `17.9` | yes | Latest project release for PostgreSQL 17.9 |
| image digest | no | Strict deployment pin |

The `17-v0.4.0` tag is the important harness-pinned channel: users can stay on this project's `v0.4.0` harness while receiving PostgreSQL 17 minor and security refreshes. Users who need exact reproducibility should deploy the immutable base-digest tag or the image digest.

## Publish Events

Image publishing uses one reusable workflow plus event-specific callers:

| Workflow | Role |
|---|---|
| `publish-images.yml` | Reusable build/test/push implementation |
| `release.yml` | Creates project releases and directly calls image publishing |
| `publish-project-release.yml` | Publishes images for releases created outside the `Release` workflow |
| `publish-postgres-refresh.yml` | Publishes changed tracks after `release-tracks.json` reaches `main` |

The direct call from `release.yml` is required because GitHub does not trigger follow-on workflows for release events created with `GITHUB_TOKEN`.

### Project Release

Triggered by a published GitHub release such as `v0.4.0`.

The reusable publisher builds every selected PostgreSQL track from the release tag source and tests the exact local images. Passing image jobs push only run-scoped tags to the staging package. After every selected image and required adjacent upgrade test passes, one promotion job tags each staged image into the public package with its immutable and moving tags. If the run fails before promotion, cleanup removes the staging package versions and no public release tags are left behind.

The same publisher can be dispatched manually for repair or dry-run validation. Manual inputs select the project release tag, track list, whether moving tags should update, and whether pushes should be skipped.

### PostgreSQL Refresh

Triggered after a `release-tracks.json` change reaches `main`.

The workflow resolves the latest non-draft, non-prerelease GitHub release matching `vMAJOR.MINOR.PATCH`, builds only the changed PostgreSQL tracks, and republishes them under that same project release. It must not create a GitHub release or bump the project version. If no project release exists, it exits without publishing.

To prevent unreleased harness changes from entering refresh images, the workflow uses this build context rule:

1. Check out the latest project release tag, for example `v0.4.0`.
2. Replace only `release-tracks.json` with the version from `main`.
3. Build from that checkout with the selected `PG_BASE` values.

The workflow must exit unless the triggering change is limited to `release-tracks.json`. Any Dockerfile, script, config, dependency, or test change requires a new project release before it can be published.

## Image Metadata

Published images should include OCI labels that make the build contract inspectable:

| Label | Value |
|---|---|
| `org.opencontainers.image.version` | Project release tag, such as `v0.4.0` |
| `org.opencontainers.image.revision` | Commit behind the project release tag |
| `org.opencontainers.image.source` | Repository URL |
| `org.pg-phoenix.postgres.base` | Full pinned `postgres:<minor>-bookworm@sha256:<digest>` base |
| `org.pg-phoenix.postgres.major` | Track major |
| `org.pg-phoenix.postgres.minor` | Track minor |

## CI Requirements

Pull requests should prove the change before merge. With multiple supported tracks, CI should build from `release-tracks.json` instead of the Dockerfile default.

1. Install Node dependencies with `npm ci`.
2. Run Bash contract tests.
3. Build one image per supported track with `--build-arg PG_BASE=<track base>`.
4. Run image smoke tests for every supported track.
5. Run backup/restore E2E tests for every supported track.
6. Run major-upgrade E2E tests for adjacent supported major pairs.

Do not claim support for skipped major upgrades such as `14 -> 18` unless they are explicitly designed and tested. PostgreSQL major upgrades proceed one major at a time.

## Publishing Rules

- The publish workflow must test the exact local image before pushing it.
- The publish workflow must not rebuild after tests.
- Public immutable and moving tags must be promoted only after every selected image and required upgrade test passes.
- Failed publish runs must leave at most run-scoped staging tags, which cleanup removes.
- A selected publish set should update moving tags only after every selected track passes.
- Every pushed digest must be written to the workflow summary.
- PostgreSQL refresh publishing must use release-tag harness files plus current `release-tracks.json`.
- Renovate automerge is allowed only when required CI includes backup/restore and adjacent-upgrade coverage.
- WAL-G updates remain manual because they can affect backup format, restore behavior, and PostgreSQL version support independently from the base image.

## Major Tracks

A new PostgreSQL major track starts as a PR from the `Release Tracks` workflow. Before publishing the new track:

1. Review the generated `postgres:<major>.<minor>-bookworm@sha256:<digest>` entry.
2. Confirm the pinned WAL-G version supports the target PostgreSQL major.
3. Confirm adjacent official PostgreSQL images use compatible Debian releases for the binary stash approach.
4. Run the full test suite with the old and new adjacent majors.
5. Publish the new major only after upgrade E2E passes.

Publishing `18` does not upgrade users pinned to `17.*` tags or digests. Operators opt into a major upgrade by deploying the new major track and setting `PG_UPGRADE=true`.

## Rollback

For minor image regressions, deploy the previous immutable tag or digest within the same PostgreSQL major track. PGDATA remains compatible.

For major upgrade regressions after PostgreSQL has accepted writes on the new major, rollback is not image-only. Revert to the old major image and restore from the pre-upgrade backup prefix described in [upgrade-major.md](upgrade-major.md) and [restore.md](restore.md).

## Registry

Default registry:

```text
ghcr.io/<owner>/pg-phoenix-image:<tag>
```

Use repository-scoped package permissions or OIDC where supported. Registry retention must keep immutable release tags for the rollback window.

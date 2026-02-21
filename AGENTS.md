# Must Follow Rules
- Do not edit code files unless explicitly asked to
- Use modern vanilla JavaScript ES2025 `.js` for tests and Bash `.sh` for scripts
- Simplisity and readability are paramount — avoid complex constructs, prefer clarity over cleverness

# When writing documentation
- When asked to write documentation make sure no information is repeated, don't explain basics, don't go into obvious or easily searcheable details. Treat the reader as a peer and focus on the unique aspects of the project. Avoid generic statements and instead provide specific insights, design decisions, and implementation details that are not commonly known
Never include full code snippets in documentation, instead provide high-level overviews and link to the code for details
- Explain the rationale behind design decisions and trade-offs, rather than just stating what was done
- Update documentation files when code changes are made, ensuring consistency between code and docs

## Logging in scripts
All scripts source `scripts/lib/logger.sh` (installed to `/usr/local/lib/logger.sh` in the container). Use `log_info`, `log_warn`, `log_error`, `log_debug`, `log_fatal` (error + exit 1), `log_phase` (section markers). Set `LOG_COMPONENT` before sourcing to tag output. Output goes to stderr — stdout is reserved for data pipes. All scripts use `#!/usr/bin/env bash` with `set -euo pipefail`. Prefer `[[ ]]`, arrays, and `${var//pat/rep}` over spawning subprocesses

## Tests
`npm test` — `.test.js` files in `tests/`. Vitest + Testcontainers — spins up pg-phoenix-image + MinIO containers programmatically. Tests real PG behavior, WAL-G, backup/restore flows. No Compose files.

Files are grouped by container topology (not by feature) to minimize container starts. 5 files run in parallel; tests within each file run sequentially (shared container state). Each `describe` block manages its own container lifecycle via `beforeAll`/`afterAll`. See [docs/architecture/testing.md](docs/architecture/testing.md) for the full test plan.
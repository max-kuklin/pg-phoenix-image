import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

describe('script stubs contract', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('backup exits cleanly when PostgreSQL is not ready', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/bin',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 1" > /tmp/bin/pg_isready',
      'chmod +x /tmp/bin/pg_isready',
      'PATH=/tmp/bin:$PATH LOGGER_PATH=./scripts/lib/logger.sh bash ./scripts/backup.sh'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ WARN  \[backup\] PostgreSQL is not ready; skipping backup\n$/);
  });

  test('restore rejects bad arguments through logger', async () => {
    const result = await bash.run(
      'LOGGER_PATH=./scripts/lib/logger.sh WALG_LIB_PATH=./scripts/lib/walg.sh RESTORE_ARGS_LIB_PATH=./scripts/lib/restore-args.sh bash ./scripts/restore.sh --bad'
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[restore\] usage: restore\.sh/);
  });

  test('upgrade preflight requires entrypoint-provided environment', async () => {
    const result = await bash.run('LOGGER_PATH=./scripts/lib/logger.sh WALG_LIB_PATH=./scripts/lib/walg.sh bash ./scripts/upgrade.sh');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] PG_OLD_MAJOR is required\n$/);
  });

  test('upgrade preflight refuses invalid backup max age', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'LOGGER_PATH=./scripts/lib/logger.sh WALG_LIB_PATH=./scripts/lib/walg.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_UPGRADE_BACKUP_MAX_AGE=soon bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] PG_UPGRADE_BACKUP_MAX_AGE must be a non-negative integer\n$/);
  });

  test('upgrade preflight requires old PostgreSQL binary stash', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'rm -rf /tmp/pg-binaries',
      'LOGGER_PATH=./scripts/lib/logger.sh WALG_LIB_PATH=./scripts/lib/walg.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_BINARY_STASH_ROOT=/tmp/pg-binaries bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[upgrade] no stashed PostgreSQL binaries for version 17 at /tmp/pg-binaries/17/bin');
  });

  test('upgrade proceeds through pg_upgrade when gates pass', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker /tmp/pg-binaries/17/bin /tmp/pg-binaries/17/lib /tmp/pg-binaries/17/share',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'for binary in postgres pg_upgrade pg_controldata pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/tmp/pg-binaries/17/bin/$binary"; chmod +x "/tmp/pg-binaries/17/bin/$binary"; done',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/pg-binaries/17/bin/pg_ctl',
      'chmod +x /tmp/pg-binaries/17/bin/pg_ctl',
      'mkdir -p /tmp/bin',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/postgres',
      'printf "%s\\n" "#!/usr/bin/env bash" "mkdir -p \\"\\${@: -1}\\"" "printf \\"18\\\\n\\" > \\"\\${@: -1}/PG_VERSION\\"" > /tmp/bin/initdb',
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_upgrade:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg-upgrade.log" "exit 0" > /tmp/bin/pg_upgrade',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/pg_ctl',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/vacuumdb',
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/postgres /tmp/bin/initdb /tmp/bin/pg_upgrade /tmp/bin/pg_ctl /tmp/bin/vacuumdb /tmp/bin/wal-g',
      'PATH=/tmp/bin:$PATH LOGGER_PATH=./scripts/lib/logger.sh WALG_LIB_PATH=./scripts/lib/walg.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_BINARY_STASH_ROOT=/tmp/pg-binaries WALG_S3_PREFIX=s3://bucket/db WALG_ENV_FILE=/tmp/walg-env.sh bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[upgrade] ------ checking PostgreSQL major upgrade ------');
    expect(result.stderr).toContain('[upgrade] major upgrade completed; remove PG_UPGRADE=true before the next rollout');
  });
});

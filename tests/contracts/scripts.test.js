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
    const result = await bash.run('LOGGER_PATH=./scripts/lib/logger.sh bash ./scripts/upgrade.sh');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] PG_OLD_MAJOR is required\n$/);
  });

  test('upgrade preflight refuses invalid backup max age', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'LOGGER_PATH=./scripts/lib/logger.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_UPGRADE_BACKUP_MAX_AGE=soon bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] PG_UPGRADE_BACKUP_MAX_AGE must be a non-negative integer\n$/);
  });

  test('upgrade preflight requires old PostgreSQL binary stash', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'LOGGER_PATH=./scripts/lib/logger.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_BINARY_STASH_ROOT=/tmp/pg-binaries bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[upgrade] no stashed PostgreSQL binaries for version 17 at /tmp/pg-binaries/17/bin');
  });

  test('upgrade preflight reaches execution stop when gates pass', async () => {
    const result = await bash.run([
      'mkdir -p /tmp/pg/18/docker /tmp/pg-binaries/17/bin',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'for binary in postgres pg_upgrade pg_ctl pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/tmp/pg-binaries/17/bin/$binary"; chmod +x "/tmp/pg-binaries/17/bin/$binary"; done',
      'LOGGER_PATH=./scripts/lib/logger.sh PG_OLD_MAJOR=17 PG_NEW_MAJOR=18 PGDATA=/tmp/pg/18/docker PG_BINARY_STASH_ROOT=/tmp/pg-binaries bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] upgrade execution is not implemented yet\n$/);
  });
});

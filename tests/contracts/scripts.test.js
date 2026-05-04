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

  test('upgrade stub fails closed until implemented', async () => {
    const result = await bash.run('LOGGER_PATH=./scripts/lib/logger.sh bash ./scripts/upgrade.sh');

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[upgrade\] upgrade script is not implemented yet\n$/);
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

const mockRuntime = [
  'mkdir -p /tmp/bin /tmp/etc-postgresql/conf.d',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"postgres (PostgreSQL) 18.0\\\\n\\"" > /tmp/bin/postgres',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"entrypoint:%s\\\\n\\" \\"\\$*\\"" > /tmp/bin/docker-entrypoint.sh',
  'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/chown',
  'chmod +x /tmp/bin/postgres /tmp/bin/docker-entrypoint.sh /tmp/bin/chown',
  'export PATH=/tmp/bin:$PATH',
  'export LOGGER_PATH=./scripts/lib/logger.sh',
  'export WALG_LIB_PATH=./scripts/lib/walg.sh'
];

describe('entrypoint contracts', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('plain PostgreSQL startup delegates to the official entrypoint with shipped config', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('entrypoint:postgres -c config_file=/etc/postgresql/postgresql.conf\n');
    expect(result.stderr).toBe('');
  });

  test('WAL-G prefix requires backup schedule', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'WALG_S3_PREFIX=s3://bucket/db bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[entrypoint] BACKUP_SCHEDULE is required when WAL-G archiving is enabled');
  });

  test('rejects invalid archive timeout before startup', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'WALG_S3_PREFIX=s3://bucket/db BACKUP_SCHEDULE="0 0 * * *" ARCHIVE_TIMEOUT=soon bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[entrypoint] ARCHIVE_TIMEOUT must be a non-negative integer');
  });

  test('rejects malformed backup schedule before startup', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'WALG_S3_PREFIX=s3://bucket/db BACKUP_SCHEDULE="0 0 *" bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[entrypoint] BACKUP_SCHEDULE must contain exactly 5 cron fields');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

const mockRuntime = [
  'mkdir -p /tmp/bin /tmp/etc-postgresql/conf.d',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"postgres (PostgreSQL) 18.0\\\\n\\"" > /tmp/bin/postgres',
  'for binary in pg_upgrade pg_ctl pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/tmp/bin/$binary"; done',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"entrypoint:%s\\\\n\\" \\"\\$*\\"" > /tmp/bin/docker-entrypoint.sh',
  'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/chown',
  'chmod +x /tmp/bin/postgres /tmp/bin/pg_upgrade /tmp/bin/pg_ctl /tmp/bin/pg_resetwal /tmp/bin/pg_dump /tmp/bin/pg_dumpall /tmp/bin/docker-entrypoint.sh /tmp/bin/chown',
  'export PATH=/tmp/bin:$PATH',
  'export PGDATA=/tmp/pg/18/docker',
  'export PG_BINARY_STASH_ROOT=/tmp/pg-binaries',
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
    expect(result.stderr).toContain('[entrypoint] stashed PostgreSQL 18 binaries at /tmp/pg-binaries/18/bin');
  });

  test('matching PGDATA version starts normally', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'mkdir -p /tmp/pg/18/docker',
      'printf "18\\n" > /tmp/pg/18/docker/PG_VERSION',
      'bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('entrypoint:postgres -c config_file=/etc/postgresql/postgresql.conf\n');
  });

  test('version mismatch without upgrade gate refuses startup', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'mkdir -p /tmp/pg/18/docker',
      'printf "17\\n" > /tmp/pg/18/docker/PG_VERSION',
      'bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[entrypoint] PGDATA is version 17 but this image runs PostgreSQL 18');
    expect(result.stderr).toContain('Set PG_UPGRADE=true to perform an in-place major upgrade');
  });

  test('version mismatch with upgrade gate invokes upgrade script before handoff', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'mkdir -p /tmp/pg/18/docker /tmp/bin',
      'printf "17\\n" > /tmp/pg/18/docker/PG_VERSION',
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"upgrade:%s:%s:%s\\\\n\\" \\"\\$PG_OLD_MAJOR\\" \\"\\$PG_NEW_MAJOR\\" \\"\\$PGDATA\\"" "printf \\"18\\\\n\\" > \\"\\$PGDATA/PG_VERSION\\"" > /tmp/bin/upgrade-test.sh',
      'chmod +x /tmp/bin/upgrade-test.sh',
      'PG_UPGRADE=true UPGRADE_SCRIPT_PATH=/tmp/bin/upgrade-test.sh bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('upgrade:17:18:/tmp/pg/18/docker');
    expect(result.stdout).toContain('entrypoint:postgres -c config_file=/etc/postgresql/postgresql.conf');
  });

  test('upgrade gate refuses handoff when upgrade leaves mismatched PGDATA', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'mkdir -p /tmp/pg/18/docker /tmp/bin',
      'printf "17\\n" > /tmp/pg/18/docker/PG_VERSION',
      'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/upgrade-test.sh',
      'chmod +x /tmp/bin/upgrade-test.sh',
      'PG_UPGRADE=true UPGRADE_SCRIPT_PATH=/tmp/bin/upgrade-test.sh bash ./scripts/entrypoint.sh postgres'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[entrypoint] upgrade script completed but PGDATA is still version 17; expected PostgreSQL 18');
  });

  test('stashes required PostgreSQL binaries', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'bash ./scripts/entrypoint.sh postgres >/tmp/entrypoint.out',
      'test -x /tmp/pg-binaries/18/bin/postgres',
      'test -x /tmp/pg-binaries/18/bin/pg_upgrade',
      'test -x /tmp/pg-binaries/18/bin/pg_ctl',
      'test -x /tmp/pg-binaries/18/bin/pg_resetwal',
      'test -x /tmp/pg-binaries/18/bin/pg_dump',
      'test -x /tmp/pg-binaries/18/bin/pg_dumpall',
      'test -s /tmp/pg-binaries/18/checksum'
    ].join('; '));

    expect(result.code).toBe(0);
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

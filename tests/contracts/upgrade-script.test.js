import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

const mockRuntime = [
  'mkdir -p /tmp/bin /tmp/pg/18/docker /tmp/pg-binaries/17/bin',
  'printf "17\\n" > /tmp/pg/18/docker/PG_VERSION',
  'for binary in postgres pg_upgrade pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/tmp/pg-binaries/17/bin/$binary"; done',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_ctl:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_ctl.log" "exit 0" > /tmp/pg-binaries/17/bin/pg_ctl',
  'chmod +x /tmp/pg-binaries/17/bin/*',
  'export PATH=/tmp/bin:$PATH',
  'export PG_OLD_MAJOR=17',
  'export PG_NEW_MAJOR=18',
  'export PGDATA=/tmp/pg/18/docker',
  'export PG_BINARY_STASH_ROOT=/tmp/pg-binaries',
  'export WALG_S3_PREFIX=s3://bucket/db',
  'export WALG_ENV_FILE=/tmp/walg-env.sh',
  'export LOGGER_PATH=./scripts/lib/logger.sh',
  'export WALG_LIB_PATH=./scripts/lib/walg.sh'
];

describe('upgrade script contracts', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('requires WAL-G prefix before major upgrade', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'unset WALG_S3_PREFIX',
      'bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] a WAL-G prefix is required before major upgrade');
  });

  test('starts old PostgreSQL on localhost temporary port for backup gate', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'set +e',
      'bash ./scripts/upgrade.sh',
      'code=$?',
      'cat /tmp/pg_ctl.log',
      'cat /tmp/walg-env.sh',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] recent pre-upgrade backup found for PostgreSQL 17');
    expect(result.stderr).toContain('[upgrade] upgrade execution is not implemented yet');
    expect(result.stdout).toContain("pg_ctl:-D /tmp/pg/18/docker -o -p 5433 -c listen_addresses='localhost' -c config_file=/etc/postgresql/postgresql.conf -w start");
    expect(result.stdout).toContain('pg_ctl:-D /tmp/pg/18/docker -m fast -w stop');
    expect(result.stdout).toContain("export WALG_S3_PREFIX='s3://bucket/db/17'");
  });

  test('pushes backup when latest backup is missing', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"wal-g:%s:PGHOST=%s:PGPORT=%s\\\\n\\" \\"\\$*\\" \\"\\${PGHOST:-}\\" \\"\\${PGPORT:-}\\" >> /tmp/walg.log" "if [[ \\"\\$1\\" == backup-list ]]; then if [[ -f /tmp/backup-pushed ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; fi; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then touch /tmp/backup-pushed; exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'set +e',
      'bash ./scripts/upgrade.sh',
      'code=$?',
      'cat /tmp/walg.log',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] ------ pushing pre-upgrade backup ------');
    expect(result.stderr).toContain('[upgrade] pre-upgrade backup verified for PostgreSQL 17');
    expect(result.stdout).toContain('wal-g:backup-push /tmp/pg/18/docker:PGHOST=localhost:PGPORT=5433');
  });

  test('refuses upgrade when pushed backup is not visible', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'bash ./scripts/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] pre-upgrade backup was not visible after backup-push');
    expect(result.stderr).not.toContain('[upgrade] upgrade execution is not implemented yet');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

const mockRuntime = [
  'mkdir -p /tmp/bin /tmp/pg/18/docker /tmp/pg-binaries/17/bin /tmp/pg-binaries/17/lib /tmp/pg-binaries/17/share',
  'printf "17\\n" > /tmp/pg/18/docker/PG_VERSION',
  'for binary in postgres pg_upgrade pg_controldata pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/tmp/pg-binaries/17/bin/$binary"; done',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_ctl:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_ctl.log" "exit 0" > /tmp/pg-binaries/17/bin/pg_ctl',
  'printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > /tmp/bin/postgres',
  'printf "%s\\n" "#!/usr/bin/env bash" "while [[ \\"\\$#\\" -gt 0 ]]; do if [[ \\"\\$1\\" == -D ]]; then shift; mkdir -p \\"\\$1\\"; printf \\"18\\\\n\\" > \\"\\$1/PG_VERSION\\"; fi; shift || true; done" > /tmp/bin/initdb',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_upgrade:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_upgrade.log" "exit 0" > /tmp/bin/pg_upgrade',
  'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"new_pg_ctl:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_ctl.log" "exit 0" > /tmp/bin/pg_ctl',
  'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == --help ]]; then printf \\"%s\\\\n\\" \\"vacuumdb help --missing-stats-only\\"; exit 0; fi" "printf \\"vacuumdb:%s\\\\n\\" \\"\\$*\\" >> /tmp/vacuumdb.log" "exit 0" > /tmp/bin/vacuumdb',
  'chmod +x /tmp/pg-binaries/17/bin/*',
  'chmod +x /tmp/bin/postgres /tmp/bin/initdb /tmp/bin/pg_upgrade /tmp/bin/pg_ctl /tmp/bin/vacuumdb',
  'export PATH=/tmp/bin:$PATH',
  'export PG_OLD_MAJOR=17',
  'export PG_NEW_MAJOR=18',
  'export PGDATA=/tmp/pg/18/docker',
  'export PG_BINARY_STASH_ROOT=/tmp/pg-binaries',
  'export WALG_S3_PREFIX=s3://bucket/db',
  'export WALG_ENV_FILE=/tmp/walg-env.sh',
  'export LOGGER_PATH=./image/lib/logger.sh',
  'export WALG_LIB_PATH=./image/lib/walg.sh'
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
      'bash ./image/upgrade.sh'
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
      'bash ./image/upgrade.sh',
      'code=$?',
      'cat /tmp/pg_ctl.log',
      'cat /tmp/walg-env.sh',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] recent pre-upgrade backup found for PostgreSQL 17');
    expect(result.stderr).toContain('[upgrade] ------ initializing PostgreSQL 18 data directory ------');
    expect(result.stdout).toContain("pg_ctl:-D /tmp/pg/18/docker -o -p 5433 -c listen_addresses='localhost' -c config_file=/etc/postgresql/postgresql.conf -w start");
    expect(result.stdout).toContain('pg_ctl:-D /tmp/pg/18/docker -m fast -w stop');
    expect(result.stdout).toContain("export WALG_S3_PREFIX='s3://bucket/db/18'");
    expect(result.stdout).toContain('new_pg_ctl:-D /tmp/pg/18/docker -m fast -w stop');
  });

  test('pushes backup when latest backup is missing', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"wal-g:%s:PGHOST=%s:PGPORT=%s\\\\n\\" \\"\\$*\\" \\"\\${PGHOST:-}\\" \\"\\${PGPORT:-}\\" >> /tmp/walg.log" "if [[ \\"\\$1\\" == backup-list ]]; then if [[ -f /tmp/backup-pushed ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; fi; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then touch /tmp/backup-pushed; exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'set +e',
      'bash ./image/upgrade.sh',
      'code=$?',
      'cat /tmp/walg.log',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[upgrade] ------ pushing pre-upgrade backup ------');
    expect(result.stderr).toContain('[upgrade] pre-upgrade backup verified for PostgreSQL 17');
    expect(result.stderr).toContain('[upgrade] ------ initializing PostgreSQL 18 data directory ------');
    expect(result.stderr).toContain('[upgrade] major upgrade completed; remove PG_UPGRADE=true before the next rollout');
    expect(result.stdout).toContain('wal-g:backup-push /tmp/pg/18/docker:PGHOST=localhost:PGPORT=5433');
  });

  test('runs executable post-upgrade analyze script', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$*\\" == *--link* ]]; then printf \\"%s\\\\n\\" \\"#!/usr/bin/env bash\\" \\"printf analyzed > /tmp/analyze-ran\\" > /tmp/pg_upgrade/analyze_new_cluster.sh; chmod +x /tmp/pg_upgrade/analyze_new_cluster.sh; fi" "exit 0" > /tmp/bin/pg_upgrade',
      'chmod +x /tmp/bin/wal-g /tmp/bin/pg_upgrade',
      'bash ./image/upgrade.sh',
      'cat /tmp/analyze-ran'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('analyzed');
    expect(result.stderr).toContain('[upgrade] ------ running post-upgrade analyze ------');
  });

  test('falls back to vacuumdb when pg_upgrade does not create analyze script', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'bash ./image/upgrade.sh',
      'cat /tmp/vacuumdb.log'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('vacuumdb:--all --analyze-in-stages --missing-stats-only');
    expect(result.stdout).toContain('vacuumdb:--all --analyze-only');
    expect(result.stderr).toContain('[upgrade] ------ running post-upgrade analyze ------');
  });

  test('omits missing-stats-only when target vacuumdb does not support it', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'rm -f /tmp/vacuumdb.log',
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == --help ]]; then printf \\"%s\\\\n\\" \\"vacuumdb help\\"; exit 0; fi" "printf \\"vacuumdb:%s\\\\n\\" \\"\\$*\\" >> /tmp/vacuumdb.log" "exit 0" > /tmp/bin/vacuumdb',
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/vacuumdb /tmp/bin/wal-g',
      'bash ./image/upgrade.sh',
      'cat /tmp/vacuumdb.log'
    ].join('; '));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('vacuumdb:--all --analyze-in-stages');
    expect(result.stdout).not.toContain('--missing-stats-only');
    expect(result.stdout).toContain('vacuumdb:--all --analyze-only');
  });

  test('refuses upgrade when pushed backup is not visible', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'chmod +x /tmp/bin/wal-g',
      'bash ./image/upgrade.sh'
    ].join('; '));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[upgrade] pre-upgrade backup was not visible after backup-push');
    expect(result.stderr).not.toContain('[upgrade] upgrade execution is not implemented yet');
  });

  test('removes new PGDATA when pg_upgrade fails before the swap', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_upgrade:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_upgrade.log" "if [[ \\"\\$*\\" == *--link* ]]; then exit 42; fi" "exit 0" > /tmp/bin/pg_upgrade',
      'chmod +x /tmp/bin/wal-g /tmp/bin/pg_upgrade',
      'set +e',
      'bash ./image/upgrade.sh',
      'code=$?',
      'printf "pgdata=%s\\n" "$(< /tmp/pg/18/docker/PG_VERSION)"',
      'if [[ -e /tmp/pg/18/docker.new ]]; then printf "new_exists=true\\n"; else printf "new_exists=false\\n"; fi',
      'if [[ -e /tmp/pg/18/docker.old ]]; then printf "old_exists=true\\n"; else printf "old_exists=false\\n"; fi',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(42);
    expect(result.stderr).toContain('[upgrade] ------ running PostgreSQL major upgrade ------');
    expect(result.stdout).toContain('pgdata=17');
    expect(result.stdout).toContain('new_exists=false');
    expect(result.stdout).toContain('old_exists=false');
  });

  test('swaps old PGDATA back when post-upgrade PostgreSQL start fails', async () => {
    const result = await bash.run([
      ...mockRuntime,
      'printf "%s\\n" "#!/usr/bin/env bash" "if [[ \\"\\$1\\" == backup-list ]]; then date -u +\\"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ\\"; exit 0; fi" "if [[ \\"\\$1\\" == backup-push ]]; then exit 0; fi" "exit 1" > /tmp/bin/wal-g',
      'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"new_pg_ctl:%s\\\\n\\" \\"\\$*\\" >> /tmp/pg_ctl.log" "if [[ \\"\\$*\\" == *start* ]]; then exit 55; fi" "exit 0" > /tmp/bin/pg_ctl',
      'chmod +x /tmp/bin/wal-g /tmp/bin/pg_ctl',
      'set +e',
      'bash ./image/upgrade.sh',
      'code=$?',
      'printf "pgdata=%s\\n" "$(< /tmp/pg/18/docker/PG_VERSION)"',
      'if [[ -e /tmp/pg/18/docker.new ]]; then printf "new_exists=true\\n"; else printf "new_exists=false\\n"; fi',
      'if [[ -e /tmp/pg/18/docker.old ]]; then printf "old_exists=true\\n"; else printf "old_exists=false\\n"; fi',
      'exit "$code"'
    ].join('; '));

    expect(result.code).toBe(55);
    expect(result.stderr).toContain('[upgrade] ------ starting PostgreSQL 18 for post-upgrade verification ------');
    expect(result.stderr).toContain('[upgrade] upgrade did not complete; restoring PostgreSQL 17 data directory');
    expect(result.stdout).toContain('pgdata=17');
    expect(result.stdout).toContain('new_exists=false');
    expect(result.stdout).toContain('old_exists=false');
  });
});

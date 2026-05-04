import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { IMAGE_NAME } from './helpers/containers.js';

const execFileAsync = promisify(execFile);

async function runImage(env = {}, options = {}) {
  const name = `pg-phoenix-startup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const args = ['run', '--rm', '--name', name];

  if (options.entrypoint) {
    args.push('--entrypoint', options.entrypoint);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }

  for (const bindMount of options.bindMounts ?? []) {
    args.push('--volume', `${bindMount.source}:${bindMount.target}:${bindMount.mode ?? 'rw'}`);
  }

  args.push(IMAGE_NAME, ...(options.command ?? ['postgres']));

  try {
    const result = await execFileAsync('docker', args, {
      timeout: options.timeoutMs ?? 20_000,
      maxBuffer: 1024 * 1024
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => {});

    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

async function setupPgData(pgDataParent, script) {
  const setup = await execFileAsync('docker', [
    'run',
    '--rm',
    '--volume',
    `${pgDataParent}:/var/lib/postgresql:rw`,
    IMAGE_NAME,
    'bash',
    '-lc',
    script
  ]);

  expect(setup.stderr).toBe('');
}

async function readPgDataFile(pgDataParent, relativePath) {
  return readFile(path.join(pgDataParent, relativePath), 'utf8');
}

async function withPgData(callback) {
  const pgDataParent = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-startup-'));

  try {
    await chmod(pgDataParent, 0o777);
    return await callback({ pgDataParent });
  } finally {
    await execFileAsync('docker', [
      'run',
      '--rm',
      '--volume',
      `${pgDataParent}:/var/lib/postgresql:rw`,
      IMAGE_NAME,
      'bash',
      '-lc',
      'chmod -R 0777 /var/lib/postgresql || true'
    ]).catch(() => {});
    await rm(pgDataParent, { recursive: true, force: true });
  }
}

describe('startup behavior', () => {
  test('refuses WAL-G archiving without backup schedule', async () => {
    const result = await runImage({
      POSTGRES_PASSWORD: 'test',
      WALG_S3_PREFIX: 's3://bucket/db'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[entrypoint] BACKUP_SCHEDULE is required when WAL-G archiving is enabled');
  });

  test('refuses invalid archive timeout', async () => {
    const result = await runImage({
      POSTGRES_PASSWORD: 'test',
      WALG_S3_PREFIX: 's3://bucket/db',
      BACKUP_SCHEDULE: '0 0 * * *',
      ARCHIVE_TIMEOUT: 'soon'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[entrypoint] ARCHIVE_TIMEOUT must be a non-negative integer');
  });

  test('refuses malformed backup schedule', async () => {
    const result = await runImage({
      POSTGRES_PASSWORD: 'test',
      WALG_S3_PREFIX: 's3://bucket/db',
      BACKUP_SCHEDULE: '0 0 *'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[entrypoint] BACKUP_SCHEDULE must contain exactly 5 cron fields');
  });

  test('refuses restore without request id', async () => {
    const result = await runImage({
      POSTGRES_PASSWORD: 'test',
      PG_RESTORE: 'true'
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('[restore] PG_RESTORE_REQUEST_ID is required for restore and rollback requests');
  });

  test('stashes PostgreSQL binaries before handoff', async () => {
    await withPgData(async ({ pgDataParent }) => {
      const result = await runImage(
        {},
        {
          command: ['postgres', '--help'],
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code, result.stderr).toBe(0);

      const checksum = await readPgDataFile(pgDataParent, '.pg-binaries/18/checksum');

      expect(checksum).toContain('/usr/lib/postgresql/18/bin/postgres');
      expect(checksum).toContain('/usr/lib/postgresql/18/bin/pg_upgrade');
    });
  });

  test('refuses PGDATA version mismatch without upgrade gate', async () => {
    await withPgData(async ({ pgDataParent }) => {
      await setupPgData(
        pgDataParent,
        'mkdir -p /var/lib/postgresql/18/docker && printf "17\\n" > /var/lib/postgresql/18/docker/PG_VERSION && chmod -R 0777 /var/lib/postgresql'
      );

      const result = await runImage(
        {},
        {
          command: ['postgres', '--help'],
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('[entrypoint] PGDATA is version 17 but this image runs PostgreSQL 18');
      expect(result.stderr).toContain('Set PG_UPGRADE=true to perform an in-place major upgrade');
    });
  });

  test('PGDATA version mismatch with upgrade gate fails closed without old binary stash', async () => {
    await withPgData(async ({ pgDataParent }) => {
      await setupPgData(
        pgDataParent,
        'mkdir -p /var/lib/postgresql/18/docker && printf "17\\n" > /var/lib/postgresql/18/docker/PG_VERSION && chmod -R 0777 /var/lib/postgresql'
      );

      const result = await runImage(
        {
          PG_UPGRADE: 'true'
        },
        {
          command: ['postgres', '--help'],
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('[upgrade] no stashed PostgreSQL binaries for version 17');
    });
  });

  test('upgrade gate starts old-version PostgreSQL temporarily for backup', async () => {
    await withPgData(async ({ pgDataParent }) => {
      const fakeBin = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-bin-'));
      const fakeWalG = path.join(fakeBin, 'wal-g');
      await writeFile(
        fakeWalG,
        [
          '#!/usr/bin/env bash',
          'printf "wal-g:%s:PGHOST=%s:PGPORT=%s\\n" "$*" "${PGHOST:-}" "${PGPORT:-}" >> /var/lib/postgresql/walg.log',
          'if [[ "$1" == backup-list ]]; then if [[ -f /var/lib/postgresql/backup-pushed ]]; then date -u +"backup_name last_modified\\nbase_1 %Y-%m-%dT%H:%M:%SZ"; fi; exit 0; fi',
          'if [[ "$1" == backup-push ]]; then touch /var/lib/postgresql/backup-pushed; exit 0; fi',
          'exit 1'
        ].join('\n'),
        'utf8'
      );
      await chmod(fakeWalG, 0o755);

      try {
        await setupPgData(
          pgDataParent,
          [
            'mkdir -p /var/lib/postgresql/18/docker /var/lib/postgresql/.pg-binaries/17/bin',
            'printf "17\\n" > /var/lib/postgresql/18/docker/PG_VERSION',
            'for binary in postgres pg_upgrade pg_resetwal pg_dump pg_dumpall; do printf "%s\\n" "#!/usr/bin/env bash" "exit 0" > "/var/lib/postgresql/.pg-binaries/17/bin/$binary"; done',
            'printf "%s\\n" "#!/usr/bin/env bash" "printf \\"pg_ctl:%s\\\\n\\" \\"\\$*\\" >> /var/lib/postgresql/pg_ctl.log" "exit 0" > /var/lib/postgresql/.pg-binaries/17/bin/pg_ctl',
            'chmod +x /var/lib/postgresql/.pg-binaries/17/bin/*',
            'chmod -R 0777 /var/lib/postgresql'
          ].join(' && ')
        );

        const result = await runImage(
          {
            PG_UPGRADE: 'true',
            WALG_S3_PREFIX: 's3://bucket/db',
            PATH: '/tmp/bin:/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
          },
          {
            command: ['postgres', '--help'],
            bindMounts: [
              { source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' },
              { source: fakeBin, target: '/tmp/bin', mode: 'ro' }
            ]
          }
        );

        const pgCtlLog = await readPgDataFile(pgDataParent, 'pg_ctl.log');
        const walGLog = await readPgDataFile(pgDataParent, 'walg.log');

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('[upgrade] ------ starting PostgreSQL 17 for pre-upgrade backup ------');
        expect(result.stderr).toContain('[upgrade] ------ pushing pre-upgrade backup ------');
        expect(result.stderr).toContain('[upgrade] upgrade execution is not implemented yet');
        expect(pgCtlLog).toContain("-p 5433 -c listen_addresses='localhost'");
        expect(pgCtlLog).toContain('-m fast -w stop');
        expect(walGLog).toContain('wal-g:backup-push /var/lib/postgresql/18/docker:PGHOST=localhost:PGPORT=5433');
      } finally {
        await rm(fakeBin, { recursive: true, force: true });
      }
    });
  });

  test('refuses restore over existing PGDATA without overwrite gate', async () => {
    await withPgData(async ({ pgDataParent }) => {
      await setupPgData(
        pgDataParent,
        'mkdir -p /var/lib/postgresql/18/docker && printf "18\\n" > /var/lib/postgresql/18/docker/PG_VERSION && chmod -R 0777 /var/lib/postgresql'
      );

      const result = await runImage(
        {
          POSTGRES_PASSWORD: 'test',
          PG_RESTORE: 'true',
          PG_RESTORE_REQUEST_ID: 'existing-data'
        },
        {
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('[restore] PGDATA exists; set PG_RESTORE_OVERWRITE=true to restore over existing data');
    });
  });

  test('failed restore fetch leaves existing PGDATA untouched', async () => {
    await withPgData(async ({ pgDataParent }) => {
      const fakeBin = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-bin-'));
      const fakeWalG = path.join(fakeBin, 'wal-g');
      await writeFile(fakeWalG, '#!/usr/bin/env bash\nprintf "fake wal-g failure\\n" >&2\nexit 37\n', 'utf8');
      await chmod(fakeWalG, 0o755);

      try {
        await setupPgData(
          pgDataParent,
          [
            'mkdir -p /var/lib/postgresql/18/docker',
            'printf "18\\n" > /var/lib/postgresql/18/docker/PG_VERSION',
            'printf "original\\n" > /var/lib/postgresql/18/docker/sentinel',
            'chmod -R 0777 /var/lib/postgresql'
          ].join(' && ')
        );

        const result = await runImage(
          {
            POSTGRES_PASSWORD: 'test',
            PATH: '/tmp/bin:/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            WALG_S3_PREFIX: 's3://pg-phoenix-missing/target',
            PG_RESTORE_FROM: 's3://pg-phoenix-missing/source/18',
            PG_RESTORE_REQUEST_ID: 'failed-fetch',
            PG_RESTORE_OVERWRITE: 'true'
          },
          {
            bindMounts: [
              { source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' },
              { source: fakeBin, target: '/tmp/bin', mode: 'ro' }
            ]
          }
        );

        const sentinel = await readPgDataFile(pgDataParent, '18/docker/sentinel');

        expect(result.code, result.stderr).toBe(37);
        expect(result.stderr).toContain('[restore] ------ fetching backup ------');
        expect(result.stderr).toContain('fake wal-g failure');
        expect(sentinel).toBe('original\n');
      } finally {
        await rm(fakeBin, { recursive: true, force: true });
      }
    });
  });

  test('rollback swaps pre-restore data back into PGDATA', async () => {
    await withPgData(async ({ pgDataParent }) => {
      await setupPgData(
        pgDataParent,
        [
          'mkdir -p /var/lib/postgresql/18/docker /var/lib/postgresql/18/pre-restore',
          'printf "18\\n" > /var/lib/postgresql/18/docker/PG_VERSION',
          'printf "current\\n" > /var/lib/postgresql/18/docker/sentinel',
          'printf "18\\n" > /var/lib/postgresql/18/pre-restore/PG_VERSION',
          'printf "previous\\n" > /var/lib/postgresql/18/pre-restore/sentinel',
          'chmod -R 0777 /var/lib/postgresql'
        ].join(' && ')
      );

      const result = await runImage(
        {
          RESTORE_ROLLBACK: 'true',
          RESTORE_REQUEST_ID: 'rollback-e2e'
        },
        {
          entrypoint: '/bin/bash',
          command: ['-lc', '/usr/local/bin/restore.sh'],
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('[restore] pre-restore data restored');

      const active = await readPgDataFile(pgDataParent, '18/docker/sentinel');
      const failed = await readPgDataFile(pgDataParent, '18/failed-restore/sentinel');
      const marker = await readPgDataFile(pgDataParent, '18/restore-state/rollback-e2e.rollback-completed');

      expect(active).toBe('previous\n');
      expect(failed).toBe('current\n');
      expect(marker).toContain('T');
    });
  });

  test('completed rollback request id skips safely', async () => {
    await withPgData(async ({ pgDataParent }) => {
      await setupPgData(
        pgDataParent,
        [
          'mkdir -p /var/lib/postgresql/18/docker /var/lib/postgresql/18/restore-state',
          'printf "18\\n" > /var/lib/postgresql/18/docker/PG_VERSION',
          'printf "current\\n" > /var/lib/postgresql/18/docker/sentinel',
          'printf "done\\n" > /var/lib/postgresql/18/restore-state/rollback-e2e.rollback-completed',
          'chmod -R 0777 /var/lib/postgresql'
        ].join(' && ')
      );

      const result = await runImage(
        {
          RESTORE_ROLLBACK: 'true',
          RESTORE_REQUEST_ID: 'rollback-e2e'
        },
        {
          entrypoint: '/bin/bash',
          command: ['-lc', '/usr/local/bin/restore.sh'],
          bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }]
        }
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('[restore] restore rollback request already completed; skipping');

      const active = await readPgDataFile(pgDataParent, '18/docker/sentinel');

      expect(active).toBe('current\n');
    });
  });
});

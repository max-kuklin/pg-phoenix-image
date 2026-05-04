import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { IMAGE_NAME } from './helpers/containers.js';

const execFileAsync = promisify(execFile);

async function runImage(env = {}, options = {}) {
  const name = `pg-phoenix-startup-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const args = ['run', '--rm', '--name', name];

  for (const [key, value] of Object.entries(env)) {
    args.push('--env', `${key}=${value}`);
  }

  for (const bindMount of options.bindMounts ?? []) {
    args.push('--volume', `${bindMount.source}:${bindMount.target}:${bindMount.mode ?? 'rw'}`);
  }

  args.push(IMAGE_NAME, 'postgres');

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

async function withPgData(callback) {
  const pgDataParent = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-startup-'));

  try {
    await chmod(pgDataParent, 0o777);
    return await callback({ pgDataParent });
  } finally {
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

  test('refuses restore over existing PGDATA without overwrite gate', async () => {
    await withPgData(async ({ pgDataParent }) => {
      const setup = await execFileAsync('docker', [
        'run',
        '--rm',
        '--volume',
        `${pgDataParent}:/var/lib/postgresql:rw`,
        IMAGE_NAME,
        'bash',
        '-lc',
        'mkdir -p /var/lib/postgresql/18/docker && printf "18\\n" > /var/lib/postgresql/18/docker/PG_VERSION && chmod -R 0777 /var/lib/postgresql'
      ]);
      expect(setup.stderr).toBe('');

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
});

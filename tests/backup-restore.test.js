import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Wait } from 'testcontainers';
import { minioPgEnv, startMinio, startPg, startPgWithMinio } from './helpers/containers.js';

async function containerLogs(container) {
  const stream = await container.logs({ tail: 200 });
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk).toString('utf8'));
  }

  return chunks.join('');
}

async function waitForQuery(pgContainer, sql, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await pgContainer.query(sql);
    } catch (error) {
      lastError = error;
      await delay(1000);
    }
  }

  const logs = await containerLogs(pgContainer.container);
  throw new Error(`PostgreSQL did not become queryable: ${lastError?.message ?? 'unknown'}\n${logs}`);
}

describe('backup with MinIO', () => {
  let topology;

  beforeAll(async () => {
    topology = await startPgWithMinio();
  });

  afterAll(async () => {
    await topology?.stop();
  });

  test('configures WAL-G archiving and scheduled backups on startup', async () => {
    const archiveCommand = await topology.pg.query('SHOW archive_command');
    const archiveTimeout = await topology.pg.query('SHOW archive_timeout');
    const envFile = await topology.pg.exec(['bash', '-lc', 'test -f /etc/walg-env.sh && stat -c "%a" /etc/walg-env.sh']);
    const cronFile = await topology.pg.exec(['bash', '-lc', 'cat /etc/cron.d/pg-backup']);

    expect(archiveCommand.rows[0].archive_command).toBe('. /etc/walg-env.sh && wal-g wal-push %p');
    expect(archiveTimeout.rows[0].archive_timeout).toBe('1min');
    expect(envFile.exitCode).toBe(0);
    expect(envFile.stdout.trim()).toBe('600');
    expect(cronFile.exitCode).toBe(0);
    expect(cronFile.stdout).toContain('0 0 * * * postgres /usr/local/bin/backup.sh');
  });

  test('backup.sh creates a base backup visible to WAL-G', async () => {
    await topology.pg.query('CREATE TABLE phase3_backup_check (id int PRIMARY KEY, value text)');
    await topology.pg.query("INSERT INTO phase3_backup_check VALUES (1, 'before backup')");

    const backup = await topology.pg.exec(['backup.sh'], { user: 'postgres' });
    const list = await topology.pg.exec(['bash', '-lc', '. /etc/walg-env.sh && wal-g backup-list']);

    expect(backup.exitCode).toBe(0);
    expect(backup.stderr).toContain('[backup] base backup completed');
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('base_');
  });
});

describe('startup restore with MinIO', () => {
  let topology;
  let source;
  let target;
  let pgDataDir;

  beforeAll(async () => {
    topology = await startMinio();
    source = await startPg({
      network: topology.network,
      networkAliases: ['restore-source'],
      env: minioPgEnv('s3://pg-phoenix-test/restore-source')
    });

    await source.query('CREATE TABLE restore_e2e_check (id int PRIMARY KEY, value text)');
    await source.query("INSERT INTO restore_e2e_check VALUES (1, 'from backup')");

    const backup = await source.exec(['backup.sh'], { user: 'postgres' });
    expect(backup.exitCode).toBe(0);

    pgDataDir = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-restore-'));
  });

  afterAll(async () => {
    await target?.stop();
    await source?.stop();
    await topology?.stop();
    if (pgDataDir) {
      await rm(pgDataDir, { recursive: true, force: true });
    }
  });

  test('restores into empty PGDATA and skips the completed request on restart', async () => {
    const bindMounts = [{ source: pgDataDir, target: '/var/lib/postgresql', mode: 'rw' }];
    const restoreEnv = {
      ...minioPgEnv('s3://pg-phoenix-test/restore-target'),
      PG_RESTORE_FROM: 's3://pg-phoenix-test/restore-source/18',
      PG_RESTORE_REQUEST_ID: 'restore-e2e-latest'
    };

    target = await startPg({
      network: topology.network,
      networkAliases: ['restore-target'],
      bindMounts,
      waitStrategy: Wait.forLogMessage(/restore prepared for PostgreSQL startup/),
      env: restoreEnv
    });

    const restored = await waitForQuery(target, 'SELECT value FROM restore_e2e_check WHERE id = 1');
    const marker = await target.exec(['bash', '-lc', 'test -f /var/lib/postgresql/18/restore-state/restore-e2e-latest.completed']);

    expect(restored.rows[0].value).toBe('from backup');
    expect(marker.exitCode).toBe(0);

    await target.stop();
    target = await startPg({
      network: topology.network,
      networkAliases: ['restore-target-restart'],
      bindMounts,
      waitStrategy: Wait.forLogMessage(/restore request already completed; skipping/),
      env: restoreEnv
    });

    const afterRestart = await waitForQuery(target, 'SELECT value FROM restore_e2e_check WHERE id = 1');
    expect(afterRestart.rows[0].value).toBe('from backup');
  });
});

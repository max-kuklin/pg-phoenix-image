import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GenericContainer, Wait } from 'testcontainers';
import {
  IMAGE_NAME,
  OBJECT_STORAGE_BUCKET,
  listObjectStorageObjects,
  objectStoragePgEnv,
  startObjectStorage,
  startPg,
  startPgWithObjectStorage
} from './helpers/containers.js';

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
      await delay(250);
    }
  }

  const logs = await containerLogs(pgContainer.container);
  throw new Error(`PostgreSQL did not become queryable: ${lastError?.message ?? 'unknown'}\n${logs}`);
}

async function waitForObjectStorageObject(topology, prefix, pattern, timeoutMs = 30_000) {
  const startedAt = Date.now();
  let listing = '';

  while (Date.now() - startedAt < timeoutMs) {
    listing = await listObjectStorageObjects(topology.network, prefix);

    if (pattern.test(listing)) {
      return listing;
    }

    await delay(250);
  }

  throw new Error(`Object storage entry matching ${pattern} was not found under ${prefix}\n${listing}`);
}

async function makeMountedPgDataRemovable(pgDataParent) {
  if (!pgDataParent) {
    return;
  }

  const container = await new GenericContainer(IMAGE_NAME)
    .withBindMounts([{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }])
    .withEntrypoint(['bash'])
    .withCommand(['-lc', 'chmod -R 0777 /var/lib/postgresql'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();

  await container.stop({ remove: true, removeVolumes: true });
}

describe('backup with S3-compatible object storage', () => {
  let topology;

  beforeAll(async () => {
    topology = await startPgWithObjectStorage({
      env: {
        BACKUP_RETAIN_FULL: '1'
      }
    });
  });

  afterAll(async () => {
    await topology?.stop();
  });

  test('configures WAL-G archiving and scheduled backups on startup', async () => {
    const archiveCommand = await topology.pg.query('SHOW archive_command');
    const archiveTimeout = await topology.pg.query('SHOW archive_timeout');
    const envFile = await topology.pg.exec(['bash', '-lc', 'test -f /etc/walg-env.sh && stat -c "%a" /etc/walg-env.sh']);
    const envContent = await topology.pg.exec(['bash', '-lc', '. /etc/walg-env.sh && printf "%s" "$WALG_S3_PREFIX"']);
    const cronFile = await topology.pg.exec(['bash', '-lc', 'cat /etc/cron.d/pg-backup']);

    expect(archiveCommand.rows[0].archive_command).toBe('. /etc/walg-env.sh && wal-g wal-push %p');
    expect(archiveTimeout.rows[0].archive_timeout).toBe('1min');
    expect(envFile.exitCode).toBe(0);
    expect(envFile.stdout.trim()).toBe('600');
    expect(envContent.exitCode).toBe(0);
    expect(envContent.stdout).toBe('s3://pg-phoenix-test/pg/18');
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

  test('stores base backup objects under the version-scoped prefix', async () => {
    const listing = await waitForObjectStorageObject(topology, 'pg/18', /basebackups_/);

    expect(listing).toContain(`s3://${OBJECT_STORAGE_BUCKET}/pg/18/`);
    expect(listing).toContain('basebackups_');
  });

  test('archives WAL under the version-scoped prefix after segment switch', async () => {
    await topology.pg.query('CREATE TABLE phase3_wal_check (id int PRIMARY KEY)');
    await topology.pg.query('INSERT INTO phase3_wal_check VALUES (1)');
    await topology.pg.query('SELECT pg_switch_wal()');

    const listing = await waitForObjectStorageObject(topology, 'pg/18', /wal_/);

    expect(listing).toContain(`s3://${OBJECT_STORAGE_BUCKET}/pg/18/`);
    expect(listing).toContain('wal_');
  });

  test('does not write backup objects to the flat unversioned prefix', async () => {
    const listing = await listObjectStorageObjects(topology.network, 'pg');
    const objectLines = listing
      .split('\n')
      .filter((line) => line.includes('basebackups_') || line.includes('wal_'));

    expect(objectLines.length).toBeGreaterThan(0);
    expect(objectLines.every((line) => line.includes(`s3://${OBJECT_STORAGE_BUCKET}/pg/18/`))).toBe(true);
  });

  test('retains only the configured number of full backups', async () => {
    const backup = await topology.pg.exec(['backup.sh'], { user: 'postgres' });
    const list = await topology.pg.exec(['bash', '-lc', '. /etc/walg-env.sh && wal-g backup-list']);
    const backups = list.stdout
      .split('\n')
      .filter((line) => line.startsWith('base_'));

    expect(backup.exitCode).toBe(0);
    expect(backup.stderr).toContain('[backup] applying retention policy: keep 1 full backups');
    expect(list.exitCode).toBe(0);
    expect(backups).toHaveLength(1);
  });
});

describe('backup without WAL-G configuration', () => {
  let pg;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  test('backup.sh skips cleanly when no WAL-G env file exists', async () => {
    const backup = await pg.exec(['backup.sh'], { user: 'postgres' });

    expect(backup.exitCode).toBe(0);
    expect(backup.stdout).toBe('');
    expect(backup.stderr).toContain('[backup] WAL-G env file not found; skipping backup');
  });
});

describe('startup restore with S3-compatible object storage', () => {
  let topology;
  let source;
  let target;
  let pgDataDir;
  let pitrTargetTime;

  beforeAll(async () => {
    topology = await startObjectStorage();
    source = await startPg({
      network: topology.network,
      networkAliases: ['restore-source'],
      env: objectStoragePgEnv('s3://pg-phoenix-test/restore-source')
    });

    await source.query('CREATE TABLE restore_e2e_check (id int PRIMARY KEY, value text)');
    await source.query("INSERT INTO restore_e2e_check VALUES (1, 'from backup')");

    await source.query('CREATE TABLE restore_pitr_check (id int PRIMARY KEY, value text)');
    await source.query("INSERT INTO restore_pitr_check VALUES (1, 'before target')");

    const backup = await source.exec(['backup.sh'], { user: 'postgres' });
    expect(backup.exitCode).toBe(0);

    const targetTime = await source.query("SELECT to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS.US TZ') AS value");
    pitrTargetTime = targetTime.rows[0].value;
    await delay(1000);
    await source.query("INSERT INTO restore_pitr_check VALUES (2, 'after target')");
    const switchWal = await source.query('SELECT pg_switch_wal()');
    expect(switchWal.rows).toHaveLength(1);

    pgDataDir = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-restore-'));
    await chmod(pgDataDir, 0o777);
  });

  afterAll(async () => {
    await target?.stop();
    await makeMountedPgDataRemovable(pgDataDir);
    await source?.stop();
    await topology?.stop();
    if (pgDataDir) {
      await rm(pgDataDir, { recursive: true, force: true });
    }
  });

  test('restores into empty PGDATA and skips the completed request on restart', async () => {
    const bindMounts = [{ source: pgDataDir, target: '/var/lib/postgresql', mode: 'rw' }];
    const restoreEnv = {
      ...objectStoragePgEnv('s3://pg-phoenix-test/restore-target'),
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

  test('restores to a point in time before later source writes', async () => {
    const pitrDataDir = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-pitr-'));
    let pitrTarget;
    await chmod(pitrDataDir, 0o777);

    try {
      pitrTarget = await startPg({
        network: topology.network,
        networkAliases: ['restore-pitr-target'],
        bindMounts: [{ source: pitrDataDir, target: '/var/lib/postgresql', mode: 'rw' }],
        waitStrategy: Wait.forLogMessage(/restore prepared for PostgreSQL startup/),
        env: {
          ...objectStoragePgEnv('s3://pg-phoenix-test/restore-pitr-target'),
          PG_RESTORE_FROM: 's3://pg-phoenix-test/restore-source/18',
          PG_RESTORE_TARGET_TIME: pitrTargetTime,
          PG_RESTORE_REQUEST_ID: 'restore-e2e-pitr'
        }
      });

      const restored = await waitForQuery(pitrTarget, 'SELECT id, value FROM restore_pitr_check ORDER BY id');

      expect(restored.rows).toEqual([{ id: 1, value: 'before target' }]);
    } finally {
      await pitrTarget?.stop();
      await makeMountedPgDataRemovable(pitrDataDir);
      await rm(pitrDataDir, { recursive: true, force: true });
    }
  });
});

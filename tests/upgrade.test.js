import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Wait } from 'testcontainers';
import { setTimeout as delay } from 'node:timers/promises';
import {
  IMAGE_NAME,
  listObjectStorageObjects,
  objectStoragePgEnv,
  queryPg,
  startObjectStorage,
  startPg
} from './helpers/containers.js';

const execFileAsync = promisify(execFile);
const OLD_MAJOR = process.env.PG_TEST_OLD ?? '17';
const NEW_MAJOR = process.env.PG_TEST_NEW ?? '18';
const OLD_IMAGE = process.env.PG_PHOENIX_OLD_IMAGE ?? `pg-phoenix-image:upgrade-${OLD_MAJOR}`;
const NEW_IMAGE = process.env.PG_PHOENIX_NEW_IMAGE ?? IMAGE_NAME;
const UPGRADE_PGDATA = `/var/lib/postgresql/${NEW_MAJOR}/docker`;

async function buildOldImage() {
  if (process.env.PG_PHOENIX_OLD_IMAGE) {
    return;
  }

  await execFileAsync('docker', [
    'build',
    '--build-arg',
    `PG_BASE=postgres:${OLD_MAJOR}`,
    '-t',
    OLD_IMAGE,
    '.'
  ], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: 10 * 60_000
  });
}

async function makeMountedPgDataRemovable(pgDataParent) {
  if (!pgDataParent) {
    return;
  }

  const helper = await startPg({
    bindMounts: [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }],
    env: { POSTGRES_PASSWORD: 'test' },
    waitStrategy: Wait.forOneShotStartup(),
    // Avoid entrypoint startup against whatever PGDATA version the test left behind.
    entrypoint: ['bash'],
    command: ['-lc', 'chmod -R 0777 /var/lib/postgresql || true']
  });

  await helper.stop();
}

async function waitForQuery(connection, sql, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await queryPg(connection, sql);
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }

  throw lastError;
}

describe('major upgrade', () => {
  let topology;
  let pgDataParent;

  beforeAll(async () => {
    await buildOldImage();
    topology = await startObjectStorage();
    pgDataParent = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-upgrade-'));
    await chmod(pgDataParent, 0o777);
  }, 12 * 60_000);

  afterAll(async () => {
    await makeMountedPgDataRemovable(pgDataParent).catch(() => {});
    await topology?.stop();
    if (pgDataParent) {
      await rm(pgDataParent, { recursive: true, force: true });
    }
  });

  test('upgrades PGDATA with data intact and switches backup prefix', async () => {
    const bindMounts = [{ source: pgDataParent, target: '/var/lib/postgresql', mode: 'rw' }];
    const upgradeContainerName = `pg-phoenix-upgrade-${Date.now()}`;
    const sourceEnv = {
      ...objectStoragePgEnv('s3://pg-phoenix-test/upgrade'),
      PGDATA: UPGRADE_PGDATA
    };
    const source = await startPg({
      network: topology.network,
      networkAliases: ['upgrade-source'],
      bindMounts,
      env: sourceEnv,
      waitStrategy: Wait.forLogMessage(/PostgreSQL init process complete|database system is ready to accept connections/),
      imageName: OLD_IMAGE,
      startupTimeoutMs: 180_000
    });

    await waitForQuery(source.connection, 'CREATE TABLE upgrade_check (id int PRIMARY KEY, value text)');
    await waitForQuery(source.connection, "INSERT INTO upgrade_check VALUES (1, 'before upgrade')");
    const backup = await source.exec(['backup.sh'], { user: 'postgres' });
    expect(backup.exitCode).toBe(0);
    await source.stop();

    let upgraded;

    try {
      upgraded = await startPg({
        network: topology.network,
        networkAliases: ['upgrade-target'],
        bindMounts,
        env: {
          ...objectStoragePgEnv('s3://pg-phoenix-test/upgrade'),
          PGDATA: UPGRADE_PGDATA,
          PG_UPGRADE: 'true',
          PG_UPGRADE_BACKUP_MAX_AGE: '0'
        },
        waitStrategy: Wait.forLogMessage(/major upgrade completed/),
        imageName: NEW_IMAGE,
        containerName: upgradeContainerName,
        autoRemove: false,
        startupTimeoutMs: 240_000
      });
    } catch (error) {
      const logs = await execFileAsync('docker', ['logs', upgradeContainerName], {
        maxBuffer: 1024 * 1024
      }).catch((logsError) => ({ stdout: '', stderr: logsError.message }));
      await execFileAsync('docker', ['rm', '-f', upgradeContainerName]).catch(() => {});
      throw new Error(`${error.message}\n${logs.stdout}${logs.stderr}`);
    }

    try {
      const data = await waitForQuery(upgraded.connection, 'SELECT value FROM upgrade_check WHERE id = 1');
      const version = await waitForQuery(upgraded.connection, 'SHOW server_version_num');
      const oldStash = await upgraded.exec(['bash', '-lc', `test ! -e /var/lib/postgresql/.pg-binaries/${OLD_MAJOR}`]);
      const newStash = await upgraded.exec(['bash', '-lc', `test -x /var/lib/postgresql/.pg-binaries/${NEW_MAJOR}/bin/pg_upgrade`]);
      const logs = await execFileAsync('docker', ['logs', upgradeContainerName], {
        maxBuffer: 1024 * 1024
      });
      const listing = await listObjectStorageObjects(topology.network, 'upgrade');

      expect(data.rows[0].value).toBe('before upgrade');
      expect(version.rows[0].server_version_num.startsWith(NEW_MAJOR)).toBe(true);
      expect(`${logs.stdout}${logs.stderr}`).toContain('[upgrade] ------ running post-upgrade analyze ------');
      expect(oldStash.exitCode).toBe(0);
      expect(newStash.exitCode).toBe(0);
      expect(listing).toContain(`/upgrade/${OLD_MAJOR}/`);
      expect(listing).toContain(`/upgrade/${NEW_MAJOR}/`);

      await upgraded.stop();
      upgraded = await startPg({
        network: topology.network,
        networkAliases: ['upgrade-target-restart'],
        bindMounts,
        env: {
          ...objectStoragePgEnv('s3://pg-phoenix-test/upgrade'),
          PGDATA: UPGRADE_PGDATA,
          PG_UPGRADE: 'true'
        },
        waitStrategy: Wait.forHealthCheck(),
        imageName: NEW_IMAGE,
        startupTimeoutMs: 180_000
      });

      const afterRestart = await waitForQuery(upgraded.connection, 'SELECT value FROM upgrade_check WHERE id = 1');
      const restartVersion = await waitForQuery(upgraded.connection, 'SHOW server_version_num');

      expect(afterRestart.rows[0].value).toBe('before upgrade');
      expect(restartVersion.rows[0].server_version_num.startsWith(NEW_MAJOR)).toBe(true);
    } finally {
      await upgraded?.stop();
      await execFileAsync('docker', ['rm', '-f', upgradeContainerName]).catch(() => {});
    }
  }, 10 * 60_000);
});

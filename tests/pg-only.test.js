import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPg } from './helpers/containers.js';

describe('pg-only image smoke', () => {
  let pgContainer;

  beforeAll(async () => {
    pgContainer = await startPg();
  });

  afterAll(async () => {
    await pgContainer?.stop();
  });

  test('starts PostgreSQL and accepts TCP password connections', async () => {
    const result = await pgContainer.query('SELECT 1 AS value');

    expect(result.rows).toEqual([{ value: 1 }]);
  });

  test('uses the shipped config file', async () => {
    const result = await pgContainer.query('SHOW config_file');

    expect(result.rows[0].config_file).toBe('/etc/postgresql/postgresql.conf');
  });

  test('bundles WAL-G and cron', async () => {
    const walg = await pgContainer.exec(['wal-g', '--version']);
    const cron = await pgContainer.exec(['bash', '-lc', 'command -v cron']);

    expect(walg.exitCode).toBe(0);
    expect(walg.stdout).toContain('wal-g version v3.0.3');
    expect(cron.exitCode).toBe(0);
    expect(cron.stdout.trim()).toBe('/usr/sbin/cron');
  });

  test('loads pg_stat_statements', async () => {
    const extension = await pgContainer.query(`
      SELECT extname
      FROM pg_extension
      WHERE extname = 'pg_stat_statements'
    `);
    const setting = await pgContainer.query('SHOW shared_preload_libraries');
    const call = await pgContainer.query('SELECT count(*)::int AS count FROM pg_stat_statements');

    expect(extension.rows).toEqual([{ extname: 'pg_stat_statements' }]);
    expect(setting.rows[0].shared_preload_libraries).toContain('pg_stat_statements');
    expect(call.rows[0].count).toBeGreaterThan(0);
  });
});

describe('pg-only conf.d override', () => {
  let pgContainer;
  let tempDir;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-conf-'));
    const overridePath = path.join(tempDir, 'override.conf');
    await writeFile(overridePath, "work_mem = '128MB'\n", 'utf8');

    pgContainer = await startPg({
      bindMounts: [
        {
          source: overridePath,
          target: '/etc/postgresql/conf.d/override.conf',
          mode: 'ro'
        }
      ]
    });
  });

  afterAll(async () => {
    await pgContainer?.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test('loads mounted config overrides', async () => {
    const result = await pgContainer.query('SHOW work_mem');

    expect(result.rows[0].work_mem).toBe('128MB');
  });
});

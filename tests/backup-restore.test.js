import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startPgWithMinio } from './helpers/containers.js';

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

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

const scriptEnv = [
  'export LOGGER_PATH=/workspace/image/lib/logger.sh',
  'export WALG_LIB_PATH=/workspace/image/lib/walg.sh',
  'export RESTORE_ARGS_LIB_PATH=/workspace/image/lib/restore-args.sh',
  'export WALG_ENV_FILE=/tmp/walg-env.sh',
  'export PGDATA=/tmp/pg/18/docker',
  'export PATH=/tmp/bin:$PATH',
  'mkdir -p /tmp/bin',
  'printf "export WALG_S3_PREFIX=%q\\n" "s3://bucket/db/18" > "$WALG_ENV_FILE"',
  'printf "%s\\n" "#!/usr/bin/env bash" "set -euo pipefail" "if [[ \\"\\$1\\" == \\"backup-fetch\\" ]]; then" "  mkdir -p \\"\\$2\\"" "  printf \\"18\\\\n\\" > \\"\\$2/PG_VERSION\\"" "  : > \\"\\$2/postgresql.auto.conf\\"" "  exit 0" "fi" "exit 2" > /tmp/bin/wal-g',
  'chmod +x /tmp/bin/wal-g'
];

describe('restore script contracts', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('refuses to restore over existing PGDATA without overwrite gate', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'mkdir -p "$PGDATA"',
        'printf "18\\n" > "$PGDATA/PG_VERSION"',
        'RESTORE_REQUEST_ID=test-request bash /workspace/image/restore.sh'
      ].join('; ')
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('set PG_RESTORE_OVERWRITE=true');
  });

  test('requires request id for explicit restore', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'bash /workspace/image/restore.sh'
      ].join('; ')
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PG_RESTORE_REQUEST_ID is required');
  });

  test('stages restore before moving existing PGDATA aside', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'mkdir -p "$PGDATA"',
        'printf "18\\n" > "$PGDATA/PG_VERSION"',
        'printf "old\\n" > "$PGDATA/sentinel"',
        'RESTORE_REQUEST_ID=test-request RESTORE_OVERWRITE=true bash /workspace/image/restore.sh --target-time "2026-02-13 14:30:00 UTC"',
        'test -f /tmp/pg/18/pre-restore/sentinel',
        'test -f "$PGDATA/recovery.signal"',
        'test -f /tmp/pg/18/restore-state/test-request.completed',
        'grep -q "recovery_target_time" "$PGDATA/postgresql.auto.conf"'
      ].join('; ')
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[restore] restore prepared for PostgreSQL startup');
  });

  test('writes source prefix into restore command for cross-instance restore', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'RESTORE_REQUEST_ID=cross-instance bash /workspace/image/restore.sh --from s3://bucket/source/18',
        'grep -q "WALG_S3_PREFIX=" "$PGDATA/postgresql.auto.conf"',
        'grep -q "s3://bucket/source/18" "$PGDATA/postgresql.auto.conf"'
      ].join('; ')
    );

    expect(result.code).toBe(0);
  });

  test('skips completed restore request id', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'mkdir -p "$PGDATA" /tmp/pg/18/restore-state',
        'printf "18\\n" > "$PGDATA/PG_VERSION"',
        'printf "done\\n" > /tmp/pg/18/restore-state/test-request.completed',
        'RESTORE_REQUEST_ID=test-request RESTORE_OVERWRITE=true bash /workspace/image/restore.sh'
      ].join('; ')
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[restore] restore request already completed; skipping');
  });

  test('rollback restores pre-restore data and keeps failed restore for inspection', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'mkdir -p "$PGDATA" /tmp/pg/18/pre-restore',
        'printf "current\\n" > "$PGDATA/sentinel"',
        'printf "previous\\n" > /tmp/pg/18/pre-restore/sentinel',
        'RESTORE_REQUEST_ID=rollback-request RESTORE_ROLLBACK=true bash /workspace/image/restore.sh',
        'grep -q previous "$PGDATA/sentinel"',
        'grep -q current /tmp/pg/18/failed-restore/sentinel',
        'test -f /tmp/pg/18/restore-state/rollback-request.rollback-completed'
      ].join('; ')
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[restore] pre-restore data restored');
  });

  test('skips completed rollback request id', async () => {
    const result = await bash.run(
      [
        ...scriptEnv,
        'mkdir -p "$PGDATA" /tmp/pg/18/restore-state',
        'printf "18\\n" > "$PGDATA/PG_VERSION"',
        'printf "done\\n" > /tmp/pg/18/restore-state/rollback-request.rollback-completed',
        'RESTORE_REQUEST_ID=rollback-request RESTORE_ROLLBACK=true bash /workspace/image/restore.sh'
      ].join('; ')
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('[restore] restore rollback request already completed; skipping');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

describe('WAL-G shell contracts', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('quotes values for POSIX env files', async () => {
    const result = await bash.run(
      String.raw`. ./image/lib/walg.sh; walg_write_export_line AWS_SECRET_ACCESS_KEY "a'b c"`
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`export AWS_SECRET_ACCESS_KEY='a'"'"'b c'\n`);
    expect(result.stderr).toBe('');
  });

  test('rejects newline values for env files', async () => {
    const result = await bash.run(
      String.raw`. ./image/lib/walg.sh; walg_write_export_line AWS_SECRET_ACCESS_KEY $'bad\nvalue'`
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
  });

  test('selects the first active storage prefix in supported order', async () => {
    const result = await bash.run(
      '. ./image/lib/walg.sh; WALG_GS_PREFIX=gs://bucket/db WALG_S3_PREFIX=s3://bucket/db walg_active_prefix_name'
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('WALG_S3_PREFIX\n');
  });

  test('appends PostgreSQL major version after stripping trailing slash', async () => {
    const result = await bash.run(
      '. ./image/lib/walg.sh; walg_append_major s3://bucket/db/ 18'
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('s3://bucket/db/18\n');
  });

  test.each([
    ['s3://bucket/db/18', 0],
    ['s3://bucket/db/18/', 0],
    ['s3://bucket/db18', 1]
  ])('validates version-scoped prefix %s', async (prefix, expectedCode) => {
    const result = await bash.run(
      `. ./image/lib/walg.sh; walg_validate_version_prefix ${prefix}`
    );

    expect(result.code).toBe(expectedCode);
  });
});

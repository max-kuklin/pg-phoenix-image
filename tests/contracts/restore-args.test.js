import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createBashRunner } from '../helpers/shell.js';

describe('restore argument contracts', () => {
  let bash;

  beforeAll(async () => {
    bash = await createBashRunner();
  });

  afterAll(async () => {
    await bash?.stop();
  });

  test('parses bootstrap restore with source and target time', async () => {
    const result = await bash.run(
      [
        '. ./image/lib/walg.sh',
        '. ./image/lib/restore-args.sh',
        'restore_parse_args --bootstrap --from s3://bucket/source/18/ --target-time "2026-02-13 12:00:00 UTC"',
        'printf "%s\\n%s\\n%s\\n" "$restore_bootstrap" "$restore_from" "$restore_target_time"'
      ].join('; ')
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('true\ns3://bucket/source/18\n2026-02-13 12:00:00 UTC\n');
  });

  test('rejects --from values without a version segment', async () => {
    const result = await bash.run(
      '. ./image/lib/walg.sh; . ./image/lib/restore-args.sh; restore_parse_args --from s3://bucket/source18'
    );

    expect(result.code).toBe(3);
  });

  test('rejects unknown arguments', async () => {
    const result = await bash.run(
      '. ./image/lib/walg.sh; . ./image/lib/restore-args.sh; restore_parse_args --bad'
    );

    expect(result.code).toBe(2);
  });
});

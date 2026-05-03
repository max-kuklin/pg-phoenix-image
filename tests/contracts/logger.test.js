import { describe, expect, test } from 'vitest';
import { runBash } from '../helpers/shell.js';

describe('logger contract', () => {
  test('writes INFO logs to stderr with UTC timestamp and component', async () => {
    const result = await runBash(
      "LOG_COMPONENT=contract; . ./scripts/lib/logger.sh; log_info 'hello world'"
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC INFO  \[contract\] hello world\n$/);
  });

  test('filters DEBUG logs at the default INFO level', async () => {
    const result = await runBash(
      "LOG_COMPONENT=contract; . ./scripts/lib/logger.sh; log_debug 'hidden'"
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('prints DEBUG logs when LOG_LEVEL=DEBUG', async () => {
    const result = await runBash(
      "LOG_COMPONENT=contract; . ./scripts/lib/logger.sh; log_debug 'visible'",
      { env: { LOG_LEVEL: 'DEBUG' } }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/ DEBUG \[contract\] visible\n$/);
  });

  test('log_fatal writes ERROR and exits with code 1', async () => {
    const result = await runBash(
      "LOG_COMPONENT=contract; . ./scripts/lib/logger.sh; log_fatal 'stop now'"
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/ ERROR \[contract\] stop now\n$/);
  });
});


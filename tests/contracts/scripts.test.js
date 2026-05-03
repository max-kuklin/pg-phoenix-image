import { describe, expect, test } from 'vitest';
import { runBash } from '../helpers/shell.js';

describe('script stubs contract', () => {
  test.each([
    ['backup', './scripts/backup.sh'],
    ['restore', './scripts/restore.sh'],
    ['upgrade', './scripts/upgrade.sh']
  ])('%s stub sources logger and exits cleanly', async (component, script) => {
    const result = await runBash(`LOGGER_PATH=./scripts/lib/logger.sh bash ${script}`);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(new RegExp(` INFO  \\[${component}\\] ${component} script is not implemented yet\\n$`));
  });
});


import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const linuxImage = process.env.BASH_TEST_IMAGE || 'debian:bookworm-slim';

function dockerMountPath(value) {
  return value.replaceAll('\\', '/');
}

export async function withTempDir(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pg-phoenix-test-'));

  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runBash(command, options = {}) {
  const env = options.env ?? {};
  const args = [
    'run',
    '--rm',
    '--pull',
    'never',
    '--volume',
    `${dockerMountPath(repoRoot)}:/workspace:ro`,
    '--workdir',
    '/workspace'
  ];

  for (const [name, value] of Object.entries(env)) {
    args.push('--env', `${name}=${value}`);
  }

  args.push(linuxImage, 'bash', '-lc', command);

  try {
    const result = await execFileAsync('docker', args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

export async function createBashRunner() {
  const args = [
    'run',
    '-d',
    '--rm',
    '--pull',
    'never',
    '--volume',
    `${dockerMountPath(repoRoot)}:/workspace:ro`,
    '--workdir',
    '/workspace',
    linuxImage,
    'sleep',
    'infinity'
  ];

  const started = await execFileAsync('docker', args, {
    cwd: repoRoot,
    maxBuffer: 1024 * 1024
  });
  const containerId = started.stdout.trim();

  return {
    run: (command, options = {}) => runBashInContainer(containerId, command, options),
    stop: async () => {
      await execFileAsync('docker', ['rm', '-f', containerId], {
        cwd: repoRoot,
        maxBuffer: 1024 * 1024
      }).catch(() => {});
    }
  };
}

async function runBashInContainer(containerId, command, options = {}) {
  const env = options.env ?? {};
  const isolatedCommand = `rm -rf /tmp/pg /tmp/bin /tmp/walg-env.sh /tmp/etc-postgresql; ${command}`;
  const args = ['exec'];

  for (const [name, value] of Object.entries(env)) {
    args.push('--env', `${name}=${value}`);
  }

  args.push(containerId, 'bash', '-lc', isolatedCommand);

  try {
    const result = await execFileAsync('docker', args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024
    });

    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

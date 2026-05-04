import { GenericContainer, Network, Wait } from 'testcontainers';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

export const IMAGE_NAME = process.env.PG_PHOENIX_IMAGE || 'pg-phoenix-image:test';
export const POSTGRES_PASSWORD = 'test';
export const OBJECT_STORAGE_IMAGE = process.env.OBJECT_STORAGE_IMAGE || 'chrislusf/seaweedfs:4.22';
export const OBJECT_STORAGE_CLIENT_IMAGE = process.env.OBJECT_STORAGE_CLIENT_IMAGE || 'amazon/aws-cli:2.31.33';
export const OBJECT_STORAGE_ACCESS_KEY = 'testadmin';
export const OBJECT_STORAGE_SECRET_KEY = 'testsecret';
export const OBJECT_STORAGE_BUCKET = 'pg-phoenix-test';
const OBJECT_STORAGE_ENDPOINT = 'http://object-storage:8333';

export async function startPg(overrides = {}) {
  const env = {
    POSTGRES_PASSWORD,
    ...overrides.env
  };

  let builder = new GenericContainer(overrides.imageName ?? IMAGE_NAME)
    .withEnvironment(env)
    .withWaitStrategy(overrides.waitStrategy ?? Wait.forHealthCheck());

  if (overrides.containerName) {
    builder = builder.withName(overrides.containerName);
  }

  if (overrides.autoRemove !== undefined) {
    builder = builder.withAutoRemove(overrides.autoRemove);
  }

  if (overrides.startupTimeoutMs) {
    builder = builder.withStartupTimeout(overrides.startupTimeoutMs);
  }

  if (overrides.exposedPorts ?? true) {
    builder = builder.withExposedPorts(5432);
  }

  if (overrides.entrypoint) {
    builder = builder.withEntrypoint(overrides.entrypoint);
  }

  if (overrides.command) {
    builder = builder.withCommand(overrides.command);
  }

  if (overrides.bindMounts) {
    builder = builder.withBindMounts(overrides.bindMounts);
  }

  if (overrides.network) {
    builder = builder.withNetwork(overrides.network);
  }

  if (overrides.networkAliases) {
    builder = builder.withNetworkAliases(...overrides.networkAliases);
  }

  const container = await builder.start();

  const host = container.getHost();
  const port = (overrides.exposedPorts ?? true) ? container.getMappedPort(5432) : undefined;

  return {
    container,
    host,
    port,
    connection: {
      host,
      port,
      user: 'postgres',
      password: env.POSTGRES_PASSWORD,
      database: 'postgres'
    },
    query: (text, params) => queryPg({ host, port, password: env.POSTGRES_PASSWORD }, text, params),
    exec: (command, options) => container.exec(command, options),
    stop: () => container.stop()
  };
}

export async function queryPg(connection, text, params = []) {
  const client = new pg.Client({
    host: connection.host,
    port: connection.port,
    user: connection.user ?? 'postgres',
    password: connection.password ?? POSTGRES_PASSWORD,
    database: connection.database ?? 'postgres'
  });

  await client.connect();

  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

export async function startObjectStorage() {
  const network = await new Network().start();

  let objectStorage;

  try {
    objectStorage = await new GenericContainer(OBJECT_STORAGE_IMAGE)
      .withCommand(['server', '-s3', '-ip.bind=0.0.0.0'])
      .withEnvironment({
        AWS_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: OBJECT_STORAGE_SECRET_KEY
      })
      .withNetwork(network)
      .withNetworkAliases('object-storage')
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();

    await runObjectStorageAws(network, [
      's3',
      'mb',
      `s3://${OBJECT_STORAGE_BUCKET}`
    ]);

    return {
      objectStorage,
      network,
      bucket: OBJECT_STORAGE_BUCKET,
      stop: async () => {
        await objectStorage?.stop();
        await stopNetwork(network);
      }
    };
  } catch (error) {
    await objectStorage?.stop();
    await stopNetwork(network);
    throw error;
  }
}

async function stopNetwork(network) {
  let lastError;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await network.stop();
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw lastError;
}

function objectStorageClientEnv() {
  return {
    AWS_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: OBJECT_STORAGE_SECRET_KEY,
    AWS_DEFAULT_REGION: 'us-east-1',
    AWS_S3_ADDRESSING_STYLE: 'path'
  };
}

async function runObjectStorageAws(network, args) {
  let lastError;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    let container;

    try {
      container = await new GenericContainer(OBJECT_STORAGE_CLIENT_IMAGE)
        .withNetwork(network)
        .withEntrypoint(['sh'])
        .withEnvironment(objectStorageClientEnv())
        .withCommand(['-c', 'sleep 300'])
        .start();

      const result = await container.exec(['aws', '--endpoint-url', OBJECT_STORAGE_ENDPOINT, ...args]);

      if (result.exitCode === 0) {
        return `${result.stdout}${result.stderr}`;
      }

      throw new Error(`aws ${args.join(' ')} failed with exit ${result.exitCode}\n${result.stdout}${result.stderr}`);
    } catch (error) {
      lastError = error;
      await delay(500);
    } finally {
      await container?.stop().catch(() => {});
    }
  }

  throw lastError;
}

export async function listObjectStorageObjects(network, prefix) {
  const logs = await runObjectStorageAws(network, [
    's3',
    'ls',
    `s3://${OBJECT_STORAGE_BUCKET}/${prefix}`,
    '--recursive'
  ]);

  return logs
    .split('\n')
    .map((line) => line.trim().split(/\s+/).at(-1))
    .filter(Boolean)
    .map((key) => `s3://${OBJECT_STORAGE_BUCKET}/${key}`)
    .join('\n');
}

export function objectStoragePgEnv(prefix = `s3://${OBJECT_STORAGE_BUCKET}/pg`) {
  return {
    WALG_S3_PREFIX: prefix,
    AWS_ACCESS_KEY_ID: OBJECT_STORAGE_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: OBJECT_STORAGE_SECRET_KEY,
    AWS_ENDPOINT: 'http://object-storage:8333',
    AWS_REGION: 'us-east-1',
    AWS_S3_FORCE_PATH_STYLE: 'true',
    BACKUP_SCHEDULE: '0 0 * * *',
    ARCHIVE_TIMEOUT: '60'
  };
}

export async function startPgWithObjectStorage(overrides = {}) {
  const topology = await startObjectStorage();
  let pgContainer;

  try {
    pgContainer = await startPg({
      network: topology.network,
      networkAliases: ['pg'],
      bindMounts: overrides.bindMounts,
      env: {
        ...objectStoragePgEnv(),
        ...overrides.env
      }
    });

    return {
      ...topology,
      pg: pgContainer,
      stop: async () => {
        await pgContainer?.stop();
        await topology.stop();
      }
    };
  } catch (error) {
    await pgContainer?.stop();
    await topology.stop();
    throw error;
  }
}

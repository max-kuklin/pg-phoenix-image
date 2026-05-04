import { GenericContainer, Network, Wait } from 'testcontainers';
import pg from 'pg';

export const IMAGE_NAME = process.env.PG_PHOENIX_IMAGE || 'pg-phoenix-image:test';
export const POSTGRES_PASSWORD = 'test';
export const MINIO_IMAGE = process.env.MINIO_IMAGE || 'minio/minio:RELEASE.2025-09-07T16-13-09Z';
export const MINIO_CLIENT_IMAGE = process.env.MINIO_CLIENT_IMAGE || 'minio/mc:RELEASE.2025-08-13T08-35-41Z';
export const MINIO_ACCESS_KEY = 'minioadmin';
export const MINIO_SECRET_KEY = 'minioadmin';
export const MINIO_BUCKET = 'pg-phoenix-test';

export async function startPg(overrides = {}) {
  const env = {
    POSTGRES_PASSWORD,
    ...overrides.env
  };

  let builder = new GenericContainer(IMAGE_NAME)
    .withEnvironment(env)
    .withExposedPorts(5432)
    .withWaitStrategy(overrides.waitStrategy ?? Wait.forHealthCheck());

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
  const port = container.getMappedPort(5432);

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

export async function startMinio() {
  const network = await new Network().start();

  let minio;

  try {
    minio = await new GenericContainer(MINIO_IMAGE)
      .withCommand(['server', '/data'])
      .withEnvironment({
        MINIO_ROOT_USER: MINIO_ACCESS_KEY,
        MINIO_ROOT_PASSWORD: MINIO_SECRET_KEY
      })
      .withNetwork(network)
      .withNetworkAliases('minio')
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000).forStatusCode(200))
      .start();

    await new GenericContainer(MINIO_CLIENT_IMAGE)
      .withNetwork(network)
      .withEntrypoint(['sh'])
      .withCommand([
        '-c',
        [
          `mc alias set local http://minio:9000 ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY}`,
          `mc mb --ignore-existing local/${MINIO_BUCKET}`
        ].join(' && ')
      ])
      .withWaitStrategy(Wait.forOneShotStartup())
      .start();

    return {
      minio,
      network,
      bucket: MINIO_BUCKET,
      stop: async () => {
        await minio?.stop();
        await network.stop();
      }
    };
  } catch (error) {
    await minio?.stop();
    await network.stop();
    throw error;
  }
}

export async function runMinioClient(network, command) {
  const container = await new GenericContainer(MINIO_CLIENT_IMAGE)
    .withNetwork(network)
    .withEntrypoint(['sh'])
    .withCommand([
      '-c',
      [
        `mc alias set local http://minio:9000 ${MINIO_ACCESS_KEY} ${MINIO_SECRET_KEY} >/dev/null`,
        command
      ].join(' && ')
    ])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();

  const logs = await container.logs();
  const chunks = [];

  for await (const chunk of logs) {
    chunks.push(Buffer.from(chunk).toString('utf8'));
  }

  return chunks.join('');
}

export function minioPgEnv(prefix = `s3://${MINIO_BUCKET}/pg`) {
  return {
    WALG_S3_PREFIX: prefix,
    AWS_ACCESS_KEY_ID: MINIO_ACCESS_KEY,
    AWS_SECRET_ACCESS_KEY: MINIO_SECRET_KEY,
    AWS_ENDPOINT: 'http://minio:9000',
    AWS_REGION: 'us-east-1',
    AWS_S3_FORCE_PATH_STYLE: 'true',
    BACKUP_SCHEDULE: '0 0 * * *',
    ARCHIVE_TIMEOUT: '60'
  };
}

export async function startPgWithMinio(overrides = {}) {
  const topology = await startMinio();
  let pgContainer;

  try {
    pgContainer = await startPg({
      network: topology.network,
      networkAliases: ['pg'],
      bindMounts: overrides.bindMounts,
      env: {
        ...minioPgEnv(),
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

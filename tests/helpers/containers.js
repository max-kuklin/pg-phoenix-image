import { GenericContainer, Wait } from 'testcontainers';
import pg from 'pg';

export const IMAGE_NAME = process.env.PG_PHOENIX_IMAGE || 'pg-phoenix-image:test';
export const POSTGRES_PASSWORD = 'test';

export async function startPg(overrides = {}) {
  const env = {
    POSTGRES_PASSWORD,
    ...overrides.env
  };

  let builder = new GenericContainer(IMAGE_NAME)
    .withEnvironment(env)
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forHealthCheck());

  if (overrides.bindMounts) {
    builder = builder.withBindMounts(overrides.bindMounts);
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
    exec: (command) => container.exec(command),
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

export async function startPgWithMinio() {
  throw new Error('startPgWithMinio is implemented in the backup/restore phase');
}

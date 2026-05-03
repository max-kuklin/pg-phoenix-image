import { GenericContainer, Wait } from 'testcontainers';

export const IMAGE_NAME = process.env.PG_PHOENIX_IMAGE || 'pg-phoenix-image:test';

export async function startPg(overrides = {}) {
  const env = {
    POSTGRES_PASSWORD: 'test',
    ...overrides.env
  };

  const container = await new GenericContainer(IMAGE_NAME)
    .withEnvironment(env)
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/i))
    .start();

  return {
    container,
    host: container.getHost(),
    port: container.getMappedPort(5432),
    stop: () => container.stop()
  };
}

export async function startPgWithMinio() {
  throw new Error('startPgWithMinio is implemented in the backup/restore phase');
}


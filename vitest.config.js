import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: true,
    sequence: {
      concurrent: false
    }
  }
});


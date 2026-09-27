import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 60000,
    // Integration tests start real servers and child processes.
    fileParallelism: false,
  },
});

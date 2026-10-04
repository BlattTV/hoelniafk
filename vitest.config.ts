import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 60000,
    // Integration tests start real servers and child processes.
    fileParallelism: false,
    // never ask the real IP echo services from tests (refused at once; tests that need an IP start their own)
    env: { HOELNI_IP_ENDPOINTS: 'http://127.0.0.1:9/ip', HOELNI_START_SPACING: '0', HOELNI_REJOIN_SPACING: '0', HOELNI_BOOT_SPACING: '0' },
  },
});

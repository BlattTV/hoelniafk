import { defineConfig } from '@playwright/test';

/**
 * Browser E2E tests against the demo (real mineflayer sessions on local
 * flying-squid servers; mail/Discord/public IP simulated).
 *
 *   npx playwright install chromium   (once)
 *   npm run test:e2e
 *
 * PW_CHROMIUM_PATH can point to an existing Chromium binary.
 */
const PORT = Number(process.env.E2E_PORT ?? 7431);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 900 },
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
    },
  },
  webServer: {
    command: 'node --import tsx src/demo.ts',
    url: `http://127.0.0.1:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { HOELNI_PORT: String(PORT), HOELNI_DEMO_MC_PORT: String(PORT + 18200), HOELNI_DEMO_IDENTITIES: '5', HOELNI_DEMO_FAKE_GAME: '1', HOELNI_IP_ENDPOINTS: 'http://127.0.0.1:9/ip', HOELNI_START_SPACING: '0', HOELNI_REJOIN_SPACING: '0', HOELNI_BOOT_SPACING: '0', HOELNI_ONLINE_SPACING: '0' },
    ignoreHTTPSErrors: true,
  },
});

import { defineConfig, devices } from '@playwright/test';

const PORT = 4390;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  projects: [
    { name: 'desktop-light', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: `CLOCK_DATA_DIR=/tmp/clock-e2e-data CLOCK_PORT=${PORT} npm run start -w server`,
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CLOCK_DATA_DIR: '/tmp/clock-e2e-data',
      CLOCK_PORT: String(PORT),
      CLOCK_E2E_DAYTIME: '1',
      NODE_ENV: 'test',
    },
  },
});

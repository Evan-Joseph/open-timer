import { defineConfig, devices } from '@playwright/test';

const PORT = 4390;
/** CI/本地并发回归可传入一个已清空的专用临时目录，避免复用残留的 SQLite WAL。 */
const DATA_DIR = process.env.CLOCK_E2E_DATA_DIR ?? '/tmp/clock-e2e-data';

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
  // 2026-08-20 决策：产品只覆盖 Pad/Desktop 横屏，移动端（原 Pixel 7 project）退役。
  // Pad/Desktop 验收必须使用下方真实断点，不得由手机视口代替。
  projects: [
    { name: 'desktop-light', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // 必须在 SQLite 进程启动前清掉上轮 WAL/SHM；测试钩子在服务启动后再删除会造成 IOERR。
    command: `node -e "const { rmSync, mkdirSync } = require('node:fs'); rmSync(process.env.CLOCK_DATA_DIR, { recursive: true, force: true }); mkdirSync(process.env.CLOCK_DATA_DIR, { recursive: true });" && CLOCK_DATA_DIR=${DATA_DIR} CLOCK_PORT=${PORT} npm run start -w server`,
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      CLOCK_DATA_DIR: DATA_DIR,
      CLOCK_PORT: String(PORT),
      CLOCK_E2E_DAYTIME: '1',
      CLOCK_MIN_SEGMENT_SECONDS: '0',
      NODE_ENV: 'test',
    },
  },
});

/** Node 本地入口。云上（Workers/CloudBase）复用 createApp，仅替换此文件。 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SqliteStorage } from './repo/sqlite-storage.js';
import { hashPassword } from './password.js';
import { shanghaiDayRangeUtc, shanghaiToday } from '@clock/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const storage = new SqliteStorage(config.dbPath);
await storage.migrate();
if (config.initialOwnerPin && (await storage.getOwnerPasswordHash()) === null) {
  await storage.setOwnerPasswordHash(await hashPassword(config.initialOwnerPin));
}

const bootRealNowMs = Date.now();
const e2eDaytimeBaseMs = process.env.NODE_ENV === 'test' && process.env.CLOCK_E2E_DAYTIME === '1'
  ? shanghaiDayRangeUtc(shanghaiToday(bootRealNowMs)).startMs + 10 * 60 * 60_000
  : null;

const app = createApp({
  storage,
  config,
  now: e2eDaytimeBaseMs === null
    ? undefined
    : () => e2eDaytimeBaseMs + (Date.now() - bootRealNowMs),
  rateLimits: process.env.NODE_ENV === 'production' ? undefined : { loginMaxPerMin: 60, apiMaxPerMin: 600 },
});

// 生产模式托管前端静态产物；未匹配路径的 JSON 404 由 createApp 内 notFound 统一提供
const webDist = join(__dirname, '..', '..', 'web', 'dist');
app.use(
  '/*',
  serveStatic({
    root: webDist,
    rewriteRequestPath: (path) => path,
  }),
);

app.onError((_err, c) => {
  // 公网错误页不泄漏栈与路径
  return c.json({ error: 'INTERNAL' }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`open-timer server listening on http://127.0.0.1:${info.port}`);
});

process.on('SIGINT', () => {
  storage.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  storage.close();
  process.exit(0);
});

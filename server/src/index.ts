/** Node 本地入口。云上（Workers/CloudBase）复用 createApp，仅替换此文件。 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SqliteStorage } from './repo/sqlite-storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
mkdirSync(dirname(config.dbPath), { recursive: true });

const storage = new SqliteStorage(config.dbPath);
storage.migrate();

const app = createApp({
  storage,
  config,
  rateLimits: process.env.NODE_ENV === 'production' ? undefined : { loginMaxPerMin: 60, apiMaxPerMin: 600 },
});

// 生产模式托管前端静态产物
const webDist = join(__dirname, '..', '..', 'web', 'dist');
app.use(
  '/*',
  serveStatic({
    root: webDist,
    rewriteRequestPath: (path) => path,
  }),
);
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'NOT_FOUND' }, 404);
  return c.json({ error: 'NOT_FOUND' }, 404);
});

app.onError((err, c) => {
  if (c.req.path.startsWith('/api/')) {
    // 公网错误页不泄漏栈与路径
    return c.json({ error: 'INTERNAL' }, 500);
  }
  return c.json({ error: 'INTERNAL' }, 500);
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`immersive-clock server listening on http://127.0.0.1:${info.port}`);
});

process.on('SIGINT', () => {
  storage.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  storage.close();
  process.exit(0);
});

/**
 * Cloudflare Workers 入口：同一份 app.ts + D1 适配器 + 静态资产 binding。
 * 构建：esbuild bundle（.sql 以 text loader 内嵌）。
 */

import type { ExecutionContext } from '@cloudflare/workers-types';
import { createApp } from './app.js';
import { D1Storage, type D1Database } from './repo/d1-storage.js';
import type { AppConfig } from './config.js';
import migrationSql from '../../migrations/0001_init.sql';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handle(request, env);
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
    const config: AppConfig = {
      dbPath: 'd1://clock',
      port: 443,
      baseUrl: url.origin,
      isProduction: true,
      sessionTtlMs: 7 * 86_400_000,
      version: '0.1.0',
    };
    const storage = new D1Storage(env.DB, migrationSql);
    // 已初始化则跳过迁移（探测 schema_migrations）；未初始化则幂等执行（IF NOT EXISTS / ON CONFLICT）
    const ready = await env.DB.prepare('SELECT COUNT(*) AS c FROM schema_migrations').first().catch(() => null);
    if (!ready) await storage.migrate();

    const app = createApp({ storage, config });

    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request);
    }
    // 静态资产（web/dist 通过 assets binding 托管），SPA fallback 到 index.html
    const res = await env.ASSETS.fetch(new Request(url.origin + url.pathname, request));
    if (res.status === 404 && !url.pathname.includes('.')) {
      return env.ASSETS.fetch(new Request(url.origin + '/index.html', request));
    }
    return res;
}

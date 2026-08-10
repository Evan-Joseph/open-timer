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

/** 同一 Worker isolate 内共享：迁移完成后不再探测数据库 */
let migrated = false;

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
  // 模块级标志：同一 isolate 内只探测/执行一次迁移，避免每请求一次 D1 查询
  if (!migrated) {
    const ready = await env.DB.prepare('SELECT COUNT(*) AS c FROM schema_migrations').first().catch(() => null);
    if (!ready) await storage.migrate();
    migrated = true;
  }

  const app = createApp({ storage, config });

  if (url.pathname.startsWith('/api/')) {
    return app.fetch(request);
  }

  // 静态资产（web/dist 通过 assets binding 托管），SPA fallback 到 index.html
  const res = await env.ASSETS.fetch(new Request(url.origin + url.pathname, request));
  const assetRes =
    res.status === 404 && !url.pathname.includes('.')
      ? await env.ASSETS.fetch(new Request(url.origin + '/index.html', request))
      : res;

  // 缓存策略：hashed 资产长缓存，HTML 每次 revalidate，避免旧版分发
  const headers = new Headers(assetRes.headers);
  if (url.pathname.startsWith('/assets/')) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    headers.set('Cache-Control', 'no-cache, must-revalidate');
  }
  return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers });
}

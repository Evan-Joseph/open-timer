/**
 * Cloudflare Workers 入口：同一份 app.ts + D1 适配器 + 静态资产 binding。
 * 构建：esbuild bundle（.sql 以 text loader 内嵌）。
 */

import { createApp } from './app.js';
import { applySecurityHeaders } from './headers.js';
import { runBackup, type BackupBucket } from './backup.js';
import { D1Storage, type D1Database } from './repo/d1-storage.js';
import { loadConchConfig } from './conch-config.js';
import type { AppConfig } from './config.js';
import migrationSql0001 from '../../migrations/0001_init.sql';
import migrationSql0002 from '../../migrations/0002_user_pref.sql';
import migrationSql0003 from '../../migrations/0003_index_session_ended.sql';

/** 全部迁移 SQL（按序号拼接；均为幂等，可重复执行）。
 *  注意：新增迁移文件必须在此显式导入，否则 Worker 不会执行
 *  （SQLite 适配器按目录加载，两边加载方式不同，曾因此漏掉 0003）。 */
const migrationSql = `${migrationSql0001}\n${migrationSql0002}\n${migrationSql0003}`;

/** Workers 运行时上下文（本地声明，不引入 workers-types 以免与 Node 类型冲突） */
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BACKUP: BackupBucket;
  /** 神奇海螺（可选）：wrangler secret 注入；缺失则功能返回 503 */
  CONCH_API_BASE?: string;
  CONCH_API_KEY?: string;
  CONCH_MODEL?: string;
  CONCH_THINKING_BUDGET?: string;
}

/** 同一 Worker isolate 内共享：迁移完成后不再探测数据库 */
let migrated = false;

async function ensureMigrated(env: Env, storage: D1Storage): Promise<void> {
  // 始终执行幂等迁移（全部 IF NOT EXISTS / ON CONFLICT，可重复执行），
  // 每 isolate 仅一次。旧版曾以「schema_migrations 表存在」作为跳过条件，
  // 导致后续增量迁移（如 0002 user_pref）在生产永远不执行——该门槛已移除。
  if (migrated) return;
  await storage.migrate();
  migrated = true;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handle(request, env);
  },

  /** Cron Triggers（wrangler.jsonc：15:00 UTC = 北京 23:00）：每日备份到 R2。 */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nowMs = Date.now();
    try {
      const storage = new D1Storage(env.DB, migrationSql);
      await ensureMigrated(env, storage);
      const result = await runBackup(storage, env.BACKUP, nowMs);
      console.log(`backup done: date=${result.date} wrote=${result.written.join(',')} pruned=${result.pruned.length}`);
    } catch (err) {
      // 失败也落一个状态对象，便于用 r2 object get backup/last-run.json 诊断
      console.error('backup failed:', err);
      try {
        await env.BACKUP.put(
          'backup/last-run.json',
          JSON.stringify({ ok: false, ran_at_ms: nowMs, ran_at_iso: new Date(nowMs).toISOString(), error: String(err) }, null, 2),
        );
      } catch {
        /* 状态写入失败不影响主流程上报 */
      }
    }
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
    minSegmentMs: 10_000, // 误触过滤：短于 10 秒的已关闭片段不计入
    conch: loadConchConfig({
      CONCH_API_BASE: env.CONCH_API_BASE,
      CONCH_API_KEY: env.CONCH_API_KEY,
      CONCH_MODEL: env.CONCH_MODEL,
      CONCH_THINKING_BUDGET: env.CONCH_THINKING_BUDGET,
    }),
    version: '0.1.0',
  };
  const storage = new D1Storage(env.DB, migrationSql);
  // 模块级标志：同一 isolate 内只探测/执行一次迁移，避免每请求一次 D1 查询
  await ensureMigrated(env, storage);

  const app = createApp({ storage, config, backupBucket: env.BACKUP });

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
  // 安全头与 API 同源：静态响应（尤其 HTML 外壳）同样必须携带 CSP/XFO/HSTS，
  // 与 app.ts 的 '*' 中间件共用 headers.ts 单一实现，覆盖全部响应（含 404）。
  applySecurityHeaders((name, value) => headers.set(name, value), { isProduction: config.isProduction });
  return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers });
}

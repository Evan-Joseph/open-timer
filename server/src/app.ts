/**
 * Hono 应用：路由 + 校验 + 鉴权 + 幂等。provider-neutral，可跑在 Node/Workers。
 * 领域规则全部来自 @clock/shared；持久化通过 Storage 接口（全异步）。
 */

import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { Storage } from './repo/storage.js';
import type { AppConfig } from './config.js';
import {
  OWNER_COOKIE,
  generateToken,
  getApiAuth,
  getOwnerAuth,
  requireOwner,
  serializeCookie,
  sha256hex,
} from './auth.js';
import { RateLimiter } from './rate-limit.js';
import { applySecurityHeaders, clientIp } from './headers.js';
import { eventToLine, runBackup } from './backup.js';
import { ulid } from './util/ulid.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  SUBJECTS,
  TIMEZONE,
  buildDailySummary,
  isValidShanghaiDate,
  shanghaiDayRangeUtc,
  shanghaiToday,
  toIso,
  computeActiveSeconds,
  isCountedSegment,
} from '@clock/shared';

const SUBJECT_ID_ENUM = SUBJECTS.map((s) => s.id) as [string, ...string[]];

const IdempotencyKeySchema = z.string().min(8).max(64);
const NoteSchema = z.string().max(200);

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  /** 可注入时钟，测试用 */
  now?: () => number;
  /** 限流参数覆盖（测试注入；生产默认登录 5/min，API 300/min） */
  rateLimits?: { loginMaxPerMin?: number; apiMaxPerMin?: number };
  /** R2 备份桶（仅 Workers 环境注入；Node 本地无 R2 时手动备份端点返回 501） */
  backupBucket?: import('./backup.js').BackupBucket;
}

export function createApp(deps: AppDeps): Hono {
  const { storage, config } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  const loginLimiter = new RateLimiter(60_000, deps.rateLimits?.loginMaxPerMin ?? 5);
  const apiLimiter = new RateLimiter(60_000, deps.rateLimits?.apiMaxPerMin ?? 300);

  /* ---------- 全局：安全头 + 限流 + CSRF ---------- */

  app.use('*', async (c, next) => {
    await next();
    applySecurityHeaders((name, value) => c.header(name, value), { isProduction: config.isProduction });
  });

  app.use('/api/*', async (c, next) => {
    const owner = await getOwnerAuth(c, storage);
    const api = owner ?? (await getApiAuth(c, storage));
    const actor = api?.actor ?? clientIp((name) => c.req.header(name));
    if (!apiLimiter.allow(actor, now())) return c.json({ error: 'RATE_LIMITED' }, 429);
    await next();
  });

  // 动态事实禁止使用陈旧缓存；日报保留 ETag 重验证，固定科目表可短时缓存。
  app.use('/api/*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (path === '/api/v1/subjects' && c.req.method === 'GET') {
      c.header('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else if (path === '/api/v1/daily-summary' && c.req.method === 'GET') {
      c.header('Cache-Control', 'private, no-cache, must-revalidate');
    } else {
      c.header('Cache-Control', 'no-store');
    }
  });

  // CSRF：写请求必须来自同源（Origin 与 Host 匹配）。
  // OPTIONS 预检不变更状态且真实请求会单独受检，显式豁免，保证公开只读端点的跨域预检可用。
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin) {
        const host = c.req.header('host');
        try {
          const u = new URL(origin);
          if (host && u.host !== host) return c.json({ error: 'CSRF_REJECTED' }, 403);
        } catch {
          return c.json({ error: 'CSRF_REJECTED' }, 403);
        }
      }
    }
    await next();
  });

  /* ---------- 路径参数 ---------- */

  function paramId(c: Context): string | null {
    const id = c.req.param('id');
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  /* ---------- 幂等辅助 ----------
   * 契约（与 docs/API.md、openapi.yaml 对齐）：
   * - 所有会话写操作（start/pause/resume/stop/switch/void/note/retime/adjust-start）
   *   必须携带 Idempotency-Key（8–64 字符），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED。
   * - 服务端按「端点:键」保存响应 24h；同键重试回放原状态码与原响应体，
   *   并带 Idempotent-Replay: true（参考 IETF idempotency-key 草案与 Stripe 语义）。
   * - auth/credentials 端点是连接与凭据管理，不是资源变更，不要求幂等键，
   *   由限流保护（见 README 安全清单）。
   */

  const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

  /** 存储格式 v2：{"v":2,"status":N,"body":...}；v1（裸 body）按 200 回放兼容。 */
  function decodeStoredResponse(responseJson: string): { status: number; body: string } {
    try {
      const parsed = JSON.parse(responseJson) as { v?: number; status?: number; body?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.v === 2 && typeof parsed.status === 'number') {
        return { status: parsed.status, body: JSON.stringify(parsed.body) };
      }
    } catch {
      /* 非 JSON 的旧记录按 v1 处理 */
    }
    return { status: 200, body: responseJson };
  }

  async function withIdempotency(
    c: Context,
    endpoint: string,
    fn: () => Promise<{ status: number; body: unknown }>,
  ) {
    const keyRaw = c.req.header('idempotency-key');
    const parsed = IdempotencyKeySchema.safeParse(keyRaw);
    if (!parsed.success) return c.json({ error: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    const key = `${endpoint}:${parsed.data}`;
    const existing = await storage.getIdempotentResponse(key);
    if (existing && existing.endpoint === endpoint) {
      const stored = decodeStoredResponse(existing.responseJson);
      c.status(stored.status as 200);
      c.header('Idempotent-Replay', 'true');
      return c.body(stored.body);
    }
    const result = await fn();
    const json = JSON.stringify({ v: 2, status: result.status, body: result.body });
    await storage.saveIdempotentResponse(key, endpoint, json, now());
    // 每次写入顺带清理过期键，避免清理频率依赖 start 单一入口
    await storage.purgeIdempotentBefore(now() - IDEMPOTENCY_TTL_MS);
    c.status(result.status as 200);
    return c.body(JSON.stringify(result.body));
  }

  /* ---------- 公共 ---------- */

  app.get('/api/v1/health', (c) =>
    c.json({ status: 'ok', server_time: toIso(now()), version: config.version }),
  );

  /* ---------- owner 认证（6 位纯数字 PIN，iOS 锁屏式） ---------- */

  const PinSchema = z
    .object({ password: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits') })
    .transform((v) => v);

  app.post('/api/v1/auth/setup', async (c) => {
    if ((await storage.getOwnerPasswordHash()) !== null) return c.json({ error: 'ALREADY_SETUP' }, 409);
    const body = PinSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const passwordHash = await hashPassword(body.data.password);
    await storage.setOwnerPasswordHash(passwordHash);
    await storage.appendAudit('owner', 'setup', 'owner_credential', null, now());
    return loginAndSetCookie(c);
  });

  const LoginSchema = z.object({ password: z.string().min(1).max(64) });

  app.post('/api/v1/auth/login', async (c) => {
    const ip = clientIp((name) => c.req.header(name));
    if (!loginLimiter.allow(ip, now())) return c.json({ error: 'RATE_LIMITED' }, 429);
    const stored = await storage.getOwnerPasswordHash();
    if (stored === null) return c.json({ error: 'NOT_SETUP' }, 409);
    const body = LoginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const ok = await verifyPassword(body.data.password, stored);
    if (!ok) {
      await storage.appendAudit('anon', 'login_failed', 'owner_credential', null, now());
      return c.json({ error: 'INVALID_CREDENTIALS' }, 401);
    }
    return loginAndSetCookie(c);
  });

  async function loginAndSetCookie(c: Context) {
    const token = generateToken('sess');
    await storage.createOwnerSession(await sha256hex(token), now() + config.sessionTtlMs);
    c.header(
      'Set-Cookie',
      serializeCookie(OWNER_COOKIE, token, { maxAgeSec: Math.floor(config.sessionTtlMs / 1000), secure: config.isProduction }),
    );
    return c.json({ ok: true });
  }

  app.post('/api/v1/auth/logout', requireOwner(storage), async (c) => {
    const raw = c.req.header('cookie') ?? '';
    const match = raw.match(/clock_session=([^;]+)/);
    if (match) await storage.deleteOwnerSession(await sha256hex(decodeURIComponent(match[1])));
    c.header('Set-Cookie', serializeCookie(OWNER_COOKIE, '', { maxAgeSec: 0, secure: config.isProduction }));
    return c.json({ ok: true });
  });

  app.get('/api/v1/auth/me', async (c) => {
    const authenticated = (await getOwnerAuth(c, storage)) !== null;
    const setupDone = (await storage.getOwnerPasswordHash()) !== null;
    return c.json({ authenticated, setup_done: setupDone });
  });

  /* ---------- 公开只读（供其他 Agent / 自动化读取学习数据，无需认证） ----------
   * 写操作（start/pause/stop/…）仍要求 owner 登录（cookie）。
   * 注意：公开端点在公网上任何人可读，勿在其中暴露敏感信息。
   */

  /** 跨域可读：浏览器端 Agent/页面也能直接 fetch。 */
  const publicCors = async (c: Context, next: Next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'If-None-Match');
    await next();
  };

  // CORS 预检：GET-only 路由不会匹配 OPTIONS，单独注册统一 204。
  // 产品上跨域仅开放公开只读，Allow-Methods 固定 GET/OPTIONS。
  app.options('/api/v1/*', (c) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'If-None-Match');
    c.header('Access-Control-Max-Age', '86400');
    return c.body(null, 204);
  });

  app.get('/api/v1/subjects', publicCors, (c) =>
    c.json(
      SUBJECTS.map((s) => ({
        subject_id: s.id,
        display_name: s.displayName,
        aggregate_group: s.aggregateGroup,
        color_id: s.colorId,
        sort_order: s.sortOrder,
      })),
    ),
  );

  /* ---------- state（前端恢复用；公开只读） ---------- */

  app.get('/api/v1/state', publicCors, async (c) => {
    const nowMs = now();
    const active = await storage.getActiveSession('owner');
    const today = shanghaiToday(nowMs);
    const { startMs } = shanghaiDayRangeUtc(today);
    const sessions = await storage.sessionsOverlapping(startMs, nowMs + 1);
    const segMap = await storage.segmentsForSessions(sessions.map((s) => s.id));
    const summary = buildDailySummary({
      date: today,
      sessions,
      segmentsBySession: segMap,
      adjustments: [],
      revision: await storage.maxEventId(),
      generatedAtMs: nowMs,
      activeSession: active?.session ?? null,
      activeSegments: active?.segments ?? [],
      minSegmentMs: config.minSegmentMs,
    });
    // UI 需要会话总净时长（不按日裁剪）：直接从段计算（误触片段同样过滤）
    let activeTotalSeconds: number | null = null;
    let openSegmentStart: string | null = null;
    if (active) {
      activeTotalSeconds = computeActiveSeconds(
        active.segments.filter((seg) => isCountedSegment(seg, config.minSegmentMs)),
        nowMs,
      );
      const open = active.segments.find((s) => s.endedAtMs === null);
      openSegmentStart = open ? toIso(open.startedAtMs) : null;
    }
    return c.json({
      server_now_ms: nowMs,
      server_now_iso: toIso(nowMs),
      active_session: summary.running_session
        ? {
            ...summary.running_session,
            active_seconds: activeTotalSeconds ?? summary.running_session.active_seconds,
            current_segment_started_at: openSegmentStart ?? summary.running_session.current_segment_started_at,
          }
        : null,
      today_active_seconds: summary.total_active_seconds,
      today_date: today,
    });
  });

  /* ---------- 写路径 ---------- */

  const StartSchema = z.object({
    subject_id: z.enum(SUBJECT_ID_ENUM),
    intent_note: NoteSchema.optional().nullable(),
  });

  app.post('/api/v1/sessions', requireOwner(storage), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const body = StartSchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    return withIdempotency(c, 'start', async () => {
      const active = await storage.getActiveSession('owner');
      if (active) {
        return {
          status: 409,
          body: { error: 'ACTIVE_SESSION_EXISTS', active_session_id: active.session.id, subject_id: active.session.subjectId },
        };
      }
      const nowMs = now();
      const id = ulid(nowMs);
      const session = await storage.createSession({
        id,
        userId: 'owner',
        subjectId: body.data.subject_id as (typeof SUBJECTS)[number]['id'],
        intentNote: body.data.intent_note ?? null,
        nowMs,
        idempotencyKey: `start:${c.req.header('idempotency-key')}`,
      });
      if (!session) {
        return { status: 409, body: { error: 'ACTIVE_SESSION_EXISTS' } };
      }
      await storage.appendAudit('owner', 'session_start', id, JSON.stringify({ subject_id: session.subjectId }), nowMs);
      return { status: 201, body: sessionResponse(session) };
    });
  });

  app.post('/api/v1/sessions/:id/pause', requireOwner(storage), (c) =>
    withIdempotency(c, 'pause', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'running') return { status: 409, body: { error: 'ILLEGAL_TRANSITION', status: session.status } };
      const nowMs = now();
      await storage.pauseSession(id, nowMs, `pause:${c.req.header('idempotency-key')}`);
      await storage.appendAudit('owner', 'session_pause', id, null, nowMs);
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  app.post('/api/v1/sessions/:id/resume', requireOwner(storage), (c) =>
    withIdempotency(c, 'resume', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'paused' && session.status !== 'stopped')
        return { status: 409, body: { error: 'ILLEGAL_TRANSITION', status: session.status } };
      // 误触继续：重开已停止会话前，必须没有其他活动会话（唯一活动会话约束）
      if (session.status === 'stopped') {
        const active = await storage.getActiveSession('owner');
        if (active) {
          return {
            status: 409,
            body: { error: 'ACTIVE_SESSION_EXISTS', active_session_id: active.session.id, subject_id: active.session.subjectId },
          };
        }
      }
      const nowMs = now();
      await storage.resumeSession(id, nowMs, `resume:${c.req.header('idempotency-key')}`);
      await storage.appendAudit(
        'owner',
        'session_resume',
        id,
        session.status === 'stopped' ? JSON.stringify({ reopened_from: 'stopped' }) : null,
        nowMs,
      );
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  const StopSchema = z.object({ end_note: NoteSchema.optional().nullable() });

  app.post('/api/v1/sessions/:id/stop', requireOwner(storage), async (c) =>
    withIdempotency(c, 'stop', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const raw = await c.req.json().catch(() => null);
      const body = StopSchema.safeParse(raw ?? {});
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'running' && session.status !== 'paused')
        return { status: 409, body: { error: 'ILLEGAL_TRANSITION', status: session.status } };
      const nowMs = now();
      await storage.stopSession(id, nowMs, 'manual', `stop:${c.req.header('idempotency-key')}`);
      if (body.data.end_note) await storage.setSessionNote(id, body.data.end_note, nowMs);
      await storage.appendAudit('owner', 'session_stop', id, null, nowMs);
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  const SwitchSchema = z.object({
    subject_id: z.enum(SUBJECT_ID_ENUM),
    intent_note: NoteSchema.optional().nullable(),
  });

  /** 原子换科目：结束当前段（subject_switch）+ 开启新会话。 */
  app.post('/api/v1/sessions/:id/switch', requireOwner(storage), async (c) =>
    withIdempotency(c, 'switch', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const raw = await c.req.json().catch(() => null);
      const body = SwitchSchema.safeParse(raw);
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const current = await storage.getActiveSession('owner');
      if (!current || current.session.id !== id) return { status: 409, body: { error: 'NOT_ACTIVE_SESSION' } };
      const nowMs = now();
      await storage.stopSession(id, nowMs, 'subject_switch', `switch-stop:${c.req.header('idempotency-key')}`);
      const newId = ulid(nowMs);
      const newSession = await storage.createSession({
        id: newId,
        userId: 'owner',
        subjectId: body.data.subject_id as (typeof SUBJECTS)[number]['id'],
        intentNote: body.data.intent_note ?? null,
        nowMs,
        idempotencyKey: `switch-start:${c.req.header('idempotency-key')}`,
      });
      if (!newSession) return { status: 500, body: { error: 'SWITCH_FAILED' } };
      await storage.appendAudit('owner', 'subject_switch', id, JSON.stringify({ to: newSession.subjectId }), nowMs);
      return { status: 200, body: { stopped: sessionResponse((await storage.getSession(id))!), started: sessionResponse(newSession) } };
    }),
  );

  const VoidSchema = z.object({ reason: NoteSchema.optional().nullable() });

  app.post('/api/v1/sessions/:id/void', requireOwner(storage), async (c) =>
    withIdempotency(c, 'void', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const raw = await c.req.json().catch(() => null);
      const body = VoidSchema.safeParse(raw ?? {});
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'stopped') return { status: 409, body: { error: 'ILLEGAL_TRANSITION', status: session.status } };
      const nowMs = now();
      await storage.voidSession(id, nowMs, body.data.reason ?? null, `void:${c.req.header('idempotency-key')}`);
      await storage.appendAudit('owner', 'session_void', id, JSON.stringify({ reason: body.data.reason ?? null }), nowMs);
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  const NotePatchSchema = z.object({ note: NoteSchema });

  app.patch('/api/v1/sessions/:id/note', requireOwner(storage), (c) =>
    withIdempotency(c, 'note', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const body = NotePatchSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'stopped') return { status: 409, body: { error: 'ILLEGAL_TRANSITION' } };
      await storage.setSessionNote(id, body.data.note, now());
      await storage.appendAudit('owner', 'session_note', id, null, now());
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  const RetimeSchema = z.object({ delta_seconds: z.number().int().min(-86400).max(86400), reason: NoteSchema.nullable() });

  app.post('/api/v1/sessions/:id/retime', requireOwner(storage), (c) =>
    withIdempotency(c, 'retime', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const body = RetimeSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'stopped') return { status: 409, body: { error: 'ILLEGAL_TRANSITION' } };
      try {
        await storage.applyRetime(id, body.data.delta_seconds, body.data.reason, now());
      } catch (error) {
        if ((error as Error).message === 'INVALID_RETIME') return { status: 400, body: { error: 'INVALID_RETIME' } };
        throw error;
      }
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  const AdjustStartSchema = z.object({ started_at: z.iso.datetime({ offset: true }), reason: NoteSchema.nullable() });

  app.post('/api/v1/sessions/:id/adjust-start', requireOwner(storage), (c) =>
    withIdempotency(c, 'adjust-start', async () => {
      const id0 = paramId(c);
      if (!id0) return { status: 400, body: { error: 'INVALID_ID' } };
      const id = id0;
      const body = AdjustStartSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return { status: 400, body: { error: 'INVALID_BODY' } };
      const session = await storage.getSession(id);
      if (!session) return { status: 404, body: { error: 'SESSION_NOT_FOUND' } };
      if (session.status !== 'stopped') return { status: 409, body: { error: 'ILLEGAL_TRANSITION' } };
      try {
        await storage.adjustSessionStart(id, Date.parse(body.data.started_at), body.data.reason, now());
      } catch (error) {
        if ((error as Error).message === 'INVALID_START') return { status: 400, body: { error: 'INVALID_START' } };
        throw error;
      }
      return { status: 200, body: sessionResponse((await storage.getSession(id))!) };
    }),
  );

  /* ---------- 查询（公开只读） ---------- */

  app.get('/api/v1/sessions', publicCors, async (c) => {
    const date = c.req.query('date');
    if (!date || !isValidShanghaiDate(date)) return c.json({ error: 'INVALID_DATE' }, 400);
    const { startMs, endMs } = shanghaiDayRangeUtc(date);
    const nowMs = now();
    const sessions = await storage.sessionsOverlapping(startMs, endMs);
    const segMap = await storage.segmentsForSessions(sessions.map((s) => s.id));
    const entries = sessions.map((s) => {
      const segs = segMap.get(s.id) ?? [];
      let secs = 0;
      const clippedSegs: Array<{ started_at: string; ended_at: string | null }> = [];
      for (const seg of segs) {
        // 误触过滤：短于阈值的已关闭片段不计入、不下发（开放段不受影响）
        if (!isCountedSegment(seg, config.minSegmentMs)) continue;
        const rawEnd = seg.endedAtMs ?? nowMs;
        const cs = Math.max(seg.startedAtMs, startMs);
        const ce = Math.min(rawEnd, endMs);
        if (ce > cs) {
          secs += Math.floor((ce - cs) / 1000);
          clippedSegs.push({
            started_at: toIso(cs),
            ended_at: seg.endedAtMs === null ? null : toIso(ce),
          });
        }
      }
      return {
        session_id: s.id,
        subject_id: s.subjectId,
        started_at: toIso(s.startedAtMs),
        ended_at: s.endedAtMs !== null ? toIso(s.endedAtMs) : null,
        active_seconds: secs,
        status: s.status,
        end_reason: s.endReason,
        note: s.endNote ?? s.intentNote ?? null,
        segments: clippedSegs,
      };
    });
    return c.json({ date, timezone: TIMEZONE, sessions: entries });
  });

  /* ---------- daily-summary（公开只读，带 ETag） ---------- */

  app.get('/api/v1/daily-summary', publicCors, async (c) => {
    const date = c.req.query('date');
    const tz = c.req.query('timezone');
    if (!date || !isValidShanghaiDate(date)) return c.json({ error: 'INVALID_DATE' }, 400);
    if (tz !== TIMEZONE) return c.json({ error: 'TIMEZONE_MUST_BE_ASIA_SHANGHAI' }, 400);

    const nowMs = now();
    const { startMs, endMs } = shanghaiDayRangeUtc(date);
    const sessions = await storage.sessionsOverlapping(startMs, endMs);
    const segMap = await storage.segmentsForSessions(sessions.map((s) => s.id));
    const active = await storage.getActiveSession('owner');
    const revision = await storage.maxEventId();
    // running 会话的 active_seconds 是随 generated_at 变化的暂算值（非事件驱动），
    // 而 revision 只随事件（pause/resume/stop 等）递增。running 期间 revision 不变但
    // 响应体秒数在涨：若继续用 date-revision 作 ETag，带 If-None-Match 的 Agent 会
    // 拿到 304 却丢失正在增长的暂算秒数。故 running 期间禁用 304 重验证、不设 ETag
    // （Cache-Control 已是 no-cache，每次仍会带请求 revalidate，但拿回完整 200 体）。
    const runningNow = active?.session.status === 'running';
    const etag = runningNow ? null : `W/"${date}-${revision}"`;

    const inm = c.req.header('if-none-match');
    if (etag && inm && inm === etag) {
      c.header('ETag', etag);
      return c.body(null, 304);
    }

    const summary = buildDailySummary({
      date,
      sessions,
      segmentsBySession: segMap,
      adjustments: await storage.adjustmentsSince(startMs),
      revision,
      generatedAtMs: nowMs,
      activeSession: active?.session ?? null,
      activeSegments: active?.segments ?? [],
      minSegmentMs: config.minSegmentMs,
    });
    if (etag) c.header('ETag', etag);
    return c.json(summary);
  });

  /* ---------- 凭据管理（owner） ---------- */

  app.get('/api/v1/credentials', requireOwner(storage), async (c) =>
    c.json(
      (await storage.listCredentials()).map((cr) => ({
        id: cr.id,
        name: cr.name,
        scope: cr.scope,
        revoked: cr.revokedAtMs !== null,
        created_at: toIso(cr.createdAtMs),
      })),
    ),
  );

  const CredSchema = z.object({ name: z.string().min(1).max(64) });

  app.post('/api/v1/credentials', requireOwner(storage), async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = CredSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const token = generateToken('clk');
    const id = ulid(now());
    await storage.createCredential({
      id,
      name: parsed.data.name,
      scope: 'read_only',
      tokenSha256: await sha256hex(token),
      revokedAtMs: null,
      createdAtMs: now(),
    });
    await storage.appendAudit('owner', 'credential_create', id, JSON.stringify({ name: parsed.data.name }), now());
    // token 只显示一次
    return c.json({ id, name: parsed.data.name, token }, 201);
  });

  app.post('/api/v1/credentials/:id/revoke', requireOwner(storage), async (c) => {
    const id0 = paramId(c);
    if (!id0) return c.json({ error: 'INVALID_ID' }, 400);
    const id = id0;
    await storage.revokeCredential(id, now());
    await storage.appendAudit('owner', 'credential_revoke', id, null, now());
    return c.json({ ok: true });
  });

  /* ---------- 导出（owner） ---------- */

  app.get('/api/v1/export/events.jsonl', requireOwner(storage), async (c) => {
    const lines = (await storage.allEvents()).map(eventToLine);
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="clock-events.jsonl"');
    return c.body(lines.join('\n') + (lines.length ? '\n' : ''));
  });

  /* ---------- 手动备份（owner）：按需触发一次 R2 备份，返回结果 ---------- */

  app.post('/api/v1/admin/backup', requireOwner(storage), async (c) => {
    if (!deps.backupBucket) return c.json({ error: 'BACKUP_NOT_CONFIGURED' }, 501);
    const result = await runBackup(storage, deps.backupBucket, now());
    return c.json({ ok: true, ...result });
  });

  /* ---------- 用户 UI 偏好（owner，多端同步） ---------- */

  app.get('/api/v1/prefs', requireOwner(storage), async (c) => {
    const row = await storage.getPrefs();
    if (!row) return c.json({ prefs: null, updated_at_ms: 0 });
    return c.json({ prefs: JSON.parse(row.prefsJson), updated_at_ms: row.updatedAtMs });
  });

  // 偏好是整体覆盖写（last-write-wins）；非会话写操作，不要求幂等键。
  // 体积上限防滥用；键集合由客户端约定，服务端不解释。返回 updated_at_ms 供客户端防回滚。
  app.put('/api/v1/prefs', requireOwner(storage), async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'INVALID_BODY' }, 400);
    const json = JSON.stringify(body);
    if (json.length > 2048) return c.json({ error: 'INVALID_BODY' }, 400);
    const nowMs = now();
    await storage.setPrefs(json, nowMs);
    return c.json({ ok: true, updated_at_ms: nowMs });
  });

  /* ---------- 统一 404：未匹配路径一律 JSON 错误体（含 /api/* 未知端点） ---------- */

  app.notFound((c) => c.json({ error: 'NOT_FOUND' }, 404));

  function sessionResponse(s: import('@clock/shared').SessionRow) {
    return {
      session_id: s.id,
      subject_id: s.subjectId,
      status: s.status,
      intent_note: s.intentNote,
      end_note: s.endNote,
      end_reason: s.endReason,
      started_at: toIso(s.startedAtMs),
      ended_at: s.endedAtMs !== null ? toIso(s.endedAtMs) : null,
      active_seconds: s.activeSeconds,
    };
  }

  return app;
}

/**
 * Hono 应用：路由 + 校验 + 鉴权 + 幂等。provider-neutral，可跑在 Node/Workers。
 * 领域规则全部来自 @clock/shared；持久化通过 Storage 接口（全异步）。
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Storage } from './repo/storage.js';
import type { AppConfig } from './config.js';
import {
  OWNER_COOKIE,
  generateToken,
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
import { createConchLlmClient, ConchLlmError, type ConchLlmClient } from './conch-client.js';
import {
  TIMEZONE,
  buildDailySummary,
  isValidShanghaiDate,
  shanghaiDayRangeUtc,
  shanghaiToday,
  toIso,
  utcMsToShanghaiDate,
  computeActiveSeconds,
  isCountedSegment,
  buildConchContext,
  parseConchLlmOutput,
  CONCH_SYSTEM_PROMPT,
} from '@clock/shared';
import { decryptAiSecret, encryptAiSecret } from './ai-secret.js';


const IdempotencyKeySchema = z.string().min(8).max(64);
const NoteSchema = z.string().max(200);
const PROJECT_COLOR_IDS = ['blue', 'teal', 'violet', 'amber', 'coral', 'indigo', 'cyan'] as const;

export interface AppDeps {
  storage: Storage;
  config: AppConfig;
  /** 可注入时钟，测试用 */
  now?: () => number;
  /** 限流参数覆盖（测试注入；生产默认登录 5/min，API 300/min） */
  rateLimits?: { loginMaxPerMin?: number; apiMaxPerMin?: number };
  /** R2 备份桶（仅 Workers 环境注入；Node 本地无 R2 时手动备份端点返回 501） */
  backupBucket?: import('./backup.js').BackupBucket;
  /** AI assistant client (test injection; explicit null forces an unconfigured response). */
  conchLlm?: ConchLlmClient | null;
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
    const actor = owner?.actor ?? clientIp((name) => c.req.header(name));
    if (!apiLimiter.allow(actor, now())) return c.json({ error: 'RATE_LIMITED' }, 429);
    await next();
  });

  // Dynamic facts are never served from stale caches; daily reports retain ETag revalidation.
  app.use('/api/*', async (c, next) => {
    await next();
    const path = c.req.path;
    if (path === '/api/v1/projects' && c.req.method === 'GET') {
      c.header('Cache-Control', 'private, no-cache, must-revalidate');
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
   * 契约：
   * - 所有会话写操作（start/pause/resume/stop/switch/void/note/retime/adjust-start）
   *   必须携带 Idempotency-Key（8–64 字符），缺失返回 400 IDEMPOTENCY_KEY_REQUIRED。
   * - 服务端按「端点:键」保存响应 24h；同键重试回放原状态码与原响应体，
   *   并带 Idempotent-Replay: true（参考 IETF idempotency-key 草案与 Stripe 语义）。
   * - auth endpoints are connection management and are rate limited separately.
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
    if (config.isProduction) return c.json({ error: 'OWNER_BOOTSTRAP_REQUIRED' }, 503);
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
      serializeCookie(OWNER_COOKIE, token, { maxAgeSec: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure ?? config.isProduction }),
    );
    return c.json({ ok: true });
  }

  app.post('/api/v1/auth/logout', requireOwner(storage), async (c) => {
    const raw = c.req.header('cookie') ?? '';
    const match = raw.match(/clock_session=([^;]+)/);
    if (match) await storage.deleteOwnerSession(await sha256hex(decodeURIComponent(match[1])));
    c.header('Set-Cookie', serializeCookie(OWNER_COOKIE, '', { maxAgeSec: 0, secure: config.cookieSecure ?? config.isProduction }));
    return c.json({ ok: true });
  });

  app.get('/api/v1/auth/me', async (c) => {
    const authenticated = (await getOwnerAuth(c, storage)) !== null;
    const setupDone = (await storage.getOwnerPasswordHash()) !== null;
    return c.json({
      authenticated,
      setup_done: setupDone,
      bootstrap_required: config.isProduction && !setupDone && !config.initialOwnerPin,
    });
  });

  /* ---------- owner-only reads: self-hosted deployments are private by default ---------- */

  function projectResponse(project: import('@clock/shared').SubjectDef) {
    return {
      subject_id: project.id,
      display_name: project.displayName,
      aggregate_group: project.aggregateGroup,
      color_id: project.colorId,
      sort_order: project.sortOrder,
      archived_at: project.archivedAtMs ? toIso(project.archivedAtMs) : null,
    };
  }

  app.get('/api/v1/projects', requireOwner(storage), async (c) =>
    c.json((await storage.listProjects(c.req.query('include_archived') === 'true')).map(projectResponse)),
  );
  // Compatibility alias for integrations; it has the same private owner-only policy.
  app.get('/api/v1/subjects', requireOwner(storage), async (c) => c.json((await storage.listProjects()).map(projectResponse)));

  const ProjectSchema = z.object({
    display_name: z.string().trim().min(1).max(80),
    aggregate_group: z.string().trim().max(60).nullable().optional(),
    color_id: z.enum(PROJECT_COLOR_IDS).default('blue'),
    sort_order: z.number().int().min(0).max(10000).default(100),
  });
  app.post('/api/v1/projects', requireOwner(storage), async (c) => {
    const body = ProjectSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const project = { id: ulid(now()).toLowerCase(), displayName: body.data.display_name, aggregateGroup: body.data.aggregate_group?.trim() || null, colorId: body.data.color_id, sortOrder: body.data.sort_order };
    await storage.createProject(project);
    await storage.appendAudit('owner', 'project_create', project.id, null, now());
    return c.json(projectResponse(project), 201);
  });
  app.put('/api/v1/projects/:id', requireOwner(storage), async (c) => {
    const id = paramId(c);
    const body = ProjectSchema.safeParse(await c.req.json().catch(() => null));
    if (!id || !body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const existing = await storage.getProject(id);
    if (!existing) return c.json({ error: 'PROJECT_NOT_FOUND' }, 404);
    const patch = { displayName: body.data.display_name, aggregateGroup: body.data.aggregate_group?.trim() || null, colorId: body.data.color_id, sortOrder: body.data.sort_order };
    await storage.updateProject(id, patch);
    await storage.appendAudit('owner', 'project_update', id, null, now());
    return c.json(projectResponse({ ...existing, ...patch }));
  });
  app.delete('/api/v1/projects/:id', requireOwner(storage), async (c) => {
    const id = paramId(c);
    if (!id) return c.json({ error: 'INVALID_ID' }, 400);
    const result = await storage.archiveProject(id, now());
    if (result === 'not_found') return c.json({ error: 'PROJECT_NOT_FOUND' }, 404);
    if (result === 'active_session') return c.json({ error: 'PROJECT_ACTIVE_SESSION', message: 'Stop or pause and switch the active session before archiving this project.' }, 409);
    await storage.appendAudit('owner', 'project_archive', id, null, now());
    return c.json({ ok: true, archived: true });
  });

  /* ---------- state（前端恢复用；公开只读） ---------- */

  app.get('/api/v1/state', requireOwner(storage), async (c) => {
    const nowMs = now();
    const revision = await storage.maxEventId();
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
      revision,
      generatedAtMs: nowMs,
      activeSession: active?.session ?? null,
      activeSegments: active?.segments ?? [],
      minSegmentMs: config.minSegmentMs,
      projects: await storage.listProjects(true),
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
      /** Event watermark for clients to invalidate cached assistant output. */
      revision,
    });
  });

  /* ---------- 写路径 ---------- */

  const StartSchema = z.object({
    subject_id: z.string().min(1).max(64),
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
      const project = await storage.getProject(body.data.subject_id);
      if (!project || project.archivedAtMs) return { status: 422, body: { error: 'PROJECT_UNAVAILABLE' } };
      const nowMs = now();
      const id = ulid(nowMs);
      const session = await storage.createSession({
        id,
        userId: 'owner',
        subjectId: body.data.subject_id,
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
    subject_id: z.string().min(1).max(64),
    intent_note: NoteSchema.optional().nullable(),
  });

  /** Atomic project switch: stop the current session then start the next. */
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
      const project = await storage.getProject(body.data.subject_id);
      if (!project || project.archivedAtMs) return { status: 422, body: { error: 'PROJECT_UNAVAILABLE' } };
      const nowMs = now();
      await storage.stopSession(id, nowMs, 'subject_switch', `switch-stop:${c.req.header('idempotency-key')}`);
      const newId = ulid(nowMs);
      const newSession = await storage.createSession({
        id: newId,
        userId: 'owner',
        subjectId: body.data.subject_id,
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

  app.get('/api/v1/sessions', requireOwner(storage), async (c) => {
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
        end_note: s.endNote ?? null,
        segments: clippedSegs,
      };
    });
    return c.json({ date, timezone: TIMEZONE, sessions: entries });
  });

  /* ---------- daily-summary（公开只读，带 ETag） ---------- */

  app.get('/api/v1/daily-summary', requireOwner(storage), async (c) => {
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
      projects: await storage.listProjects(true),
    });
    if (etag) c.header('ETag', etag);
    return c.json(summary);
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

  /* ---------- AI assistant configuration (owner-only, secret never leaves server) ---------- */

  app.get('/api/v1/ai-config', requireOwner(storage), async (c) => {
    const row = await storage.getAiConfig();
    return c.json(
      row
        ? { configured: true, source: 'persisted', provider: row.provider, api_base: row.apiBase, model: row.model, updated_at: toIso(row.updatedAtMs) }
        : config.conch
          ? { configured: true, source: 'environment', provider: 'environment', api_base: config.conch.apiBase, model: config.conch.model, encryption_available: Boolean(config.aiEncryptionKey) }
          : { configured: false, source: 'none', encryption_available: Boolean(config.aiEncryptionKey) },
    );
  });
  const AiConfigSchema = z.object({
    provider: z.enum(['siliconflow', 'openai-compatible']),
    api_base: z.string().url().max(300),
    model: z.string().trim().min(1).max(160),
    api_key: z.string().min(8).max(2048),
  });
  app.put('/api/v1/ai-config', requireOwner(storage), async (c) => {
    if (!config.aiEncryptionKey) return c.json({ error: 'AI_CONFIG_ENCRYPTION_REQUIRED' }, 503);
    const body = AiConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    let apiBase: string;
    try {
      const url = new URL(body.data.api_base);
      if (!isSafeAiEndpoint(url, config.isProduction)) {
        return c.json({ error: 'AI_API_BASE_MUST_USE_HTTPS' }, 400);
      }
      apiBase = url.toString().replace(/\/+$/, '');
    } catch {
      return c.json({ error: 'INVALID_BODY' }, 400);
    }
    const nowMs = now();
    await storage.setAiConfig({
      provider: body.data.provider,
      apiBase,
      model: body.data.model,
      encryptedApiKey: await encryptAiSecret(body.data.api_key, config.aiEncryptionKey),
      updatedAtMs: nowMs,
    });

    await storage.appendAudit('owner', 'ai_config_update', 'ai_config', JSON.stringify({ provider: body.data.provider, model: body.data.model }), nowMs);
    return c.json({ ok: true, configured: true });
  });

  function isSafeAiEndpoint(url: URL, isProduction: boolean): boolean {
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (url.protocol === 'http:' && !isProduction && (host === 'localhost' || host === '127.0.0.1')) return true;
    if (url.protocol !== 'https:' || !host || host === 'localhost' || host.endsWith('.localhost')) return false;
    if (host === '::1' || host === '::' || host.startsWith('::ffff:') || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const octets = ipv4.slice(1).map(Number);
      if (octets.some((n) => n > 255) || octets[0] === 10 || octets[0] === 127 || octets[0] === 0 || octets[0] >= 224 || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && (octets[1] === 0 || octets[1] === 168))) return false;
    }
    return true;
  }

  /* ---------- AI assistant recommendations (owner-only; notes and secrets are never logged) ---------- */

  const ConchAskSchema = z.object({ window: z.enum(['all', '30d', '7d']) });
  const conchLimiter = new RateLimiter(3_600_000, 20);

  app.post('/api/v1/conch/ask', requireOwner(storage), async (c) => {
    const persisted = await storage.getAiConfig();
    if ((!persisted && !config.conch) || deps.conchLlm === null) return c.json({ error: 'AI_NOT_CONFIGURED' }, 503);
    let runtimeConfig = config.conch;
    if (persisted) {
      if (!config.aiEncryptionKey) return c.json({ error: 'AI_CONFIG_ENCRYPTION_REQUIRED' }, 503);
      try {
        runtimeConfig = { apiBase: persisted.apiBase, apiKey: await decryptAiSecret(persisted.encryptedApiKey, config.aiEncryptionKey), model: persisted.model, thinkingBudget: 0 };
      } catch {
        return c.json({ error: 'AI_CONFIG_UNREADABLE' }, 503);
      }
    }
    const llm = deps.conchLlm ?? createConchLlmClient(runtimeConfig!);
    const raw = await c.req.json().catch(() => null);
    const body = ConchAskSchema.safeParse(raw);
    if (!body.success) return c.json({ error: 'INVALID_WINDOW' }, 400);
    const ip = clientIp((name) => c.req.header(name));
    if (!conchLimiter.allow(`conch:${ip}`, now())) return c.json({ error: 'RATE_LIMITED' }, 429);

    const nowMs = now();
    // 全量一次取（ended_at 索引 range + 活动部分索引），窗口过滤在 builder 内，
    // 保证活动门槛（全量/近7天）数据完整。
    const sessions = await storage.sessionsOverlapping(0, nowMs + 1);
    const segMap = await storage.segmentsForSessions(sessions.map((s) => s.id));
    const ctx = buildConchContext({
      nowMs,
      window: body.data.window,
      sessions,
      segmentsBySession: segMap,
      minSegmentMs: config.minSegmentMs,
      projects: await storage.listProjects(true),
    });
    const revision = await storage.maxEventId();
    const baseResp = {
      window: body.data.window,
      generated_at: toIso(nowMs),
      revision,
      model: runtimeConfig!.model,
    };

    // No active projects: skip the provider request.
    if (ctx.active.length === 0) {
      return c.json({ ...baseResp, subjects: [], skipped: ctx.skipped });
    }

    let content: string;
    try {
      const result = await llm.ask({ system: CONCH_SYSTEM_PROMPT, user: ctx.userPrompt });
      content = result.content;
    } catch (err) {
      if (err instanceof ConchLlmError && err.kind === 'timeout') {
        return c.json({ error: 'LLM_TIMEOUT' }, 504);
      }
      return c.json({ error: 'LLM_UPSTREAM' }, 502);
    }

    const recs = parseConchLlmOutput(content, ctx.active);
    if (!recs) return c.json({ error: 'LLM_OUTPUT_INVALID' }, 422);

    const projects = await storage.listProjects(true);
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const subjects = recs.map((rec) => {
      const def = projectsById.get(rec.subject_id);
      if (!def) return null;
      const subSessions = sessions.filter((s) => s.subjectId === rec.subject_id && s.status !== 'voided');
      let lastActiveMs = 0;
      for (const s of subSessions) lastActiveMs = Math.max(lastActiveMs, s.endedAtMs ?? s.startedAtMs);
      return {
        ...rec,
        display_name: def.displayName,
        running_now: subSessions.some((s) => s.status === 'running'),
        last_active_date: utcMsToShanghaiDate(lastActiveMs > 0 ? lastActiveMs : nowMs),
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null);

    return c.json({ ...baseResp, subjects, skipped: ctx.skipped });
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

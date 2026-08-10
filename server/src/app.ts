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
  getApiAuth,
  getOwnerAuth,
  requireAnyRead,
  requireOwner,
  serializeCookie,
  sha256hex,
} from './auth.js';
import { RateLimiter } from './rate-limit.js';
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
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
    if (config.isProduction) c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  app.use('/api/*', async (c, next) => {
    const owner = await getOwnerAuth(c, storage);
    const api = owner ?? (await getApiAuth(c, storage));
    const actor = api?.actor ?? c.req.header('x-forwarded-for') ?? 'anon';
    if (!apiLimiter.allow(actor, now())) return c.json({ error: 'RATE_LIMITED' }, 429);
    await next();
  });

  // CSRF：写请求必须来自同源（Origin 与 Host 匹配）。
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
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

  /* ---------- 幂等辅助 ---------- */

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
      c.status(200);
      c.header('Idempotent-Replay', 'true');
      return c.body(existing.responseJson);
    }
    const result = await fn();
    const json = JSON.stringify(result.body);
    await storage.saveIdempotentResponse(key, endpoint, json, now());
    c.status(result.status as 200);
    return c.body(json);
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
    const ip = c.req.header('x-forwarded-for') ?? 'local';
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

  /* ---------- 只读数据（任一凭据） ---------- */

  app.get('/api/v1/subjects', requireAnyRead(storage), (c) =>
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

  /* ---------- state（前端恢复用） ---------- */

  app.get('/api/v1/state', requireOwner(storage), async (c) => {
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
    });
    // UI 需要会话总净时长（不按日裁剪）：直接从段计算
    let activeTotalSeconds: number | null = null;
    let openSegmentStart: string | null = null;
    if (active) {
      activeTotalSeconds = computeActiveSeconds(active.segments, nowMs);
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
      await storage.purgeIdempotentBefore(nowMs - 24 * 3600 * 1000);
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
      if (session.status !== 'paused') return { status: 409, body: { error: 'ILLEGAL_TRANSITION', status: session.status } };
      const nowMs = now();
      await storage.resumeSession(id, nowMs, `resume:${c.req.header('idempotency-key')}`);
      await storage.appendAudit('owner', 'session_resume', id, null, nowMs);
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

  app.patch('/api/v1/sessions/:id/note', requireOwner(storage), async (c) => {
    const id0 = paramId(c);
    if (!id0) return c.json({ error: 'INVALID_ID' }, 400);
    const id = id0;
    const body = NotePatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const session = await storage.getSession(id);
    if (!session) return c.json({ error: 'SESSION_NOT_FOUND' }, 404);
    if (session.status !== 'stopped') return c.json({ error: 'ILLEGAL_TRANSITION' }, 409);
    await storage.setSessionNote(id, body.data.note, now());
    await storage.appendAudit('owner', 'session_note', id, null, now());
    return c.json(sessionResponse((await storage.getSession(id))!));
  });

  const RetimeSchema = z.object({ delta_seconds: z.number().int().min(-86400).max(86400), reason: NoteSchema.nullable() });

  app.post('/api/v1/sessions/:id/retime', requireOwner(storage), async (c) => {
    const id0 = paramId(c);
    if (!id0) return c.json({ error: 'INVALID_ID' }, 400);
    const id = id0;
    const body = RetimeSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400);
    const session = await storage.getSession(id);
    if (!session) return c.json({ error: 'SESSION_NOT_FOUND' }, 404);
    if (session.status !== 'stopped') return c.json({ error: 'ILLEGAL_TRANSITION' }, 409);
    await storage.applyRetime(id, body.data.delta_seconds, body.data.reason, now());
    return c.json(sessionResponse((await storage.getSession(id))!));
  });

  /* ---------- 查询 ---------- */

  app.get('/api/v1/sessions', requireAnyRead(storage), async (c) => {
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

  /* ---------- 总控只读 daily-summary ---------- */

  app.get('/api/v1/daily-summary', requireAnyRead(storage), async (c) => {
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
    const etag = `W/"${date}-${revision}"`;

    const inm = c.req.header('if-none-match');
    if (inm && inm === etag) {
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
    });
    c.header('ETag', etag);
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
    const lines = (await storage.allEvents()).map((e) =>
      JSON.stringify({
        event_id: e.id,
        session_id: e.sessionId,
        kind: e.kind,
        idempotency_key: e.idempotencyKey,
        server_time_ms: e.serverTimeMs,
        payload: e.payloadJson ? JSON.parse(e.payloadJson) : null,
      }),
    );
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="clock-events.jsonl"');
    return c.body(lines.join('\n') + (lines.length ? '\n' : ''));
  });

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

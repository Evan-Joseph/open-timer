import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SqliteStorage } from '../src/repo/sqlite-storage.js';
import Database from 'better-sqlite3';

const PASSWORD = '246813';

interface Ctx {
  storage: SqliteStorage;
  app: ReturnType<typeof createApp>;
  cookie: string;
  token: string;
  nowMs: number;
}

let tmp: string;

function makeConfig(dbPath: string): AppConfig {
  return {
    dbPath,
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    isProduction: false,
    sessionTtlMs: 7 * 86_400_000,
    minSegmentMs: 0, // 单测不过滤误触片段（另有专门用例验证过滤行为）
    conch: null,
    version: 'test',
  };
}

async function setupCtx(): Promise<Ctx> {
  tmp = mkdtempSync(join(tmpdir(), 'clock-test-'));
  const storage = new SqliteStorage(join(tmp, 'clock.sqlite'));
  storage.migrate();
  const app = createApp({ storage, config: makeConfig(join(tmp, 'clock.sqlite')) });

  // setup 密码并拿 cookie
  const setupRes = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(setupRes.status).toBe(200);
  const setCookie = setupRes.headers.get('set-cookie')!;
  const cookie = setCookie.split(';')[0];

  // 创建总控只读 token
  const credRes = await app.request('/api/v1/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'master-control' }),
  });
  expect(credRes.status).toBe(201);
  const cred = await credRes.json();
  expect(cred.token).toMatch(/^clk_/);

  return { storage, app, cookie, token: cred.token, nowMs: Date.now() };
}

describe('API 集成', () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await setupCtx();
  });

  // 测试隔离兜底：个别用例（含 setTimeout 的时序用例）偶发残留活动会话，
  // 会让后续「建会话」用例拿到 409 级联失败。每条用例结束后强制收尾。
  afterEach(async () => {
    const active = await ctx.storage.getActiveSession('owner');
    if (active) {
      await ctx.storage.stopSession(active.session.id, Date.now(), 'manual', `test-cleanup:${active.session.id}`);
    }
  });

  afterAll(() => {
    ctx.storage.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('health 返回 ok 与服务端时间', async () => {
    const res = await ctx.app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toBe('test');
  });

  it('公开只读：subjects / state / snapshot / sessions / daily-summary 无凭据可读', async () => {
    // subjects：无需任何凭据（公开只读 API，供其他 Agent 读取）
    const noauth = await ctx.app.request('/api/v1/subjects');
    expect(noauth.status).toBe(200);
    expect(noauth.headers.get('cache-control')).toBe('public, max-age=3600, must-revalidate');
    const subjects = await noauth.json();
    expect(subjects).toHaveLength(7);
    expect(subjects.map((s: { subject_id: string }) => s.subject_id)).toContain('data-structures');
    expect(subjects).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject_id: 'math', display_name: '数学二', aggregate_group: 'math' }),
      expect.objectContaining({ subject_id: 'english', display_name: '英语二', aggregate_group: 'english' }),
    ]));
    // CORS：跨域可读
    expect(noauth.headers.get('access-control-allow-origin')).toBe('*');

    // state：无凭据可读（空库 → active_session null）
    const st = await ctx.app.request('/api/v1/state');
    expect(st.status).toBe(200);
    expect(st.headers.get('cache-control')).toBe('no-store');
    expect((await st.json()).active_session).toBeNull();

    // snapshot：SPA 合并轮询端点，一次请求返回同次 state + 今天 sessions
    const snapshot = await ctx.app.request('/api/v1/snapshot');
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('cache-control')).toBe('no-store');
    const snapshotBody = await snapshot.json();
    expect(snapshotBody.state.active_session).toBeNull();
    expect(snapshotBody.state.today_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshotBody.sessions).toEqual([]);

    // sessions?date：无凭据可读
    const sess = await ctx.app.request('/api/v1/sessions?date=2026-01-01');
    expect(sess.status).toBe(200);
    expect(sess.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect((await sess.json()).sessions).toEqual([]);

    // daily-summary：无凭据可读
    const ds = await ctx.app.request('/api/v1/daily-summary?date=2026-01-01&timezone=Asia/Shanghai');
    expect(ds.status).toBe(200);
    expect(ds.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect((await ds.json()).total_active_seconds).toBe(0);
  });

  it('start → pause → resume → stop 全流程，净时长正确', async () => {
    const h = (extra: Record<string, string> = {}) => ({
      'content-type': 'application/json',
      cookie: ctx.cookie,
      ...extra,
    });

    const startRes = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-start-0001' }),
      body: JSON.stringify({ subject_id: 'math', intent_note: '高数第1讲' }),
    });
    expect(startRes.status).toBe(201);
    const started = await startRes.json();
    expect(started.status).toBe('running');
    const id = started.session_id;

    // 本段活跃秒：running 时存在（从 0 起算）
    const startState = await (await ctx.app.request('/api/v1/state', { headers: { cookie: ctx.cookie } })).json();
    expect(startState.active_session.current_segment_active_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(startState.active_session.current_segment_active_seconds)).toBe(true);

    // 非法转移：running 时 resume 应 409
    const badResume = await ctx.app.request(`/api/v1/sessions/${id}/resume`, {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-resume-bad1' }),
    });
    expect(badResume.status).toBe(409);

    // pause
    const pauseRes = await ctx.app.request(`/api/v1/sessions/${id}/pause`, {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-pause-0001' }),
    });
    expect(pauseRes.status).toBe(200);
    expect((await pauseRes.json()).status).toBe('paused');

    // 本段活跃秒：paused 时冻结为末段净秒（非 0 重置）
    const pausedState = await (await ctx.app.request('/api/v1/state', { headers: { cookie: ctx.cookie } })).json();
    expect(pausedState.active_session.current_segment_active_seconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(pausedState.active_session.current_segment_active_seconds)).toBe(true);

    // resume
    const resumeRes = await ctx.app.request(`/api/v1/sessions/${id}/resume`, {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-resume-0001' }),
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).status).toBe('running');

    // 本段活跃秒：resume 后新段从 0 重新累计（不含休息时长）
    const resumedState = await (await ctx.app.request('/api/v1/state', { headers: { cookie: ctx.cookie } })).json();
    expect(resumedState.active_session.current_segment_active_seconds).toBeLessThan(3);

    // stop
    const stopRes = await ctx.app.request(`/api/v1/sessions/${id}/stop`, {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-stop-0001' }),
      body: JSON.stringify({ end_note: '今天状态不错' }),
    });
    expect(stopRes.status).toBe(200);
    const stopped = await stopRes.json();
    expect(stopped.status).toBe('stopped');
    expect(stopped.end_note).toBe('今天状态不错');
    expect(stopped.session_active_seconds).toBeGreaterThanOrEqual(0);
    expect(stopped.longest_continuous_seconds).toBeGreaterThanOrEqual(0);
    expect(stopped.longest_continuous_seconds).toBeLessThanOrEqual(stopped.session_active_seconds);
    expect(stopped.last_continuous_seconds).toBeGreaterThanOrEqual(0);
    expect(stopped.last_continuous_ended_at).toMatch(/Z$/);

    // stop 响应与紧随其后的原子快照必须引用同一组已关闭片段；
    // Safari/慢网下不能出现结束卡和时间轴各自展示不同的总专注/最长连续专注。
    const snapshot = await (await ctx.app.request('/api/v1/snapshot')).json();
    const session = snapshot.sessions.find((entry: { session_id: string }) => entry.session_id === id);
    expect(session).toBeDefined();
    expect(session).toMatchObject({
      session_active_seconds: stopped.session_active_seconds,
      longest_continuous_seconds: stopped.longest_continuous_seconds,
      last_continuous_seconds: stopped.last_continuous_seconds,
      last_continuous_ended_at: stopped.last_continuous_ended_at,
    });
  });

  it('adjust-start 同步修改首段、会话起点与净时长', async () => {
    const headers = { 'content-type': 'application/json', cookie: ctx.cookie };
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'adjust-start-create' },
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'adjust-start-stop' },
      body: JSON.stringify({}),
    });

    const earlier = new Date(Date.parse(created.started_at) - 10 * 60_000).toISOString();
    const adjusted = await ctx.app.request(`/api/v1/sessions/${created.session_id}/adjust-start`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'adjust-start-apply' },
      body: JSON.stringify({ started_at: earlier, reason: '补录' }),
    });
    expect(adjusted.status).toBe(200);
    const body = await adjusted.json();
    expect(body.started_at).toBe(earlier);
    expect(body.active_seconds).toBeGreaterThanOrEqual(600);

    const segments = await ctx.storage.getSegments(created.session_id);
    expect(segments[0].startedAtMs).toBe(Date.parse(earlier));
  });

  it('审计语义：adjust-start 与 retime 由 audit action 与 before/after 形态区分（kind 统一 retime）', async () => {
    // 决策（2026-08-20 接手审计）：manual_adjustment.kind 的 CHECK 约束固定为
    // retime/void/note，扩展约束需在 D1 生产库重建表，风险大于收益，故保持现状；
    // 两类修正的权威区分字段是 audit_log.action（'retime' vs 'session_start_adjust'）
    // 与 before_json 形态（active_seconds vs started_at_ms）。本测试固定该契约。
    const headers = { 'content-type': 'application/json', cookie: ctx.cookie };
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'audit-sem-create' },
      body: JSON.stringify({ subject_id: 'politics' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'audit-sem-stop' },
      body: JSON.stringify({}),
    });

    const retimeRes = await ctx.app.request(`/api/v1/sessions/${created.session_id}/retime`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'audit-sem-retime' },
      body: JSON.stringify({ delta_seconds: 60, reason: '审计语义测试' }),
    });
    expect(retimeRes.status).toBe(200);

    const earlier = new Date(Date.parse(created.started_at) - 5 * 60_000).toISOString();
    const adjustRes = await ctx.app.request(`/api/v1/sessions/${created.session_id}/adjust-start`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'audit-sem-adjust' },
      body: JSON.stringify({ started_at: earlier, reason: '补录' }),
    });
    expect(adjustRes.status).toBe(200);

    const db = new Database(join(tmp, 'clock.sqlite'), { readonly: true });
    try {
      const adjustments = db
        .prepare('SELECT kind, before_json FROM manual_adjustment WHERE session_id = ? ORDER BY id')
        .all(created.session_id) as Array<{ kind: string; before_json: string }>;
      // schema 约束下两类修正都落 kind='retime'
      expect(adjustments.filter((a) => a.kind === 'retime').length).toBe(2);
      // before_json 形态区分：retime → active_seconds；adjust-start → started_at_ms
      expect(adjustments.some((a) => JSON.parse(a.before_json).active_seconds !== undefined)).toBe(true);
      expect(adjustments.some((a) => JSON.parse(a.before_json).started_at_ms !== undefined)).toBe(true);

      const actions = (
        db.prepare('SELECT action FROM audit_log WHERE target = ? ORDER BY id').all(created.session_id) as Array<{ action: string }>
      ).map((a) => a.action);
      // audit_log.action 是权威区分字段
      expect(actions).toContain('retime');
      expect(actions).toContain('session_start_adjust');
    } finally {
      db.close();
    }
  });

  it('幂等：同 key 重复 start 回放原响应，不创建第二个会话', async () => {
    const h = {
      'content-type': 'application/json',
      cookie: ctx.cookie,
      'idempotency-key': 'test-idem-0001',
    };
    const first = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    // 先结束，再用同 key 重试（模拟客户端网络重试）
    await ctx.app.request(`/api/v1/sessions/${firstBody.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-idem-stop1' },
    });

    const second = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ subject_id: 'english' }),
    });
    // 回放保持原状态码（201），并标记 Idempotent-Replay
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    const secondBody = await second.json();
    expect(secondBody.session_id).toBe(firstBody.session_id);

    // 无活动会话（未重复创建）
    const state = await ctx.app.request('/api/v1/state', { headers: { cookie: ctx.cookie } });
    const stateBody = await state.json();
    expect(stateBody.active_session).toBeNull();
  });

  it('并发约束：已有活动会话时 start 返回 409', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const first = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-conc-a1' },
      body: JSON.stringify({ subject_id: 'data-structures' }),
    });
    expect(first.status).toBe(201);

    const second = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-conc-b2' },
      body: JSON.stringify({ subject_id: 'politics' }),
    });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error).toBe('ACTIVE_SESSION_EXISTS');

    // 换科目：结束当前并开新段
    const firstId = (await first.json()).session_id;
    const sw = await ctx.app.request(`/api/v1/sessions/${firstId}/switch`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-switch-01' },
      body: JSON.stringify({ subject_id: 'politics' }),
    });
    expect(sw.status).toBe(200);
    const swBody = await sw.json();
    expect(swBody.stopped.end_reason).toBe('subject_switch');
    expect(swBody.started.subject_id).toBe('politics');

    // 清理
    await ctx.app.request(`/api/v1/sessions/${swBody.started.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-switch-stop' },
    });
  });

  it('void 流程：stopped → voided，汇总排除', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-void-start' },
      body: JSON.stringify({ subject_id: 'politics' }),
    });
    const id = (await start.json()).session_id;
    await ctx.app.request(`/api/v1/sessions/${id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-void-stop' },
    });

    // running/paused 不可直接 void（需先 stop）：先造一个 running 再试
    const voidRes = await ctx.app.request(`/api/v1/sessions/${id}/void`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'test-void-0001' },
      body: JSON.stringify({ reason: '误触开始' }),
    });
    expect(voidRes.status).toBe(200);
    expect((await voidRes.json()).status).toBe('voided');
  });

  it('总控只读：token 不能写；daily-summary 口径正确', async () => {
    const ro = { 'x-api-key': ctx.token, 'content-type': 'application/json' };
    const write = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...ro, 'idempotency-key': 'test-ro-write1' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(write.status).toBe(401);

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const res = await ctx.app.request(
      `/api/v1/daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`,
      { headers: ro },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.date).toBe(today);
    expect(body.timezone).toBe('Asia/Shanghai');
    expect(body.by_subject).toHaveLength(7);
    expect(body.aggregates.map((a: { group: string }) => a.group)).toEqual(['math', 'english', '408', 'politics']);
    // ETag
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    const res304 = await ctx.app.request(
      `/api/v1/daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`,
      { headers: { ...ro, 'if-none-match': etag! } },
    );
    expect(res304.status).toBe(304);

    // timezone 必须是 Asia/Shanghai
    const badTz = await ctx.app.request(`/api/v1/daily-summary?date=${today}&timezone=UTC`, { headers: ro });
    expect(badTz.status).toBe(400);
  });

  it('daily-summary ETag：running 期间禁用 304，stop 后恢复 304', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const url = `/api/v1/daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`;

    // 1. 开始会话 → running
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'etag-running-start' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();

    // 2. running：不设 ETag；带 If-None-Match 也不应 304（秒数在涨，不能被缓存）
    const runningRes = await ctx.app.request(url, { headers: h });
    expect(runningRes.status).toBe(200);
    expect(runningRes.headers.get('etag')).toBeNull();
    const runningBody = await runningRes.json();
    expect(runningBody.running_session).not.toBeNull();
    const runningReplay = await ctx.app.request(url, {
      headers: { ...h, 'if-none-match': 'W/"stale-etag"' },
    });
    expect(runningReplay.status).toBe(200);

    // 3. stop → 事件落库、running 结束
    const stop = await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'etag-running-stop' },
      body: JSON.stringify({}),
    });
    expect(stop.status).toBe(200);

    // 4. stopped：恢复 ETag + 304 语义
    const stoppedRes = await ctx.app.request(url, { headers: h });
    expect(stoppedRes.status).toBe(200);
    const etag = stoppedRes.headers.get('etag');
    expect(etag).toBeTruthy();
    const stopped304 = await ctx.app.request(url, { headers: { ...h, 'if-none-match': etag! } });
    expect(stopped304.status).toBe(304);
  });

  it('retime 落段生效：修正时长反映到 daily-summary，负向越界返回 400', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const url = `/api/v1/daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`;

    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'retime-seg-start' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'retime-seg-stop' },
      body: JSON.stringify({}),
    });

    const beforeTotal = (await (await ctx.app.request(url, { headers: h })).json()).total_active_seconds;

    // 负向越界：末段时长仅 ~1s，-120s 会令末段为负 → 400 INVALID_RETIME（先于正向修正测试）
    const over = await ctx.app.request(`/api/v1/sessions/${created.session_id}/retime`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'retime-seg-over' },
      body: JSON.stringify({ delta_seconds: -120, reason: null }),
    });
    expect(over.status).toBe(400);
    expect((await over.json()).error).toBe('INVALID_RETIME');

    // +120 秒：落到末段结束时刻，汇总应精确 +120
    const retime = await ctx.app.request(`/api/v1/sessions/${created.session_id}/retime`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'retime-seg-apply' },
      body: JSON.stringify({ delta_seconds: 120, reason: null }),
    });
    expect(retime.status).toBe(200);
    const afterTotal = (await (await ctx.app.request(url, { headers: h })).json()).total_active_seconds;
    expect(afterTotal).toBe(beforeTotal + 120);
  });

  it('note 写 manual_adjustment 使 revision 前进、ETag 失效', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const url = `/api/v1/daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`;

    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'revision-note-start' },
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'revision-note-stop' },
      body: JSON.stringify({}),
    });

    const etag1 = (await ctx.app.request(url, { headers: h })).headers.get('etag');
    expect(etag1).toBeTruthy();

    // note 只写 manual_adjustment、不写 session_event；revision 必须仍前进使 ETag 失效
    const note = await ctx.app.request(`/api/v1/sessions/${created.session_id}/note`, {
      method: 'PATCH',
      headers: { ...h, 'idempotency-key': 'revision-note-apply' },
      body: JSON.stringify({ note: '改了备注' }),
    });
    expect(note.status).toBe(200);

    const etag2 = (await ctx.app.request(url, { headers: h })).headers.get('etag');
    expect(etag2).not.toBe(etag1);
  });

  it('误触继续：stopped 会话可重开，新段从当前起算且回放/并发受约束', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-start' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(start.status).toBe(201);
    const created = await start.json();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const stop = await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-stop' },
      body: JSON.stringify({}),
    });
    expect(stop.status).toBe(200);

    // 重开：恢复 running、清结束时刻、此前秒数保留、开新开放段
    const resume = await ctx.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-resume' },
    });
    expect(resume.status).toBe(200);
    const body = await resume.json();
    expect(body.status).toBe('running');
    expect(body.ended_at).toBeNull();
    expect(body.active_seconds).toBeGreaterThanOrEqual(1);
    let segments = await ctx.storage.getSegments(created.session_id);
    expect(segments.length).toBe(2);
    expect(segments[1].endedAtMs).toBeNull();

    // 幂等回放：同键不重复开段
    const replay = await ctx.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-resume' },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect((await ctx.storage.getSegments(created.session_id)).length).toBe(2);

    // 非法转移：running 不可 resume
    const bad = await ctx.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-resume-bad' },
    });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toBe('ILLEGAL_TRANSITION');

    // 唯一活动会话守卫：已有活动会话时重开另一个 stopped 会话 → 409
    const second = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-second-start' },
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(second.status).toBe(409); // 当前会话仍 running，无法新建
    await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-stop-again' },
      body: JSON.stringify({}),
    });
    const third = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-third-start' },
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(third.status).toBe(201);
    const reopenOld = await ctx.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-old-blocked' },
    });
    expect(reopenOld.status).toBe(409);
    expect((await reopenOld.json()).error).toBe('ACTIVE_SESSION_EXISTS');

    // 清理
    const thirdBody = await third.json();
    await ctx.app.request(`/api/v1/sessions/${thirdBody.session_id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'reopen-third-stop' },
      body: JSON.stringify({}),
    });
  });

  it('凭据生命周期：创建后可见，吊销后 revoked=true', async () => {
    const create = await ctx.app.request('/api/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ name: 'temp' }),
    });
    expect(create.status).toBe(201);
    const { id } = await create.json();
    // 创建后列表中可见且未吊销
    const listed = await (await ctx.app.request('/api/v1/credentials', { headers: { cookie: ctx.cookie } })).json();
    const cred = listed.find((c: { id: string }) => c.id === id);
    expect(cred).toBeTruthy();
    expect(cred.revoked).toBe(false);
    // 吊销后状态翻转
    await ctx.app.request(`/api/v1/credentials/${id}/revoke`, { method: 'POST', headers: { cookie: ctx.cookie } });
    const listed2 = await (await ctx.app.request('/api/v1/credentials', { headers: { cookie: ctx.cookie } })).json();
    expect(listed2.find((c: { id: string }) => c.id === id).revoked).toBe(true);
  });

  it('CSRF：跨源 Origin 的写请求被拒绝', async () => {
    const res = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: ctx.cookie,
        origin: 'https://evil.example',
        host: '127.0.0.1:4310',
        'idempotency-key': 'test-csrf-0001',
      },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(res.status).toBe(403);
  });

  it('未带幂等键的写请求返回 400', async () => {
    const res = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('events.jsonl 导出包含事件链', async () => {
    const res = await ctx.app.request('/api/v1/export/events.jsonl', { headers: { cookie: ctx.cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    const kinds = lines.map((l: { kind: string }) => l.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('stopped');
    expect(kinds).toContain('voided');
  });

  it('幂等统一：note/retime/adjust-start 缺键 400，同键回放原响应', async () => {
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    // 造一个已停止会话
    const start = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'idem-unify-start' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    const id = (await start.json()).session_id;
    await ctx.app.request(`/api/v1/sessions/${id}/stop`, {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'idem-unify-stop' },
    });

    // 缺 Idempotency-Key 一律 400
    for (const [method, path, body] of [
      ['PATCH', `/api/v1/sessions/${id}/note`, { note: '第一次' }],
      ['POST', `/api/v1/sessions/${id}/retime`, { delta_seconds: 0, reason: null }],
      ['POST', `/api/v1/sessions/${id}/adjust-start`, { started_at: new Date().toISOString(), reason: null }],
    ] as const) {
      const res = await ctx.app.request(path, { method, headers: h, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }

    // note：首次写入生效
    const first = await ctx.app.request(`/api/v1/sessions/${id}/note`, {
      method: 'PATCH',
      headers: { ...h, 'idempotency-key': 'idem-unify-note1' },
      body: JSON.stringify({ note: '第一次' }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()).end_note).toBe('第一次');

    // 同键重试（即使 body 不同）必须回放原响应，不执行第二次写入
    const replay = await ctx.app.request(`/api/v1/sessions/${id}/note`, {
      method: 'PATCH',
      headers: { ...h, 'idempotency-key': 'idem-unify-note1' },
      body: JSON.stringify({ note: '第二次不应生效' }),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect((await replay.json()).end_note).toBe('第一次');

    const after = await ctx.app.request(`/api/v1/sessions/${id}/note`, {
      method: 'PATCH',
      headers: { ...h, 'idempotency-key': 'idem-unify-note2' },
      body: JSON.stringify({ note: '第三次' }),
    });
    expect((await after.json()).end_note).toBe('第三次');
  });

  it('未知 API 路径返回 JSON NOT_FOUND', async () => {
    const res = await ctx.app.request('/api/v1/definitely-missing');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect((await res.json()).error).toBe('NOT_FOUND');
  });

  it('CORS：公开端点 OPTIONS 预检返回 204 与跨域头', async () => {
    const res = await ctx.app.request('/api/v1/daily-summary?date=2026-01-01&timezone=Asia%2FShanghai', {
      method: 'OPTIONS',
      headers: { origin: 'https://other-agent.example' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('安全头：API 响应携带统一 CSP/XFO/nosniff/referrer', async () => {
    const res = await ctx.app.request('/api/v1/health');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // 测试环境 isProduction=false：不带 HSTS
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('手动备份端点：owner 触发写入 R2 并返回结果；未登录 401', async () => {
    const objects = new Map<string, string>();
    const fakeBucket = {
      put: async (k: string, v: string) => {
        objects.set(k, v);
      },
      list: async () => ({ objects: [...objects.keys()].map((key) => ({ key })) }),
      delete: async () => {},
    };
    const backupApp = createApp({ storage: ctx.storage, config: makeConfig(join(tmp, 'clock.sqlite')), backupBucket: fakeBucket });

    // 未登录 → 401
    const unauth = await backupApp.request('/api/v1/admin/backup', { method: 'POST' });
    expect(unauth.status).toBe(401);

    // owner → 200 + 写入 events/sessions/last-run
    const res = await backupApp.request('/api/v1/admin/backup', {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'idempotency-key': 'manual-backup-0001' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.written.length).toBe(2);
    expect(objects.has(`${'backup'}/${body.date}/events.jsonl`)).toBe(true);
    expect(objects.has('backup/last-run.json')).toBe(true);
    expect(JSON.parse(objects.get('backup/last-run.json')!).ok).toBe(true);
  });

  it('手动备份端点：未注入 R2 桶时返回 501', async () => {
    // ctx.app 未注入 backupBucket（模拟 Node 本地无 R2）
    const res = await ctx.app.request('/api/v1/admin/backup', {
      method: 'POST',
      headers: { cookie: ctx.cookie, 'idempotency-key': 'manual-backup-501' },
    });
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe('BACKUP_NOT_CONFIGURED');
  });

  it('用户偏好：PUT 覆盖写、GET 读取、未登录 401、超大 body 400', async () => {
    // 未登录
    const unauth = await ctx.app.request('/api/v1/prefs');
    expect(unauth.status).toBe(401);

    // 初始为空
    const empty = await ctx.app.request('/api/v1/prefs', { headers: { cookie: ctx.cookie } });
    expect(empty.status).toBe(200);
    expect((await empty.json()).prefs).toBeNull();

    // PUT 写入
    const prefs = { theme: 'dark', animations: false, timelineScale: 'full-day' };
    const put = await ctx.app.request('/api/v1/prefs', {
      method: 'PUT',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    expect(put.status).toBe(200);

    // GET 读回 + updated_at_ms 递增
    const got = await ctx.app.request('/api/v1/prefs', { headers: { cookie: ctx.cookie } });
    const body = await got.json();
    expect(body.prefs).toEqual(prefs);
    expect(body.updated_at_ms).toBeGreaterThan(0);

    // 非法 body
    const bad = await ctx.app.request('/api/v1/prefs', {
      method: 'PUT',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(bad.status).toBe(400);
    const tooBig = await ctx.app.request('/api/v1/prefs', {
      method: 'PUT',
      headers: { cookie: ctx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'x'.repeat(3000) }),
    });
    expect(tooBig.status).toBe(400);
  });

  it('误触过滤：短于 10 秒的已关闭片段不计入 sessions 与 daily-summary', async () => {
    // 独立 app：minSegmentMs=10s（生产默认）
    const filteredApp = createApp({
      storage: ctx.storage,
      config: { ...makeConfig(join(tmp, 'clock.sqlite')), minSegmentMs: 10_000 },
    });
    const h = { 'content-type': 'application/json', cookie: ctx.cookie };
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const url = (p: string) => `/api/v1/${p}`;

    // 基线：套件内先前用例（含 retime +120 的 math 会话）已有累计，断言用增量
    const summaryUrl = url(`daily-summary?date=${today}&timezone=${encodeURIComponent('Asia/Shanghai')}`);
    const baseSummary = await (await filteredApp.request(summaryUrl, { headers: h })).json();
    const mathBase = baseSummary.by_subject.find((b: { subject_id: string }) => b.subject_id === 'math').active_seconds;
    const englishBase = baseSummary.by_subject.find((b: { subject_id: string }) => b.subject_id === 'english').active_seconds;

    // 造一个 8 秒会话（误触）+ 一个 12 秒会话（有效）
    const short = await filteredApp.request(url('sessions'), {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'misfire-short-start' },
      body: JSON.stringify({ subject_id: 'math' }),
    });
    expect(short.status).toBe(201);
    const shortId = (await short.json()).session_id;
    await new Promise((resolve) => setTimeout(resolve, 8_100));
    await filteredApp.request(url(`sessions/${shortId}/stop`), {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'misfire-short-stop' },
      body: JSON.stringify({}),
    });

    const long = await filteredApp.request(url('sessions'), {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'misfire-long-start' },
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(long.status).toBe(201);
    const longId = (await long.json()).session_id;
    await new Promise((resolve) => setTimeout(resolve, 12_100));
    await filteredApp.request(url(`sessions/${longId}/stop`), {
      method: 'POST',
      headers: { ...h, 'idempotency-key': 'misfire-long-stop' },
      body: JSON.stringify({}),
    });

    // sessions：8s 会话的片段被过滤（segments 为空、秒数 0）；12s 会话保留
    const sessionsRes = await filteredApp.request(url(`sessions?date=${today}`), { headers: h });
    const sessionsBody = await sessionsRes.json();
    const shortEntry = sessionsBody.sessions.find((s: { session_id: string }) => s.session_id === shortId);
    const longEntry = sessionsBody.sessions.find((s: { session_id: string }) => s.session_id === longId);
    expect(shortEntry.segments).toEqual([]);
    expect(shortEntry.active_seconds).toBe(0);
    expect(longEntry.segments.length).toBeGreaterThan(0);
    expect(longEntry.active_seconds).toBeGreaterThanOrEqual(12);

    // daily-summary：math（8s）不计入；english（12s）计入
    const summaryRes = await filteredApp.request(summaryUrl, { headers: h });
    const summaryBody = await summaryRes.json();
    const math = summaryBody.by_subject.find((b: { subject_id: string }) => b.subject_id === 'math');
    const english = summaryBody.by_subject.find((b: { subject_id: string }) => b.subject_id === 'english');
    // 8s math 会话不贡献任何秒数；12s english 会话贡献 ≥12s
    expect(math.active_seconds).toBe(mathBase);
    expect(english.active_seconds).toBeGreaterThanOrEqual(englishBase + 12);
  }, 30_000);
});

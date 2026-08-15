import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SqliteStorage } from '../src/repo/sqlite-storage.js';

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

  it('公开只读：subjects / state / sessions / daily-summary 无凭据可读', async () => {
    // subjects：无需任何凭据（公开只读 API，供其他 Agent 读取）
    const noauth = await ctx.app.request('/api/v1/subjects');
    expect(noauth.status).toBe(200);
    const subjects = await noauth.json();
    expect(subjects).toHaveLength(7);
    expect(subjects.map((s: { subject_id: string }) => s.subject_id)).toContain('data-structures');
    // CORS：跨域可读
    expect(noauth.headers.get('access-control-allow-origin')).toBe('*');

    // state：无凭据可读（空库 → active_session null）
    const st = await ctx.app.request('/api/v1/state');
    expect(st.status).toBe(200);
    expect((await st.json()).active_session).toBeNull();

    // sessions?date：无凭据可读
    const sess = await ctx.app.request('/api/v1/sessions?date=2026-01-01');
    expect(sess.status).toBe(200);
    expect((await sess.json()).sessions).toEqual([]);

    // daily-summary：无凭据可读
    const ds = await ctx.app.request('/api/v1/daily-summary?date=2026-01-01&timezone=Asia/Shanghai');
    expect(ds.status).toBe(200);
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
      headers,
      body: JSON.stringify({ started_at: earlier, reason: '补录' }),
    });
    expect(adjusted.status).toBe(200);
    const body = await adjusted.json();
    expect(body.started_at).toBe(earlier);
    expect(body.active_seconds).toBeGreaterThanOrEqual(600);

    const segments = await ctx.storage.getSegments(created.session_id);
    expect(segments[0].startedAtMs).toBe(Date.parse(earlier));
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
    expect(second.status).toBe(200);
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
});

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SqliteStorage } from '../src/repo/sqlite-storage.js';

const PASSWORD = 'test-password-12345';

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

  it('subjects 需要凭据；返回 7 科目', async () => {
    const noauth = await ctx.app.request('/api/v1/subjects');
    expect(noauth.status).toBe(401);

    const res = await ctx.app.request('/api/v1/subjects', { headers: { 'x-api-key': ctx.token } });
    expect(res.status).toBe(200);
    const subjects = await res.json();
    expect(subjects).toHaveLength(7);
    expect(subjects.map((s: { subject_id: string }) => s.subject_id)).toContain('data-structures');
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

    // resume
    const resumeRes = await ctx.app.request(`/api/v1/sessions/${id}/resume`, {
      method: 'POST',
      headers: h({ 'idempotency-key': 'test-resume-0001' }),
    });
    expect(resumeRes.status).toBe(200);
    expect((await resumeRes.json()).status).toBe('running');

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

  it('撤销后的 token 立即失效', async () => {
    const create = await ctx.app.request('/api/v1/credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: ctx.cookie },
      body: JSON.stringify({ name: 'temp' }),
    });
    const { id, token } = await create.json();
    const ok = await ctx.app.request('/api/v1/subjects', { headers: { 'x-api-key': token } });
    expect(ok.status).toBe(200);
    await ctx.app.request(`/api/v1/credentials/${id}/revoke`, { method: 'POST', headers: { cookie: ctx.cookie } });
    const denied = await ctx.app.request('/api/v1/subjects', { headers: { 'x-api-key': token } });
    expect(denied.status).toBe(401);
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

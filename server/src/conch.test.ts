import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { AppConfig, ConchConfig } from '../src/config.js';
import type { ConchLlmClient } from '../src/conch-client.js';
import { ConchLlmError } from '../src/conch-client.js';
import { SqliteStorage } from '../src/repo/sqlite-storage.js';

const PASSWORD = '246813';
const DAY = 86_400_000;

function makeConfig(dbPath: string, conch: ConchConfig | null): AppConfig {
  return {
    dbPath,
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    isProduction: false,
    sessionTtlMs: 7 * 86_400_000,
    minSegmentMs: 10_000,
    conch,
    version: 'test',
  };
}

/** 记录最后一次请求的假 LLM；content 可按用例替换 */
function fakeLlm(state: { content: string; error?: ConchLlmError }): ConchLlmClient & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    async ask(params) {
      calls.push(params);
      if (state.error) throw state.error;
      return { content: state.content };
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  cookie: string;
  llm: ReturnType<typeof fakeLlm>;
  tmp: string;
  setClock: (ms: number) => void;
}

async function setupHarness(conch: ConchConfig | null, llmState: { content: string; error?: ConchLlmError }): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'clock-conch-test-'));
  const storage = new SqliteStorage(join(tmp, 'clock.sqlite'));
  storage.migrate();
  const llm = fakeLlm(llmState);
  let clockMs = Date.now();
  const app = createApp({
    storage,
    config: makeConfig(join(tmp, 'clock.sqlite'), conch),
    conchLlm: conch ? llm : null,
    now: () => clockMs,
  });

  const setupRes = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(setupRes.status).toBe(200);
  const cookie = setupRes.headers.get('set-cookie')!.split(';')[0];
  return { app, cookie, llm, tmp, setClock: (ms) => (clockMs = ms) };
}

const CONCH_STUB: ConchConfig = { apiBase: 'https://stub.invalid/v1', apiKey: 'stub', model: 'stub-model', thinkingBudget: 0 };

/** 用注入时钟在目标时段造一个 1h 的已停止会话 */
async function startAndStop(h: Harness, subject: string, note: string, startedAtMs: number): Promise<void> {
  const idem = `k${Math.random().toString(36).slice(2, 10)}x`;
  h.setClock(startedAtMs);
  const start = await h.app.request('/api/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'idempotency-key': idem },
    body: JSON.stringify({ subject_id: subject, intent_note: note }),
  });
  expect(start.status).toBe(201);
  const created = await start.json();
  h.setClock(startedAtMs + 3_600_000);
  const stop = await h.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'idempotency-key': `${idem}s` },
    body: JSON.stringify({ end_note: note }),
  });
  expect(stop.status).toBe(200);
}

function ask(h: Harness, window: string) {
  return h.app.request('/api/v1/conch/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify({ window }),
  });
}

async function conchRevision(h: Harness): Promise<number> {
  const res = await h.app.request('/api/v1/state');
  expect(res.status).toBe(200);
  return (await res.json()).conch_revision;
}

describe('POST /api/v1/conch/ask', () => {
  it('未登录 401；未配置 503；非法窗口 400', async () => {
    const h = await setupHarness(CONCH_STUB, { content: '' });
    const unauth = await h.app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ window: 'all' }),
    });
    expect(unauth.status).toBe(401);

    const h2 = await setupHarness(null, { content: '' });
    // conchLlm 注入为 null → 强制未配置
    const res2 = await h2.app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h2.cookie },
      body: JSON.stringify({ window: 'all' }),
    });
    expect(res2.status).toBe(503);
    expect((await res2.json()).error).toBe('CONCH_NOT_CONFIGURED');

    const bad = await ask(h, '90d');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('INVALID_WINDOW');

    rmSync(h.tmp, { recursive: true, force: true });
    rmSync(h2.tmp, { recursive: true, force: true });
  });

  it('回显受限的客户端诊断编号，不记录请求正文', async () => {
    const h = await setupHarness(CONCH_STUB, { content: JSON.stringify({ subjects: [] }) });
    const res = await h.app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-client-request-id': 'conch-e2e-trace-1234' },
      body: JSON.stringify({ window: 'all' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-client-request-id')).toBe('conch-e2e-trace-1234');

    const invalid = await h.app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie, 'x-client-request-id': 'conch-../../cookie' },
      body: JSON.stringify({ window: 'all' }),
    });
    expect(invalid.status).toBe(200);
    expect(invalid.headers.get('x-client-request-id')).toBeNull();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('缓存版本同时暴露当前模型标识，模型切换不会复用旧建议', async () => {
    const h = await setupHarness(CONCH_STUB, { content: JSON.stringify({ subjects: [] }) });
    const res = await h.app.request('/api/v1/conch/revision', { headers: { cookie: h.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conch_revision: 0, model: 'stub-model' });
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('无活跃科目：不调 LLM，返回全部 skipped', async () => {
    const h = await setupHarness(CONCH_STUB, { content: 'SHOULD_NOT_BE_USED' });
    const res = await ask(h, 'all');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subjects).toEqual([]);
    expect(body.skipped).toHaveLength(7);
    expect(body.skipped.every((s: { reason: string }) => s.reason === 'not_started')).toBe(true);
    expect(h.llm.calls).toHaveLength(0);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('conch_revision 只随已完成时间线事实变化，不随开始/暂停/继续推进', async () => {
    const h = await setupHarness(CONCH_STUB, { content: JSON.stringify({ subjects: [] }) });
    const t0 = Date.now();
    const headers = (key: string) => ({
      'content-type': 'application/json',
      cookie: h.cookie,
      'idempotency-key': key,
    });

    expect(await conchRevision(h)).toBe(0);
    h.setClock(t0);
    const started = await h.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: headers('semantic-start-001'),
      body: JSON.stringify({ subject_id: 'math', intent_note: '第六章看课' }),
    });
    const created = await started.json();
    expect(started.status).toBe(201);
    expect(await conchRevision(h)).toBe(0);

    h.setClock(t0 + 12_000);
    expect(
      (await h.app.request(`/api/v1/sessions/${created.session_id}/pause`, {
        method: 'POST',
        headers: headers('semantic-pause-001'),
      })).status,
    ).toBe(200);
    expect(await conchRevision(h)).toBe(0);

    h.setClock(t0 + 13_000);
    expect(
      (await h.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
        method: 'POST',
        headers: headers('semantic-resume-001'),
      })).status,
    ).toBe(200);
    expect(await conchRevision(h)).toBe(0);

    h.setClock(t0 + 25_000);
    expect(
      (await h.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
        method: 'POST',
        headers: headers('semantic-stop-001'),
        body: JSON.stringify({}),
      })).status,
    ).toBe(200);
    expect(await conchRevision(h)).toBe(1);

    expect(
      (await h.app.request(`/api/v1/sessions/${created.session_id}/note`, {
        method: 'PATCH',
        headers: headers('semantic-note-001'),
        body: JSON.stringify({ note: '完成了第六章基础题' }),
      })).status,
    ).toBe(200);
    expect(await conchRevision(h)).toBe(2);

    // 误触继续会将已完成会话重新打开，故它是影响海螺时间线的例外。
    h.setClock(t0 + 26_000);
    expect(
      (await h.app.request(`/api/v1/sessions/${created.session_id}/resume`, {
        method: 'POST',
        headers: headers('semantic-reopen-001'),
      })).status,
    ).toBe(200);
    expect(await conchRevision(h)).toBe(3);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('活跃科目：时间线进提示词，LLM 输出被清洗包装', async () => {
    const llmState = {
      content: JSON.stringify({
        subjects: [
          {
            subject_id: 'math',
            next_action: '做第5章 定积分的基础题',
            action_kind: 'problems',
            topic: '第5章 定积分',
            pattern: '看课→基础题→强化题',
            rationale: '上一步是看课，按节奏下一步做题',
            confidence: 'high',
            alternatives: ['回头补第4章错题', '预习第6章'],
          },
          { subject_id: 'politics', next_action: '不该出现', action_kind: 'other', rationale: '', confidence: 'low' },
        ],
      }),
    };
    const h = await setupHarness(CONCH_STUB, llmState);
    const nowMs = Date.now();
    await startAndStop(h, 'math', '第5章 定积分 看课', nowMs - 2 * DAY);
    await startAndStop(h, 'english', '阅读 2010 真题', nowMs - 30 * DAY);
    h.setClock(nowMs);

    const res = await ask(h, 'all');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('stub-model');
    expect(body.conch_revision).toBeGreaterThan(0);
    expect(body.subjects).toHaveLength(1);
    const math = body.subjects[0];
    expect(math.subject_id).toBe('math');
    expect(math.display_name).toBe('数学二');
    expect(math.next_action).toBe('做第5章 定积分的基础题');
    expect(math.running_now).toBe(false);
    expect(math.last_active_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(math.alternatives).toEqual(['回头补第4章错题', '预习第6章']);
    // politics 不在活跃集合 → 被解析层丢弃，出现在 skipped（inactive）
    expect(body.skipped.find((s: { subject_id: string }) => s.subject_id === 'politics')?.reason).toBe('not_started');
    expect(body.skipped.find((s: { subject_id: string }) => s.subject_id === 'english')?.reason).toBe('inactive');

    // 提示词包含活跃科目时间线与备注，不含不活跃科目块
    expect(h.llm.calls).toHaveLength(1);
    const prompt = h.llm.calls[0].user;
    expect(prompt).toContain('数学二 (math)');
    expect(prompt).toContain('"第5章 定积分 看课"');
    expect(prompt).not.toContain('英语二 (english) ===');
    expect(h.llm.calls[0].system).toContain('神奇海螺');
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('LLM 输出无法解析 → 422；超时 504；上游错误 502', async () => {
    const nowMs = Date.now();
    const garbage = await setupHarness(CONCH_STUB, { content: '这不是 JSON' });
    await startAndStop(garbage, 'math', '看课', nowMs - DAY);
    garbage.setClock(nowMs);
    expect((await ask(garbage, 'all')).status).toBe(422);
    rmSync(garbage.tmp, { recursive: true, force: true });

    const timeout = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('timeout', 'x') });
    await startAndStop(timeout, 'math', '看课', nowMs - DAY);
    timeout.setClock(nowMs);
    expect((await ask(timeout, 'all')).status).toBe(504);
    rmSync(timeout.tmp, { recursive: true, force: true });

    const upstream = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('upstream', 'x') });
    await startAndStop(upstream, 'math', '看课', nowMs - DAY);
    upstream.setClock(nowMs);
    expect((await ask(upstream, 'all')).status).toBe(502);
    rmSync(upstream.tmp, { recursive: true, force: true });
  });
});

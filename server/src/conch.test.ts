import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
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
const HOUR = 3_600_000;

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

/** 记录最后一次请求的假 LLM；content 可按用例替换。 */
function fakeLlm(state: { content: string; error?: ConchLlmError; delayMs?: number }): ConchLlmClient & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  return {
    calls,
    async ask(params) {
      calls.push(params);
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      if (state.error) throw state.error;
      return { content: state.content };
    },
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  storage: SqliteStorage;
  cookie: string;
  llm: ReturnType<typeof fakeLlm>;
  tmp: string;
  setClock: (ms: number) => void;
}

async function setupHarness(
  conch: ConchConfig | null,
  llmState: { content: string; error?: ConchLlmError; delayMs?: number },
  options?: { conchMaxPerHour?: number },
): Promise<Harness> {
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
    conchMaxPerHour: options?.conchMaxPerHour,
  });

  const setupRes = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(setupRes.status).toBe(200);
  const cookie = setupRes.headers.get('set-cookie')!.split(';')[0];
  return { app, storage, cookie, llm, tmp, setClock: (ms) => (clockMs = ms) };
}

const CONCH_STUB: ConchConfig = { apiBase: 'https://stub.invalid/v1', apiKey: 'stub', model: 'stub-model', thinkingBudget: 0 };

/** 用注入时钟在目标时段造一个已停止会话（默认 1h）。 */
async function startAndStop(h: Harness, subject: string, note: string, startedAtMs: number, durationMs = HOUR): Promise<void> {
  const idem = `k${Math.random().toString(36).slice(2, 10)}x`;
  h.setClock(startedAtMs);
  const start = await h.app.request('/api/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie, 'idempotency-key': idem },
    body: JSON.stringify({ subject_id: subject, intent_note: note }),
  });
  expect(start.status).toBe(201);
  const created = await start.json();
  h.setClock(startedAtMs + durationMs);
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

  it('相同 revision / 模型 / 窗口跨请求复用 D1 成功结果，force 才重新调用模型', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续上次的定积分练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    const nowMs = Date.now();
    await startAndStop(h, 'math', '定积分练习', nowMs - DAY);
    h.setClock(nowMs);

    const first = await ask(h, 'all');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const sessionsSpy = vi.spyOn(h.storage, 'sessionsOverlapping');
    const segmentsSpy = vi.spyOn(h.storage, 'segmentsForSessions');
    const second = await ask(h, 'all');
    expect(second.status).toBe(200);
    expect((await second.json()).generated_at).toBe(firstBody.generated_at);
    expect(h.llm.calls).toHaveLength(1);
    // 命中 D1 共享缓存只需轻量 revision / active-session / audit 读取，不能重复扫完整时间线。
    expect(sessionsSpy).not.toHaveBeenCalled();
    expect(segmentsSpy).not.toHaveBeenCalled();
    sessionsSpy.mockRestore();
    segmentsSpy.mockRestore();

    const forced = await h.app.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie },
      body: JSON.stringify({ window: 'all', force: true }),
    });
    expect(forced.status).toBe(200);
    expect(h.llm.calls).toHaveLength(2);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('并行 miss 只允许一个请求调模型，竞争请求等待共享结果后可重试', async () => {
    const h = await setupHarness(CONCH_STUB, {
      delayMs: 40,
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '完成上次练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    const nowMs = Date.now();
    await startAndStop(h, 'math', '练习', nowMs - DAY);
    h.setClock(nowMs);

    const sessionsSpy = vi.spyOn(h.storage, 'sessionsOverlapping');
    const segmentsSpy = vi.spyOn(h.storage, 'segmentsForSessions');
    const [first, contender] = await Promise.all([ask(h, 'all'), ask(h, 'all')]);
    expect([first.status, contender.status].sort()).toEqual([200, 409]);
    const wait = first.status === 409 ? first : contender;
    expect(await wait.json()).toMatchObject({ error: 'CONCH_GENERATING', retry_after_ms: 3000 });
    expect(h.llm.calls).toHaveLength(1);
    expect(sessionsSpy).toHaveBeenCalledTimes(1);
    expect(segmentsSpy).toHaveBeenCalledTimes(1);
    sessionsSpy.mockRestore();
    segmentsSpy.mockRestore();

    const after = await ask(h, 'all');
    expect(after.status).toBe(200);
    expect(h.llm.calls).toHaveLength(1);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('跨北京时间自然日会使滚动窗口缓存失效，即使 completed revision 未变', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续定积分练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    const nowMs = Date.now();
    await startAndStop(h, 'math', '定积分练习', nowMs - DAY);
    h.setClock(nowMs);

    expect((await ask(h, '7d')).status).toBe(200);
    const revision = await conchRevision(h);
    expect(h.llm.calls).toHaveLength(1);

    // 当前时刻后 24h 一定已越过本次响应的“下一个北京时间日界”。
    h.setClock(nowMs + DAY);
    const nextDay = await ask(h, '7d');
    expect(nextDay.status).toBe(200);
    expect(await conchRevision(h)).toBe(revision);
    expect(h.llm.calls).toHaveLength(2);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('7d 缓存在同日有历史段移出滚动窗口时失效，即使 completed revision 未变', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续定积分练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    // 北京时间 08-08 09:00；第一段始于 08-01 09:30，今天 09:30 起会被 7d 窗口裁剪。
    const nowMs = Date.UTC(2026, 7, 8, 1, 0);
    await startAndStop(h, 'math', '即将移出 7d 的旧段', nowMs - 7 * DAY + HOUR / 2);
    await startAndStop(h, 'math', '保持活跃的近期段', nowMs - DAY);
    h.setClock(nowMs);

    const first = await ask(h, '7d');
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(Date.parse(firstBody.cache_valid_until)).toBe(nowMs + HOUR / 2);
    const revision = await conchRevision(h);
    expect(h.llm.calls).toHaveLength(1);

    h.setClock(nowMs + HOUR);
    expect((await ask(h, '7d')).status).toBe(200);
    expect(await conchRevision(h)).toBe(revision);
    expect(h.llm.calls).toHaveLength(2);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('7d 窗口正裁剪异常长段时返回新结果但不写共享缓存', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续定积分练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    const nowMs = Date.UTC(2026, 7, 8, 1, 0);
    // 该段横跨 7d 窗口起点，窗口内时长会持续变化，不能复用缓存。
    await startAndStop(h, 'math', '跨窗口长段', nowMs - 7 * DAY - HOUR, 2 * HOUR);
    await startAndStop(h, 'math', '保持活跃的近期段', nowMs - DAY);
    h.setClock(nowMs);
    const revision = await conchRevision(h);

    const first = await ask(h, '7d');
    expect(first.status).toBe(200);
    expect(Date.parse((await first.json()).cache_valid_until)).toBe(nowMs);
    expect(await h.storage.getConchResponseCache(revision, CONCH_STUB.model, '7d')).toBeNull();

    expect((await ask(h, '7d')).status).toBe(200);
    expect(h.llm.calls).toHaveLength(2);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('生成期间 completed timeline 改变时不写入旧上下文的缓存', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续定积分练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    });
    const nowMs = Date.now();
    await startAndStop(h, 'math', '定积分练习', nowMs - DAY);
    h.setClock(nowMs);
    const before = await conchRevision(h);
    const originalAsk = h.llm.ask.bind(h.llm);
    h.llm.ask = async (params) => {
      const result = await originalAsk(params);
      // 模拟另一个标签页在模型返回前刚完成了会影响建议的修改。
      await h.storage.bumpConchRevision();
      return result;
    };

    const stale = await ask(h, 'all');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'CONCH_CONTEXT_STALE', retry_after_ms: 250 });
    expect(await h.storage.getConchResponseCache(before, CONCH_STUB.model, 'all')).toBeNull();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('上游额度在同一持久化库跨 createApp 实例生效，缓存命中不消耗额度', async () => {
    const h = await setupHarness(CONCH_STUB, {
      content: JSON.stringify({
        subjects: [{ subject_id: 'math', next_action: '继续练习', action_kind: 'problems', topic: null, pattern: null, rationale: '', confidence: 'medium', alternatives: [] }],
      }),
    }, { conchMaxPerHour: 1 });
    const nowMs = Date.now();
    await startAndStop(h, 'math', '练习', nowMs - DAY);
    h.setClock(nowMs);
    expect((await ask(h, 'all')).status).toBe(200);
    expect((await ask(h, 'all')).status).toBe(200); // D1 cache hit
    expect(h.llm.calls).toHaveLength(1);

    const secondWorkerApp = createApp({
      storage: h.storage,
      config: makeConfig(join(h.tmp, 'clock.sqlite'), CONCH_STUB),
      conchLlm: h.llm,
      now: () => nowMs,
      conchMaxPerHour: 1,
    });
    const blocked = await secondWorkerApp.request('/api/v1/conch/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: h.cookie },
      body: JSON.stringify({ window: 'all', force: true }),
    });
    expect(blocked.status).toBe(429);
    expect(h.llm.calls).toHaveLength(1);
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('LLM 输出无法解析或为空 → 422；超时 504；失效凭据 503；额度不足 402；其他上游错误 502', async () => {
    const nowMs = Date.now();
    const garbage = await setupHarness(CONCH_STUB, { content: '这不是 JSON' });
    await startAndStop(garbage, 'math', '看课', nowMs - DAY);
    garbage.setClock(nowMs);
    expect((await ask(garbage, 'all')).status).toBe(422);
    rmSync(garbage.tmp, { recursive: true, force: true });

    const empty = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('invalid', 'empty') });
    await startAndStop(empty, 'math', '看课', nowMs - DAY);
    empty.setClock(nowMs);
    expect((await ask(empty, 'all')).status).toBe(422);
    rmSync(empty.tmp, { recursive: true, force: true });

    const timeout = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('timeout', 'x') });
    await startAndStop(timeout, 'math', '看课', nowMs - DAY);
    timeout.setClock(nowMs);
    expect((await ask(timeout, 'all')).status).toBe(504);
    rmSync(timeout.tmp, { recursive: true, force: true });

    const credential = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('auth', 'x', 401) });
    await startAndStop(credential, 'math', '看课', nowMs - DAY);
    credential.setClock(nowMs);
    const credentialRes = await ask(credential, 'all');
    expect(credentialRes.status).toBe(503);
    expect((await credentialRes.json()).error).toBe('CONCH_CREDENTIAL_INVALID');
    rmSync(credential.tmp, { recursive: true, force: true });

    const quota = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('quota', 'x', 402) });
    await startAndStop(quota, 'math', '看课', nowMs - DAY);
    quota.setClock(nowMs);
    const quotaRes = await ask(quota, 'all');
    expect(quotaRes.status).toBe(402);
    expect((await quotaRes.json()).error).toBe('CONCH_QUOTA_EXHAUSTED');
    rmSync(quota.tmp, { recursive: true, force: true });

    const upstream = await setupHarness(CONCH_STUB, { content: '', error: new ConchLlmError('upstream', 'x') });
    await startAndStop(upstream, 'math', '看课', nowMs - DAY);
    upstream.setClock(nowMs);
    expect((await ask(upstream, 'all')).status).toBe(502);
    rmSync(upstream.tmp, { recursive: true, force: true });
  });
});

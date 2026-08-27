import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import { SqliteStorage } from '../src/repo/sqlite-storage.js';

const PASSWORD = '246813';
const DAY = 86_400_000;

interface RangeCtx {
  app: ReturnType<typeof createApp>;
  storage: SqliteStorage;
  cookie: string;
  setNow(ms: number): void;
  cleanup(): void;
}

async function createRangeCtx(nowMs = Date.UTC(2026, 7, 26, 4, 0, 0)): Promise<RangeCtx> {
  const dir = mkdtempSync(join(tmpdir(), 'clock-range-api-'));
  const storage = new SqliteStorage(join(dir, 'clock.sqlite'));
  storage.migrate();
  let clock = nowMs;
  const config: AppConfig = {
    dbPath: join(dir, 'clock.sqlite'),
    port: 0,
    baseUrl: 'http://127.0.0.1:0',
    isProduction: false,
    sessionTtlMs: 7 * 86_400_000,
    minSegmentMs: 0,
    conch: null,
    version: 'range-test',
  };
  const app = createApp({ storage, config, now: () => clock });
  const setup = await app.request('/api/v1/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(setup.status).toBe(200);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  return {
    app,
    storage,
    cookie,
    setNow: (ms) => (clock = ms),
    cleanup: () => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let keySeq = 0;
function writeHeaders(ctx: RangeCtx) {
  keySeq += 1;
  return {
    'content-type': 'application/json',
    cookie: ctx.cookie,
    'idempotency-key': `range-api-${String(keySeq).padStart(5, '0')}`,
  };
}

async function createStopped(
  ctx: RangeCtx,
  subjectId: string,
  startedAtMs: number,
  endedAtMs: number,
  options: { intentNote?: string; endNote?: string } = {},
) {
  ctx.setNow(startedAtMs);
  const start = await ctx.app.request('/api/v1/sessions', {
    method: 'POST',
    headers: writeHeaders(ctx),
    body: JSON.stringify({ subject_id: subjectId, intent_note: options.intentNote ?? null }),
  });
  expect(start.status).toBe(201);
  const created = await start.json();
  ctx.setNow(endedAtMs);
  const stop = await ctx.app.request(`/api/v1/sessions/${created.session_id}/stop`, {
    method: 'POST',
    headers: writeHeaders(ctx),
    body: JSON.stringify({ end_note: options.endNote ?? null }),
  });
  expect(stop.status).toBe(200);
  return created.session_id as string;
}

async function createPaused(ctx: RangeCtx, subjectId: string, startedAtMs: number, pausedAtMs: number) {
  ctx.setNow(startedAtMs);
  const start = await ctx.app.request('/api/v1/sessions', {
    method: 'POST',
    headers: writeHeaders(ctx),
    body: JSON.stringify({ subject_id: subjectId }),
  });
  expect(start.status).toBe(201);
  const created = await start.json();
  ctx.setNow(pausedAtMs);
  const pause = await ctx.app.request(`/api/v1/sessions/${created.session_id}/pause`, {
    method: 'POST',
    headers: writeHeaders(ctx),
  });
  expect(pause.status).toBe(200);
  return created.session_id as string;
}

describe('range read APIs', () => {
  const contexts: RangeCtx[] = [];
  afterEach(() => {
    while (contexts.length) contexts.pop()!.cleanup();
  });

  it('保留旧 date 调用；跨两日 range 只返回一次会话并给出窗口裁剪与全量秒数', async () => {
    const ctx = await createRangeCtx();
    contexts.push(ctx);
    // 北京 08-01 23:50 → 08-02 00:20
    const id = await createStopped(ctx, 'math', Date.UTC(2026, 7, 1, 15, 50), Date.UTC(2026, 7, 1, 16, 20), {
      intentNote: '跨夜看课',
    });

    const legacy = await ctx.app.request('/api/v1/sessions?date=2026-08-01');
    expect(legacy.status).toBe(200);
    const legacyBody = await legacy.json();
    expect(legacyBody.date).toBe('2026-08-01');
    expect(legacyBody.sessions).toHaveLength(1);
    expect(legacyBody.sessions[0].active_seconds).toBe(600);

    const range = await ctx.app.request('/api/v1/sessions?from=2026-08-01&to=2026-08-02');
    expect(range.status).toBe(200);
    expect(range.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    const body = await range.json();
    expect(body).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-02',
      timezone: 'Asia/Shanghai',
      count: 1,
    });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      session_id: id,
      active_seconds: 1800,
      window_active_seconds: 1800,
      session_active_seconds: 1800,
      longest_continuous_seconds: 1800,
      intent_note: '跨夜看课',
      end_note: null,
    });
    expect(body.sessions[0].segments).toHaveLength(1);
    expect(body.adjustments_or_revocations).toEqual([]);

    const sevenDays = await ctx.app.request('/api/v1/sessions?from=2026-08-01&to=2026-08-07');
    expect(sevenDays.status).toBe(200);
    expect((await sevenDays.json()).sessions).toHaveLength(1);
  });

  it('拒绝 date/range 混用、缺一端、倒序、非法日期和超过 31 天', async () => {
    const ctx = await createRangeCtx();
    contexts.push(ctx);
    for (const path of [
      '/api/v1/sessions',
      '/api/v1/sessions?from=2026-08-01',
      '/api/v1/sessions?to=2026-08-01',
      '/api/v1/sessions?from=2026-08-02&to=2026-08-01',
      '/api/v1/sessions?from=2026-08-01&to=2026-09-01',
      '/api/v1/sessions?from=bad&to=2026-08-01',
      '/api/v1/sessions?date=2026-08-01&from=2026-08-01&to=2026-08-01',
      '/api/v1/sessions?from=2026-08-01&to=2026-08-01&subject_id=math&aggregate_group=math',
    ]) {
      const res = await ctx.app.request(path);
      expect(res.status, path).toBe(400);
      expect((await res.json()).error).toMatch(/INVALID_(DATE|DATE_RANGE|FILTER)/);
    }

    const unknown = await ctx.app.request('/api/v1/does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/json');
    expect((await unknown.json()).error).toBe('NOT_FOUND');
  });

  it('支持 subject、408 aggregate、status、has_note 过滤，并暴露撤回审计', async () => {
    const ctx = await createRangeCtx();
    contexts.push(ctx);
    const base = Date.UTC(2026, 7, 3, 1, 0);
    const mathIntent = await createStopped(ctx, 'math', base, base + 60_000, { intentNote: '数学意图备注' });
    const mathNone = await createStopped(ctx, 'math', base + 2 * 60_000, base + 3 * 60_000);
    const ds = await createStopped(ctx, 'data-structures', base + 4 * 60_000, base + 5 * 60_000, { endNote: '数据结构结束备注' });
    await createStopped(ctx, 'computer-organization', base + 6 * 60_000, base + 7 * 60_000);
    await createStopped(ctx, 'operating-systems', base + 8 * 60_000, base + 9 * 60_000);
    await createStopped(ctx, 'computer-networks', base + 10 * 60_000, base + 11 * 60_000);
    const paused = await createPaused(ctx, 'english', base + 12 * 60_000, base + 13 * 60_000);

    const subject = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&subject_id=math')).json();
    expect(subject.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([mathIntent, mathNone]);

    const aggregate = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&aggregate_group=408')).json();
    expect(aggregate.sessions.map((s: { subject_id: string }) => s.subject_id)).toEqual([
      'data-structures',
      'computer-organization',
      'operating-systems',
      'computer-networks',
    ]);

    const noted = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&has_note=true')).json();
    expect(noted.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([mathIntent, ds]);
    const unnoted = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&has_note=false')).json();
    expect(unnoted.sessions.map((s: { session_id: string }) => s.session_id)).toContain(mathNone);

    const pausedOnly = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&status=paused')).json();
    expect(pausedOnly.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([paused]);
    expect(pausedOnly.sessions[0].segments.at(-1).ended_at).not.toBeNull();

    // 同一会话继续后变 running，范围 API 显式返回开放段；暂停/运行状态过滤不混淆。
    ctx.setNow(base + 13 * 60_000 + 1);
    const resumed = await ctx.app.request(`/api/v1/sessions/${paused}/resume`, {
      method: 'POST',
      headers: writeHeaders(ctx),
    });
    expect(resumed.status).toBe(200);
    ctx.setNow(base + 13 * 60_000 + 2_000);
    const runningOnly = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&status=running')).json();
    expect(runningOnly.sessions.map((s: { session_id: string }) => s.session_id)).toEqual([paused]);
    expect(runningOnly.sessions[0].segments.at(-1).ended_at).toBeNull();

    // 停止后在更晚日期修改备注，查询原会话日期仍可看到后续 correction 摘要。
    ctx.setNow(base + 14 * 60_000);
    const laterNote = await ctx.app.request(`/api/v1/sessions/${mathIntent}/note`, {
      method: 'PATCH',
      headers: writeHeaders(ctx),
      body: JSON.stringify({ note: '订正并理解完' }),
    });
    expect(laterNote.status).toBe(200);

    // voided 默认不在 sessions，但撤回事实必须可见。
    await ctx.app.request(`/api/v1/sessions/${paused}/stop`, {
      method: 'POST',
      headers: writeHeaders(ctx),
      body: JSON.stringify({}),
    });
    ctx.setNow(base + 15 * 60_000);
    const voided = await ctx.app.request(`/api/v1/sessions/${ds}/void`, {
      method: 'POST',
      headers: writeHeaders(ctx),
      body: JSON.stringify({ reason: '误记' }),
    });
    expect(voided.status).toBe(200);
    const afterVoid = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&aggregate_group=408')).json();
    expect(afterVoid.sessions.map((s: { session_id: string }) => s.session_id)).not.toContain(ds);
    expect(afterVoid.adjustments_or_revocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_id: ds, kind: 'void', status: 'voided' })]),
    );
    const mathAudit = await (await ctx.app.request('/api/v1/sessions?from=2026-08-03&to=2026-08-03&subject_id=math')).json();
    expect(mathAudit.adjustments_or_revocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_id: mathIntent, kind: 'note', status: 'stopped' })]),
    );
  });

  it('daily-summaries 一次返回 31 天含空日、范围总计与 ETag；运行中不错误 304', async () => {
    const ctx = await createRangeCtx(Date.UTC(2026, 7, 31, 4, 0));
    contexts.push(ctx);
    const math = await createStopped(ctx, 'math', Date.UTC(2026, 7, 1, 1, 0), Date.UTC(2026, 7, 1, 2, 0));
    await createStopped(ctx, 'data-structures', Date.UTC(2026, 7, 2, 1, 0), Date.UTC(2026, 7, 2, 1, 30));

    const path = '/api/v1/daily-summaries?from=2026-08-01&to=2026-08-31&timezone=Asia%2FShanghai';
    const first = await ctx.app.request(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    const body = await first.json();
    expect(body.days).toHaveLength(31);
    expect(body.days.find((d: { date: string }) => d.date === '2026-08-03')).toMatchObject({
      total_active_seconds: 0,
      session_count: 0,
    });
    expect(body.total_active_seconds).toBe(5400);
    expect(body.aggregates.find((a: { group: string }) => a.group === '408')).toMatchObject({ active_seconds: 1800 });
    expect(body.active_dates).toEqual(['2026-08-01', '2026-08-02']);

    const unchanged = await ctx.app.request(path, { headers: { 'if-none-match': etag! } });
    expect(unchanged.status).toBe(304);

    // note 是已完成事实，必须使范围 ETag 失效。
    ctx.setNow(Date.UTC(2026, 7, 31, 4, 10));
    const note = await ctx.app.request(`/api/v1/sessions/${math}/note`, {
      method: 'PATCH',
      headers: writeHeaders(ctx),
      body: JSON.stringify({ note: '订正并理解完' }),
    });
    expect(note.status).toBe(200);
    const changed = await ctx.app.request(path, { headers: { 'if-none-match': etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);

    // 当前 running 会话与范围相交时，即便 revision 不变也不能 304。
    ctx.setNow(Date.UTC(2026, 7, 31, 5, 0));
    const running = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: writeHeaders(ctx),
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(running.status).toBe(201);
    const live = await ctx.app.request(path, { headers: { 'if-none-match': changed.headers.get('etag')! } });
    expect(live.status).toBe(200);
    expect(live.headers.get('etag')).toBeNull();
  });

  it('范围 sessions 的 ETag 会随 retime、adjust-start、note、void 失效；运行中范围不返回 304', async () => {
    // owner session expiry is intentionally checked against real wall clock by storage;
    // bootstrap with real now, then inject historical times only for the session facts.
    const ctx = await createRangeCtx(Date.now());
    contexts.push(ctx);
    const startedAt = Date.UTC(2026, 7, 5, 1, 0);
    const id = await createStopped(ctx, 'math', startedAt, startedAt + 60_000);
    const path = '/api/v1/sessions?from=2026-08-05&to=2026-08-05';
    const first = await ctx.app.request(path);
    expect(first.status).toBe(200);
    let etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const write = async (suffix: string, url: string, body: unknown) => {
      const res = await ctx.app.request(url, {
        method: url.includes('/note') ? 'PATCH' : 'POST',
        headers: writeHeaders(ctx),
        body: JSON.stringify(body),
      });
      expect(res.status, suffix).toBe(200);
      const next = await ctx.app.request(path, { headers: { 'if-none-match': etag! } });
      expect(next.status, `${suffix} must invalidate ETag`).toBe(200);
      expect(next.headers.get('etag')).not.toBe(etag);
      etag = next.headers.get('etag');
    };

    await write('retime', `/api/v1/sessions/${id}/retime`, { delta_seconds: 60, reason: null });
    await write('adjust-start', `/api/v1/sessions/${id}/adjust-start`, {
      started_at: new Date(startedAt - 60_000).toISOString(),
      reason: null,
    });
    await write('note', `/api/v1/sessions/${id}/note`, { note: '修正并理解完' });
    await write('void', `/api/v1/sessions/${id}/void`, { reason: '误记' });

    const afterVoid = await (await ctx.app.request(path)).json();
    expect(afterVoid.sessions).toEqual([]);
    expect(afterVoid.adjustments_or_revocations).toEqual(
      expect.arrayContaining([expect.objectContaining({ session_id: id, kind: 'void', status: 'voided' })]),
    );

    // 当前运行会话与范围相交：尽管 revision 不变，暂算秒数增长，必须返回 200 而非 304。
    ctx.setNow(Date.UTC(2026, 7, 10, 5, 0));
    const livePath = '/api/v1/sessions?from=2026-08-10&to=2026-08-10';
    const beforeRunning = await ctx.app.request(livePath);
    const liveEtag = beforeRunning.headers.get('etag');
    expect(liveEtag).toBeTruthy();
    const running = await ctx.app.request('/api/v1/sessions', {
      method: 'POST',
      headers: writeHeaders(ctx),
      body: JSON.stringify({ subject_id: 'english' }),
    });
    expect(running.status).toBe(201);
    ctx.setNow(Date.UTC(2026, 7, 10, 5, 1));
    const live = await ctx.app.request(livePath, {
      headers: { 'if-none-match': liveEtag! },
    });
    expect(live.status).toBe(200);
    expect(live.headers.get('etag')).toBeNull();
  });
});

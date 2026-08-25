import { describe, expect, it } from 'vitest';
import {
  buildConchContext,
  conchSessionSeconds,
  parseConchLlmOutput,
  CONCH_MAX_LINES_PER_SUBJECT,
  CONCH_SYSTEM_PROMPT,
} from '../src/conch.js';
import type { ActiveSegmentRow, SessionRow, SubjectId } from '../src/types.js';

const DAY = 86_400_000;
/** 2026-08-23 17:40 北京 = 09:40 UTC */
const NOW = Date.UTC(2026, 7, 23, 9, 40, 0);

let seq = 0;
function session(over: Partial<SessionRow> & { subjectId: SubjectId; startedAtMs: number }): SessionRow {
  const startedAtMs = over.startedAtMs;
  const endedAtMs = over.endedAtMs ?? (over.status === 'running' || over.status === 'paused' ? null : startedAtMs + 3_600_000);
  return {
    id: `s${++seq}`,
    userId: 'owner',
    status: 'stopped',
    intentNote: null,
    endNote: null,
    endReason: 'manual',
    activeSeconds: 3600,
    createdAtMs: startedAtMs,
    ...over,
    endedAtMs,
  } as SessionRow;
}

function segs(list: Array<[string, number, number | null]>): Map<string, ActiveSegmentRow[]> {
  const m = new Map<string, ActiveSegmentRow[]>();
  for (const [sessionId, startedAtMs, endedAtMs] of list) {
    const arr = m.get(sessionId) ?? [];
    arr.push({ sessionId, startedAtMs, endedAtMs });
    m.set(sessionId, arr);
  }
  return m;
}

/** 会话默认段：整段计入。 */
function fullSegs(sessions: SessionRow[]): Map<string, ActiveSegmentRow[]> {
  return segs(sessions.map((s) => [s.id, s.startedAtMs, s.endedAtMs]));
}

describe('conchSessionSeconds', () => {
  it('窗口裁剪 + 误触过滤 + 开放段截至 windowEnd', () => {
    const start = NOW - 2 * 3_600_000;
    const segments: ActiveSegmentRow[] = [
      { sessionId: 'x', startedAtMs: start, endedAtMs: start + 3_000 }, // 3s 误触
      { sessionId: 'x', startedAtMs: start + 10_000, endedAtMs: start + 1_810_000 }, // 30min
      { sessionId: 'x', startedAtMs: NOW - 600_000, endedAtMs: null }, // 开放 10min
    ];
    expect(conchSessionSeconds(segments, 0, NOW, 10_000)).toBe(1800 + 600);
    // 窗口起点切掉第一段计入部分
    expect(conchSessionSeconds(segments, start + 10_000 + 600_000, NOW, 10_000)).toBe(1200 + 600);
  });
});

describe('buildConchContext 活动门槛', () => {
  it('未开始 → not_started；久远活动 → inactive；近期活动 → active', () => {
    const old = session({ subjectId: 'english', startedAtMs: NOW - 20 * DAY });
    const recent = session({ subjectId: 'math', startedAtMs: NOW - 1 * DAY, intentNote: '第5章 强化题' });
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: [old, recent], segmentsBySession: fullSegs([old, recent]), minSegmentMs: 10_000,
    });
    expect(ctx.active).toEqual(['math']);
    expect(ctx.skipped).toEqual([
      { subject_id: 'english', display_name: '英语二', reason: 'inactive' },
      { subject_id: 'data-structures', display_name: '数据结构', reason: 'not_started' },
      { subject_id: 'computer-organization', display_name: '计算机组成原理', reason: 'not_started' },
      { subject_id: 'operating-systems', display_name: '操作系统', reason: 'not_started' },
      { subject_id: 'computer-networks', display_name: '计算机网络', reason: 'not_started' },
      { subject_id: 'politics', display_name: '思想政治理论', reason: 'not_started' },
    ]);
    expect(ctx.userPrompt).toContain('数学二 (math)');
    expect(ctx.userPrompt).not.toContain('英语二 (english)');
    expect(ctx.userPrompt).toContain('无近期活动或未开始');
  });

  it('仅有误触会话 → 等同未开始（误触不算有效活动）', () => {
    const tap = session({ subjectId: 'math', startedAtMs: NOW - 1 * DAY });
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: [tap],
      segmentsBySession: segs([[tap.id, tap.startedAtMs, tap.startedAtMs + 3_000]]), minSegmentMs: 10_000,
    });
    expect(ctx.active).toEqual([]);
    expect(ctx.skipped.find((s) => s.subject_id === 'math')?.reason).toBe('not_started');
    expect(ctx.userPrompt).toBe('');
  });

  it('作废会话不参与门槛', () => {
    const voided = session({ subjectId: 'math', startedAtMs: NOW - 1 * DAY, status: 'voided' });
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: [voided], segmentsBySession: fullSegs([voided]), minSegmentMs: 10_000,
    });
    expect(ctx.skipped.find((s) => s.subject_id === 'math')?.reason).toBe('not_started');
  });

  it('进行中会话（7 天内开始）算活跃且时间线标注进行中', () => {
    const running = session({ subjectId: 'math', startedAtMs: NOW - 1_500_000, status: 'running', intentNote: '第6章 看课' });
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: [running],
      segmentsBySession: segs([[running.id, running.startedAtMs, null]]), minSegmentMs: 10_000,
    });
    expect(ctx.active).toEqual(['math']);
    expect(ctx.userPrompt).toContain('进行中');
    expect(ctx.userPrompt).toContain('"第6章 看课"');
  });
});

describe('buildConchContext 窗口与编码', () => {
  const a = session({ subjectId: 'math', startedAtMs: NOW - 3 * DAY, intentNote: '第4章 基础题' });
  const b = session({ subjectId: 'math', startedAtMs: NOW - 20 * DAY, intentNote: '第1章 看课' });

  it('7d 窗口不含 20 天前的会话', () => {
    const ctx = buildConchContext({
      nowMs: NOW, window: '7d', sessions: [a, b], segmentsBySession: fullSegs([a, b]), minSegmentMs: 10_000,
    });
    expect(ctx.userPrompt).toContain('"第4章 基础题"');
    expect(ctx.userPrompt).not.toContain('"第1章 看课"');
  });

  it('all 窗口两者都在，旧→新排序', () => {
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: [a, b], segmentsBySession: fullSegs([a, b]), minSegmentMs: 10_000,
    });
    const i1 = ctx.userPrompt.indexOf('"第1章 看课"');
    const i2 = ctx.userPrompt.indexOf('"第4章 基础题"');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(ctx.userPrompt).toMatch(/\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2} 1h00m "第4章 基础题"/);
    expect(ctx.userPrompt).toContain('统计窗口：从始至今');
  });

  it('单科目超 150 行时早于 45 天的部分按月聚合', () => {
    const many: SessionRow[] = [];
    for (let i = 0; i < CONCH_MAX_LINES_PER_SUBJECT + 5; i++) {
      many.push(session({ subjectId: 'math', startedAtMs: NOW - (60 * DAY) + i * 3_700_000, intentNote: `旧记录${i}` }));
    }
    const recent = session({ subjectId: 'math', startedAtMs: NOW - 1 * DAY, intentNote: '新记录' });
    const all = [...many, recent];
    const ctx = buildConchContext({
      nowMs: NOW, window: 'all', sessions: all, segmentsBySession: fullSegs(all), minSegmentMs: 10_000,
    });
    expect(ctx.userPrompt).toMatch(/06月 · \d+ 次 · [\d.]+h/);
    expect(ctx.userPrompt).toContain('"新记录"');
    // 明细行数受控：旧记录不全量出现
    expect((ctx.userPrompt.match(/旧记录/g) ?? []).length).toBeLessThan(20);
  });
});

describe('parseConchLlmOutput', () => {
  const expected: SubjectId[] = ['math', 'data-structures'];

  it('解析合法 JSON 并按科目序输出', () => {
    const raw = JSON.stringify({
      subjects: [
        { subject_id: 'data-structures', next_action: '做第5章强化题', action_kind: 'problems', rationale: '缺强化', confidence: 'high' },
        { subject_id: 'math', next_action: '做第6章基础题', action_kind: 'problems', rationale: '看课后', confidence: 'high' },
      ],
    });
    const recs = parseConchLlmOutput(raw, expected)!;
    expect(recs.map((r) => r.subject_id)).toEqual(['math', 'data-structures']);
    expect(recs[0].topic).toBeNull();
  });

  it('容错：code fence、非法枚举收敛、未知科目与缺 next_action 丢弃', () => {
    const raw = '```json\n' + JSON.stringify({
      subjects: [
        { subject_id: 'math', next_action: '做第6章基础题', action_kind: 'watch_video', confidence: 'super', rationale: 'x' },
        { subject_id: 'politics', next_action: '不该出现', action_kind: 'other', rationale: 'x', confidence: 'low' },
        { subject_id: 'data-structures', action_kind: 'problems', rationale: '缺核心字段' },
      ],
    }) + '\n```';
    const recs = parseConchLlmOutput(raw, expected)!;
    expect(recs).toHaveLength(1);
    expect(recs[0].subject_id).toBe('math');
    expect(recs[0].action_kind).toBe('other');
    expect(recs[0].confidence).toBe('low');
  });

  it('next_action 截断 80 字符；结构性失败返回 null', () => {
    const long = '做'.repeat(120);
    const recs = parseConchLlmOutput(JSON.stringify({ subjects: [{ subject_id: 'math', next_action: long, rationale: '' }] }), expected)!;
    expect(recs[0].next_action).toHaveLength(80);
    expect(recs[0].alternatives).toEqual([]);
    expect(parseConchLlmOutput('完全不是 JSON', expected)).toBeNull();
    expect(parseConchLlmOutput('{"foo": 1}', expected)).toBeNull();
  });

  it('alternatives：数组去重截断至多 3 条，兼容旧版单条 alternative', () => {
    const recs = parseConchLlmOutput(
      JSON.stringify({
        subjects: [
          {
            subject_id: 'math',
            next_action: '主推荐',
            rationale: '',
            alternatives: ['备选一', '备选一', '备选二', '备选三', '备选四'],
          },
          { subject_id: 'data-structures', next_action: '主推荐2', rationale: '', alternative: '旧版单条备选' },
        ],
      }),
      expected,
    )!;
    expect(recs[0].alternatives).toEqual(['备选一', '备选二', '备选三']);
    expect(recs[1].alternatives).toEqual(['旧版单条备选']);
  });

  it('system prompt 含 schema 关键约束', () => {
    expect(CONCH_SYSTEM_PROMPT).toContain('只输出输入中给出的科目');
    expect(CONCH_SYSTEM_PROMPT).toContain('next_action');
  });
});

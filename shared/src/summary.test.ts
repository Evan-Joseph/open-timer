import { describe, expect, it } from 'vitest';
import { buildDailySummary } from '../src/summary.js';
import type { SessionRow, ActiveSegmentRow, ManualAdjustmentRow } from '../src/types.js';

const DAY = '2026-08-09';
// 北京日窗口：2026-08-08T16:00Z .. 2026-08-09T16:00Z
const START = Date.UTC(2026, 7, 8, 16, 0, 0);
const END = START + 86_400_000;

function session(over: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    userId: 'owner',
    subjectId: 'math',
    status: 'stopped',
    intentNote: null,
    endNote: null,
    endReason: 'manual',
    startedAtMs: START + 3_600_000,
    endedAtMs: START + 7_200_000,
    activeSeconds: 3600,
    createdAtMs: START + 3_600_000,
    ...over,
  };
}

function seg(sessionId: string, startedAtMs: number, endedAtMs: number | null): ActiveSegmentRow {
  return { sessionId, startedAtMs, endedAtMs };
}

describe('buildDailySummary', () => {
  it('单日单会话：总秒数、by_subject、aggregates 一致', () => {
    const s = session({ id: 'A' });
    const out = buildDailySummary({
      date: DAY,
      sessions: [s],
      segmentsBySession: new Map([['A', [seg('A', s.startedAtMs, s.endedAtMs)]]]),
      adjustments: [],
      revision: 3,
      generatedAtMs: END,
      activeSession: null,
      activeSegments: [],
    });
    expect(out.total_active_seconds).toBe(3600);
    expect(out.by_subject.find((e) => e.subject_id === 'math')?.active_seconds).toBe(3600);
    expect(out.by_subject.find((e) => e.subject_id === 'math')?.session_count).toBe(1);
    expect(out.aggregates.find((a) => a.group === 'math')?.active_seconds).toBe(3600);
    expect(out.aggregates.find((a) => a.group === '408')?.active_seconds).toBe(0);
    expect(out.timezone).toBe('Asia/Shanghai');
    expect(out.revision).toBe(3);
    expect(out.sessions).toHaveLength(1);
    expect(out.running_session).toBeNull();
  });

  it('408 聚合 = 四个模块之和', () => {
    const sessions = [
      session({ id: 'DS', subjectId: 'data-structures', activeSeconds: 100 }),
      session({ id: 'CO', subjectId: 'computer-organization', startedAtMs: START + 10_000_000, endedAtMs: START + 10_300_000, activeSeconds: 300 }),
    ];
    const segMap = new Map<string, ActiveSegmentRow[]>([
      ['DS', [seg('DS', sessions[0].startedAtMs, sessions[0].endedAtMs)]],
      ['CO', [seg('CO', sessions[1].startedAtMs, sessions[1].endedAtMs)]],
    ]);
    const out = buildDailySummary({
      date: DAY,
      sessions,
      segmentsBySession: segMap,
      adjustments: [],
      revision: 1,
      generatedAtMs: END,
      activeSession: null,
      activeSegments: [],
    });
    expect(out.aggregates.find((a) => a.group === '408')?.active_seconds).toBe(3600 + 300);
  });

  it('跨午夜会话按窗口裁剪，两段分别入账', () => {
    // 会话从北京 23:00 到次日 01:00（2h），当日只记 23:00-24:00 = 3600s
    const startMs = END - 3_600_000; // 北京 23:00
    const endMs = END + 3_600_000; // 次日北京 01:00
    const s = session({ id: 'X', startedAtMs: startMs, endedAtMs: endMs });
    const outToday = buildDailySummary({
      date: DAY,
      sessions: [s],
      segmentsBySession: new Map([['X', [seg('X', startMs, endMs)]]]),
      adjustments: [],
      revision: 1,
      generatedAtMs: END + 4_000_000,
      activeSession: null,
      activeSegments: [],
    });
    expect(outToday.total_active_seconds).toBe(3600);

    const NEXT = '2026-08-10';
    const outNext = buildDailySummary({
      date: NEXT,
      sessions: [s],
      segmentsBySession: new Map([['X', [seg('X', startMs, endMs)]]]),
      adjustments: [],
      revision: 1,
      generatedAtMs: END + 4_000_000,
      activeSession: null,
      activeSegments: [],
    });
    expect(outNext.total_active_seconds).toBe(3600);
  });

  it('voided 会话完全排除', () => {
    const s = session({ id: 'V', status: 'voided' });
    const out = buildDailySummary({
      date: DAY,
      sessions: [s],
      segmentsBySession: new Map([['V', [seg('V', s.startedAtMs, s.endedAtMs)]]]),
      adjustments: [],
      revision: 1,
      generatedAtMs: END,
      activeSession: null,
      activeSegments: [],
    });
    expect(out.total_active_seconds).toBe(0);
    expect(out.sessions).toHaveLength(0);
  });

  it('running_session 给出截至 generated_at 的暂算秒数', () => {
    const startMs = START + 3_600_000;
    const nowMs = startMs + 1_800_000; // 已跑 30 分钟
    const s = session({ id: 'R', status: 'running', endedAtMs: null, startedAtMs: startMs });
    const out = buildDailySummary({
      date: DAY,
      sessions: [s],
      segmentsBySession: new Map([['R', [seg('R', startMs, null)]]]),
      adjustments: [],
      revision: 2,
      generatedAtMs: nowMs,
      activeSession: s,
      activeSegments: [seg('R', startMs, null)],
    });
    expect(out.running_session).not.toBeNull();
    expect(out.running_session!.active_seconds).toBe(1800);
    expect(out.running_session!.status).toBe('running');
    expect(out.total_active_seconds).toBe(1800);
  });

  it('同 revision 同输入产生字节级一致的 JSON', () => {
    const input = {
      date: DAY,
      sessions: [session({ id: 'A' })],
      segmentsBySession: new Map([['A', [seg('A', START + 3_600_000, START + 7_200_000)]]]),
      adjustments: [] as ManualAdjustmentRow[],
      revision: 7,
      generatedAtMs: END,
      activeSession: null,
      activeSegments: [],
    };
    const a = JSON.stringify(buildDailySummary(input));
    const b = JSON.stringify(buildDailySummary(input));
    expect(a).toBe(b);
  });

  it('adjustments 只收录会话开始于当日的条目', () => {
    const s = session({ id: 'A' });
    const adj: ManualAdjustmentRow[] = [
      { sessionId: 'A', kind: 'void', beforeJson: '{}', afterJson: '{}', reason: '误触', createdAtMs: START + 8_000_000 },
    ];
    const out = buildDailySummary({
      date: DAY,
      sessions: [s],
      segmentsBySession: new Map([['A', [seg('A', s.startedAtMs, s.endedAtMs)]]]),
      adjustments: adj,
      revision: 1,
      generatedAtMs: END,
      activeSession: null,
      activeSegments: [],
    });
    expect(out.adjustments_or_revocations).toHaveLength(1);
    expect(out.adjustments_or_revocations[0].reason).toBe('误触');
  });
});

/**
 * 日汇总纯函数：给定某日窗口内的会话与段，生成 DailySummary 的全部数值。
 * 确定性：同输入同输出；sessions 按 started_at 升序；by_subject 按 sort_order；
 * aggregates 固定四组顺序。
 */

import type {
  SessionRow,
  ActiveSegmentRow,
  DailySummary,
  BySubjectEntry,
  AggregateEntry,
  SessionEntry,
  RunningSessionEntry,
  AdjustmentEntry,
  ManualAdjustmentRow,
} from './types.js';
import { SUBJECTS, AGGREGATE_GROUPS, subjectById } from './subjects.js';
import { shanghaiDayRangeUtc, toIso, TIMEZONE } from './shanghai.js';
import { DEFAULT_MIN_COUNTED_SEGMENT_MS, isCountedSegment } from './state-machine.js';

export interface SummaryInput {
  date: string;
  /** 与当日有交集的所有会话（含 voided，将被排除） */
  sessions: SessionRow[];
  segmentsBySession: Map<string, ActiveSegmentRow[]>;
  adjustments: ManualAdjustmentRow[];
  revision: number;
  generatedAtMs: number;
  /** 当前活动会话（若存在且与当日相关则进 running_session） */
  activeSession: SessionRow | null;
  activeSegments: ActiveSegmentRow[];
  /** 误触过滤阈值：短于该值的已关闭片段不计入（缺省 10s；测试可置 0） */
  minSegmentMs?: number;
}

function clipSegment(
  seg: Pick<ActiveSegmentRow, 'startedAtMs' | 'endedAtMs'>,
  startMs: number,
  endMs: number,
  nowMs: number,
): { start: number; end: number } | null {
  const rawEnd = seg.endedAtMs ?? nowMs;
  const s = Math.max(seg.startedAtMs, startMs);
  const e = Math.min(rawEnd, endMs);
  if (e <= s) return null;
  return { start: s, end: e };
}

export function buildDailySummary(input: SummaryInput): DailySummary {
  const { startMs, endMs } = shanghaiDayRangeUtc(input.date);
  const nowMs = input.generatedAtMs;
  const minSegmentMs = input.minSegmentMs ?? DEFAULT_MIN_COUNTED_SEGMENT_MS;

  // 排除 voided；仅统计有效会话
  const validSessions = input.sessions.filter((s) => s.status !== 'voided');

  const bySubjectSeconds = new Map<string, number>();
  const bySubjectSessions = new Map<string, Set<string>>();
  const sessionEntries: SessionEntry[] = [];
  let total = 0;

  for (const session of validSessions) {
    const segs = input.segmentsBySession.get(session.id) ?? [];
    // 取整口径：同一 session 同一日内累加裁剪后毫秒、最后一次性 floor，
    // 与 computeActiveSeconds 的「总 ms 一次 floor」一致（多段会话不再各段截断累加，
    // 否则 1500ms+1500ms 会得 1+1=2 而 state 得 3）。
    let sessionMs = 0;
    for (const seg of segs) {
      if (!isCountedSegment(seg, minSegmentMs)) continue; // 误触片段不计入
      const clipped = clipSegment(seg, startMs, endMs, nowMs);
      if (!clipped) continue;
      sessionMs += clipped.end - clipped.start;
    }
    const sessionSeconds = Math.floor(sessionMs / 1000);
    if (sessionSeconds > 0 || (session.status === 'running' || session.status === 'paused')) {
      if (sessionSeconds > 0) {
        total += sessionSeconds;
        bySubjectSeconds.set(session.subjectId, (bySubjectSeconds.get(session.subjectId) ?? 0) + sessionSeconds);
        const set = bySubjectSessions.get(session.subjectId) ?? new Set<string>();
        set.add(session.id);
        bySubjectSessions.set(session.subjectId, set);
      }
      sessionEntries.push({
        session_id: session.id,
        subject_id: session.subjectId,
        started_at: toIso(session.startedAtMs),
        ended_at: session.endedAtMs !== null ? toIso(session.endedAtMs) : null,
        active_seconds: sessionSeconds,
        status: session.status,
        end_reason: session.endReason,
        note: session.endNote ?? session.intentNote ?? null,
      });
    }
  }

  // 跨日 running/paused 会话即使当日秒数为 0 也不列入 sessions（无当日段），
  // 但若存在开放段与当日有交集，clipSegment 已会计入。

  sessionEntries.sort((a, b) => a.started_at.localeCompare(b.started_at));

  const by_subject: BySubjectEntry[] = SUBJECTS.map((s) => ({
    subject_id: s.id,
    display_name: s.displayName,
    active_seconds: bySubjectSeconds.get(s.id) ?? 0,
    session_count: bySubjectSessions.get(s.id)?.size ?? 0,
  }));

  const aggregates: AggregateEntry[] = AGGREGATE_GROUPS.map((group) => ({
    group,
    active_seconds: SUBJECTS.filter((s) => s.aggregateGroup === group).reduce(
      (acc, s) => acc + (bySubjectSeconds.get(s.id) ?? 0),
      0,
    ),
  }));

  // running_session：仅当活动会话与当日窗口有交集
  let running_session: RunningSessionEntry | null = null;
  if (input.activeSession && (input.activeSession.status === 'running' || input.activeSession.status === 'paused')) {
    const openSeg = input.activeSegments.find((s) => s.endedAtMs === null);
    // 段与当日窗口相交即计入；开放段（running）额外放宽——刚启动时开放段与 nowMs 同毫秒、
    // 长度为 0 会被 clipSegment 判为不相交，但会话此刻确在当日活跃，应计入 running_session。
    const overlapsDay = input.activeSegments.some(
      (seg) =>
        clipSegment(seg, startMs, endMs, nowMs) !== null ||
        (seg.endedAtMs === null && seg.startedAtMs < endMs && nowMs >= startMs),
    );
    // paused 时，最后一段的结束时刻即暂停（离开）开始时刻
    let pausedAtMs: number | null = null;
    if (input.activeSession.status === 'paused' && input.activeSegments.length > 0) {
      const last = input.activeSegments[input.activeSegments.length - 1];
      if (last.endedAtMs !== null) pausedAtMs = last.endedAtMs;
    }
    if (overlapsDay) {
      let activeMs = 0;
      for (const seg of input.activeSegments) {
        if (!isCountedSegment(seg, minSegmentMs)) continue; // 误触片段不计入（开放段不受影响）
        const clipped = clipSegment(seg, startMs, endMs, nowMs);
        if (clipped) activeMs += clipped.end - clipped.start;
      }
      const secs = Math.floor(activeMs / 1000);
      running_session = {
        session_id: input.activeSession.id,
        subject_id: input.activeSession.subjectId,
        started_at: toIso(input.activeSession.startedAtMs),
        status: input.activeSession.status,
        active_seconds: secs,
        current_segment_started_at: openSeg ? toIso(openSeg.startedAtMs) : null,
        // 本段秒数（不按日裁剪）：running 时 open 段累计；paused 时末段净秒冻结
        current_segment_active_seconds: openSeg
          ? Math.max(0, Math.floor((nowMs - openSeg.startedAtMs) / 1000))
          : input.activeSegments.length > 0
            ? Math.max(
                0,
                Math.floor(
                  ((input.activeSegments[input.activeSegments.length - 1].endedAtMs ?? nowMs) -
                    input.activeSegments[input.activeSegments.length - 1].startedAtMs) /
                    1000,
                ),
              )
            : null,
        paused_at: pausedAtMs !== null ? toIso(pausedAtMs) : null,
        intent_note: input.activeSession.intentNote,
      };
    }
  }

  const adjustments_or_revocations: AdjustmentEntry[] = input.adjustments
    .filter((a) => {
      const session = validSessions.find((s) => s.id === a.sessionId) ?? input.sessions.find((s) => s.id === a.sessionId);
      if (!session) return false;
      return session.startedAtMs >= startMs && session.startedAtMs < endMs;
    })
    .map((a) => ({
      session_id: a.sessionId,
      kind: a.kind,
      reason: a.reason,
      at: toIso(a.createdAtMs),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));

  return {
    date: input.date,
    timezone: TIMEZONE,
    revision: input.revision,
    generated_at: toIso(nowMs),
    total_active_seconds: total,
    by_subject,
    aggregates,
    sessions: sessionEntries,
    running_session,
    adjustments_or_revocations,
  };
}

/** 供前端与 API 共用的显示名查询。 */
export function displayNameOf(subjectId: string): string {
  return subjectById(subjectId)?.displayName ?? subjectId;
}

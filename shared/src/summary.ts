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

  // 排除 voided；仅统计有效会话
  const validSessions = input.sessions.filter((s) => s.status !== 'voided');

  const bySubjectSeconds = new Map<string, number>();
  const bySubjectSessions = new Map<string, Set<string>>();
  const sessionEntries: SessionEntry[] = [];
  let total = 0;

  for (const session of validSessions) {
    const segs = input.segmentsBySession.get(session.id) ?? [];
    let sessionSeconds = 0;
    for (const seg of segs) {
      const clipped = clipSegment(seg, startMs, endMs, nowMs);
      if (!clipped) continue;
      const secs = Math.floor((clipped.end - clipped.start) / 1000);
      sessionSeconds += secs;
    }
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
    const overlapsDay = input.activeSegments.some((seg) => clipSegment(seg, startMs, endMs, nowMs) !== null);
    if (overlapsDay) {
      let secs = 0;
      for (const seg of input.activeSegments) {
        const clipped = clipSegment(seg, startMs, endMs, nowMs);
        if (clipped) secs += Math.floor((clipped.end - clipped.start) / 1000);
      }
      running_session = {
        session_id: input.activeSession.id,
        subject_id: input.activeSession.subjectId,
        started_at: toIso(input.activeSession.startedAtMs),
        status: input.activeSession.status,
        active_seconds: secs,
        current_segment_started_at: openSeg ? toIso(openSeg.startedAtMs) : null,
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

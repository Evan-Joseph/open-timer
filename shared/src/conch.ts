/**
 * 神奇海螺（conch）：「下一步做什么」推荐的领域层。
 *
 * 只做纯函数：活动门槛判定、紧凑时间线编码、user prompt 组装、
 * LLM 原始输出解析清洗。HTTP/密钥/模型调用在 server 层。
 * 设计：docs/神奇海螺-下一步推荐-设计-2026-08-23.md
 */

import type { ActiveSegmentRow, SessionRow, SubjectId } from './types.js';
import { SUBJECTS, subjectById } from './subjects.js';
import { DAY_MS, SHANGHAI_OFFSET_MS, utcMsToShanghaiDate } from './shanghai.js';
import { isCountedSegment } from './state-machine.js';

export type ConchWindow = 'all' | '30d' | '7d';
export const CONCH_WINDOWS: readonly ConchWindow[] = ['all', '30d', '7d'];

export const CONCH_WINDOW_LABEL: Record<ConchWindow, string> = {
  all: '从始至今',
  '30d': '近 30 天',
  '7d': '近 7 天',
};

export function conchWindowDays(w: ConchWindow): number {
  return w === 'all' ? 0 : w === '30d' ? 30 : 7;
}

/** 活动门槛：最近 7 个北京日（含今日）内有有效会话才算活跃。 */
export const CONCH_ACTIVE_DAYS = 7;

export type ConchActionKind = 'lecture' | 'problems' | 'book' | 'review' | 'test' | 'other';
export type ConchConfidence = 'high' | 'medium' | 'low';
export type ConchSkipReason = 'not_started' | 'inactive';

/** LLM 必须返回的单科目建议（与 system prompt 中的 schema 一致）。 */
export interface ConchSubjectRec {
  subject_id: SubjectId;
  next_action: string;
  action_kind: ConchActionKind;
  topic: string | null;
  pattern: string | null;
  rationale: string;
  confidence: ConchConfidence;
  /** 备选下一步（可多条，前端可「换一换」轮换、逐条点击开工） */
  alternatives: string[];
}

export interface ConchSubjectResult extends ConchSubjectRec {
  display_name: string;
  running_now: boolean;
  last_active_date: string;
}

export interface ConchSkippedEntry {
  subject_id: SubjectId;
  display_name: string;
  reason: ConchSkipReason;
}

export interface ConchAskResponse {
  window: ConchWindow;
  generated_at: string;
  /** 当前建议输入最早变化的时刻；与 revision/model 共同决定缓存可用性。 */
  cache_valid_until: string;
  /** 仅在海螺已完成时间线事实变化时推进，用于长期缓存失效。 */
  conch_revision: number;
  /** 通用审计 revision，保留给诊断/兼容；不作为海螺缓存键。 */
  revision: number;
  model: string;
  subjects: ConchSubjectResult[];
  skipped: ConchSkippedEntry[];
}

/* ---------- 上下文组装 ---------- */

export interface ConchBuildInput {
  nowMs: number;
  window: ConchWindow;
  /** 全时段会话（调用方一次取全量，内部只保留已完成且计入的专注事实）。 */
  sessions: SessionRow[];
  segmentsBySession: Map<string, ActiveSegmentRow[]>;
  minSegmentMs: number;
}

export interface ConchContextResult {
  active: SubjectId[];
  skipped: ConchSkippedEntry[];
  /** 无活跃科目时为空串。 */
  userPrompt: string;
  /** 不含备注的时间线行数（日志/调试用，避免备注全文进日志）。 */
  lineCount: number;
}

/** 单科目行数超过该值时，早于 45 天的部分按月聚合。 */
export const CONCH_MAX_LINES_PER_SUBJECT = 150;
const CONCH_FULL_DETAIL_DAYS = 45;
const CONCH_AGG_MONTH_NOTES = 3;
const CONCH_NOTE_TRUNCATE = 20;

function fmtBeijing(ms: number, withDate = true): string {
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return withDate ? `${MM}-${DD} ${hh}:${mm}` : `${hh}:${mm}`;
}

function fmtDur(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function fmtHours(secs: number): string {
  return `${(secs / 3600).toFixed(1)}h`;
}

/** 会话在 [windowStart, windowEnd] 内的计入秒数（误触过滤 + 窗口裁剪；开放段截至 windowEnd）。 */
export function conchSessionSeconds(
  segs: ActiveSegmentRow[],
  windowStartMs: number,
  windowEndMs: number,
  minSegmentMs: number,
): number {
  let secs = 0;
  for (const seg of segs) {
    if (!isCountedSegment(seg, minSegmentMs)) continue;
    const rawEnd = seg.endedAtMs ?? windowEndMs;
    const cs = Math.max(seg.startedAtMs, windowStartMs);
    const ce = Math.min(rawEnd, windowEndMs);
    if (ce > cs) secs += Math.floor((ce - cs) / 1000);
  }
  return secs;
}

interface MonthAgg {
  key: string;
  count: number;
  seconds: number;
  /** 该月最近的几条备注（倒序取）。 */
  notes: string[];
}

/** 组装神奇海螺上下文：活动门槛 + 紧凑时间线 + user prompt。 */
export function buildConchContext(input: ConchBuildInput): ConchContextResult {
  const { nowMs, window, sessions, segmentsBySession, minSegmentMs } = input;
  const days = conchWindowDays(window);
  const windowStartMs = days === 0 ? 0 : nowMs - days * DAY_MS;
  const today = utcMsToShanghaiDate(nowMs);
  const recentStartMs = nowMs - (CONCH_ACTIVE_DAYS - 1) * DAY_MS - ((nowMs + SHANGHAI_OFFSET_MS) % DAY_MS);

  const bySubject = new Map<SubjectId, SessionRow[]>();
  for (const s of SUBJECTS) bySubject.set(s.id, []);
  // 海螺只依据“已完成且计入”的专注事实。不让正在开始/暂停/继续中的会话、
  // 误触短片段进入 prompt，故这些操作不会改变建议也不需要打断缓存。
  const completed = sessions.filter(
    (s) =>
      s.status === 'stopped' &&
      subjectById(s.subjectId) &&
      conchSessionSeconds(segmentsBySession.get(s.id) ?? [], 0, nowMs, minSegmentMs) > 0,
  );
  for (const s of completed) bySubject.get(s.subjectId)!.push(s);

  const active: SubjectId[] = [];
  const skipped: ConchSkippedEntry[] = [];
  const blocks: string[] = [];
  let lineCount = 0;

  for (const def of SUBJECTS) {
    const all = bySubject.get(def.id)!;
    const secsOf = (s: SessionRow, startMs: number) =>
      conchSessionSeconds(segmentsBySession.get(s.id) ?? [], startMs, nowMs, minSegmentMs);
    const allTimeCount = all.length;
    if (allTimeCount === 0) {
      skipped.push({ subject_id: def.id, display_name: def.displayName, reason: 'not_started' });
      continue;
    }
    // 活跃 = 近 7 个北京日有已完成、计入的专注事实（纯误触/作废/进行中不算）。
    const recentCount = all.filter((s) => secsOf(s, recentStartMs) > 0).length;
    if (recentCount === 0) {
      skipped.push({ subject_id: def.id, display_name: def.displayName, reason: 'inactive' });
      continue;
    }
    active.push(def.id);

    // 窗口内会话（按开始时间升序）
    const inWindow = all
      .filter((s) => (s.endedAtMs ?? nowMs) >= windowStartMs && s.startedAtMs <= nowMs)
      .sort((a, b) => a.startedAtMs - b.startedAtMs);

    let totalSecs = 0;
    for (const s of inWindow) totalSecs += secsOf(s, windowStartMs);

    const last7StartMs = recentStartMs;
    let recentSecs = 0;
    let recentSessions = 0;
    for (const s of inWindow) {
      const secs = secsOf(s, last7StartMs);
      if (secs > 0 || (s.startedAtMs >= last7StartMs && (s.status === 'running' || s.status === 'paused'))) {
        recentSecs += secs;
        recentSessions += 1;
      }
    }

    let lastActivity = '';
    const lastEnded = [...inWindow].reverse().find((s) => s.endedAtMs !== null);
    if (lastEnded) lastActivity = fmtBeijing(lastEnded.endedAtMs!);

    const detailCutoffMs = nowMs - CONCH_FULL_DETAIL_DAYS * DAY_MS;
    const needAggregate = inWindow.length > CONCH_MAX_LINES_PER_SUBJECT;
    const aggMonths = new Map<string, MonthAgg>();
    const lines: string[] = [];

    for (const s of inWindow) {
      const secs = secsOf(s, windowStartMs);
      const note = s.endNote ?? s.intentNote;
      const notePart = note ? ` "${note}"` : '';
      if (needAggregate && s.startedAtMs < detailCutoffMs) {
        const key = utcMsToShanghaiDate(s.startedAtMs).slice(0, 7); // YYYY-MM
        let agg = aggMonths.get(key);
        if (!agg) {
          agg = { key, count: 0, seconds: 0, notes: [] };
          aggMonths.set(key, agg);
        }
        agg.count += 1;
        agg.seconds += secs;
        if (note && agg.notes.length < CONCH_AGG_MONTH_NOTES) agg.notes.push(note);
        continue;
      }

      lines.push(
        `${fmtBeijing(s.startedAtMs)}–${fmtBeijing(s.endedAtMs!, false)} ${fmtDur(secs)}${notePart}`,
      );
    }

    // 聚合月行置于明细之前（时间升序）
    const aggLines = [...aggMonths.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((agg) => {
        const notePart = agg.notes.length
          ? ` · 近期备注: ${agg.notes
              .map((n) => (n.length > CONCH_NOTE_TRUNCATE ? `${n.slice(0, CONCH_NOTE_TRUNCATE)}…` : n))
              .map((n) => `"${n}"`)
              .join(' ')}`
          : '';
        return `${agg.key.slice(5)}月 · ${agg.count} 次 · ${fmtHours(agg.seconds)}${notePart}`;
      });

    lineCount += aggLines.length + lines.length;
    blocks.push(
      [
        `=== ${def.displayName} (${def.id}) ===`,
        `累计 ${inWindow.length} 次 · ${fmtHours(totalSecs)} ｜ 近7天 ${recentSessions} 次 · ${fmtHours(recentSecs)} ｜ 最近活动 ${lastActivity || '—'}`,
        ...aggLines,
        ...lines,
      ].join('\n'),
    );
  }

  const skippedNote = skipped.length
    ? `\n（${skipped.map((s) => s.display_name).join('、')}未列入：无近期活动或未开始）\n`
    : '';

  const userPrompt =
    active.length === 0
      ? ''
      : `统计窗口：${CONCH_WINDOW_LABEL[window]}\n` +
        `以下是 ${active.length} 个近期活跃科目的时间线（旧→新），请按要求返回 JSON。\n${skippedNote}\n` +
        blocks.join('\n\n') +
        '\n\n请返回符合 schema 的原始 JSON。';

  return { active, skipped, userPrompt, lineCount };
}

/* ---------- LLM 输出解析（字段级宽容、结构级严格） ---------- */

const ACTION_KINDS: readonly ConchActionKind[] = ['lecture', 'problems', 'book', 'review', 'test', 'other'];
const CONFIDENCES: readonly ConchConfidence[] = ['high', 'medium', 'low'];

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function strOrNull(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? truncate(t, max) : null;
}

/** 备选列表解析：优先 `alternatives` 数组；兼容旧版单条 `alternative`。去重、截断、至多 3 条。 */
function parseAlternatives(o: Record<string, unknown>): string[] {
  const rawList = Array.isArray(o.alternatives)
    ? o.alternatives
    : typeof o.alternative === 'string' && o.alternative.trim()
      ? [o.alternative]
      : [];
  const out: string[] = [];
  for (const item of rawList) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    const cut = truncate(t, 80);
    if (!out.includes(cut)) out.push(cut);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * 解析并清洗 LLM 原始输出。expected 为本次活跃科目集合。
 * 返回按 SUBJECTS 排序的建议数组；结构性失败（非 JSON / 无 subjects 数组）返回 null。
 */
export function parseConchLlmOutput(raw: string, expected: readonly SubjectId[]): ConchSubjectRec[] | null {
  let text = raw.trim();
  // 容错：模型偶尔包 code fence
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const arr = (obj as { subjects?: unknown }).subjects;
  if (!Array.isArray(arr)) return null;

  const expectedSet = new Set(expected);
  const seen = new Set<SubjectId>();
  const recs: ConchSubjectRec[] = [];

  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = o.subject_id;
    if (typeof id !== 'string' || !expectedSet.has(id as SubjectId) || seen.has(id as SubjectId)) continue;
    const action = typeof o.next_action === 'string' ? o.next_action.trim() : '';
    if (!action) continue; // 缺核心字段的条目整体丢弃

    seen.add(id as SubjectId);
    recs.push({
      subject_id: id as SubjectId,
      next_action: truncate(action, 80),
      action_kind: ACTION_KINDS.includes(o.action_kind as ConchActionKind) ? (o.action_kind as ConchActionKind) : 'other',
      topic: strOrNull(o.topic, 80),
      pattern: strOrNull(o.pattern, 120),
      rationale: truncate(typeof o.rationale === 'string' ? o.rationale.trim() : '', 120),
      confidence: CONFIDENCES.includes(o.confidence as ConchConfidence) ? (o.confidence as ConchConfidence) : 'low',
      alternatives: parseAlternatives(o),
    });
  }

  // 按固定科目序输出，缺失的活跃科目由服务端标记（不伪造）
  return SUBJECTS.filter((s) => seen.has(s.id)).map(
    (s) => recs.find((r) => r.subject_id === s.id)!,
  );
}

/* ---------- system prompt（定稿，见设计文档 §5.4） ---------- */

export const CONCH_SYSTEM_PROMPT = `你是「神奇海螺」，一名 11408 考研备考的节奏分析师。输入是用户（单用户本人）各科目
的真实计时记录：起止时间、有效时长、手动备注。你的唯一任务：为每个给出的科目推断
「下一步最应该做什么」。

【推断原则】
1. 先识别每个科目各自的节奏。常见如：看课→做对应章节题；基础题→强化题→冲刺题；
   看书→刷题；看课→看书→做题。不同科目节奏可能不同，逐个科目独立归纳，不要套用。
2. 以该科目最后一条记录为锚点外推下一步：上一步是看 E 章课，下一步大概率是做 E 章题；
   上一步是 B 章强化题且其节奏是基础→强化→冲刺，则下一步可能是 B 章冲刺题。
3. 检查缺步：对照近期「章节 × 步骤」的覆盖，若某章只看了课没做题、或只做了基础题
   缺强化，则优先建议补上这一步，并在 rationale 说明缺什么。
4. 只依据备注中出现过的事实推断。不得编造备注里从未出现的教材名、题集名、题号、
   课程名；引用资料时用用户自己的叫法（如"你一直在做的那本题集"）。
5. next_action 必须具体可立即执行，≤40 个汉字。好例子："做第5章 定积分的冲刺题"；
   坏例子："继续学数学"。
6. 若某科目历史太稀疏或规律不明，confidence 给 "low"，给出最稳妥的一般性下一步
   （如"继续上次未完成的进度"），并在 rationale 说明缺什么信息。
7. alternatives 给 1–3 条与 next_action 不同方向的备选（如主推荐是补题，备选可以是
   推进下一章、回看错题、换一种学习形式），每条同样具体、≤40 汉字；没有合适备选时给 []。

【硬约束】
- 只输出输入中给出的科目；不得新增、不得遗漏。
- 只返回符合 schema 的原始 JSON：不要 markdown 代码块、不要解释文字。

【返回 schema】
{
  "subjects": [
    {
      "subject_id": "string，与输入一致的科目 id",
      "next_action": "string，≤40 汉字，具体的下一步",
      "action_kind": "lecture|problems|book|review|test|other",
      "topic": "string|null，章节/主题，如「第5章 定积分」",
      "pattern": "string|null，观察到的节奏一句话，如「看课→基础题→强化题」",
      "rationale": "string，≤60 汉字，为什么推荐这一步",
      "confidence": "high|medium|low",
      "alternatives": ["string，1–3 条与主推荐不同方向的备选下一步，没有则空数组"]
    }
  ]
}`;

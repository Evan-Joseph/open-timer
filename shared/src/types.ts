/** 核心类型定义。所有持久化时间戳均为 UTC epoch 毫秒整数。 */

export type SubjectId =
  | 'math'
  | 'english'
  | 'data-structures'
  | 'computer-organization'
  | 'operating-systems'
  | 'computer-networks'
  | 'politics';

export type AggregateGroup = 'math' | 'english' | '408' | 'politics';

export interface SubjectDef {
  id: SubjectId;
  displayName: string;
  aggregateGroup: AggregateGroup;
  /** 前端色板键；具体颜色在 web 层 token 中定义，保证深浅两套。 */
  colorId: string;
  sortOrder: number;
}

export type SessionStatus = 'running' | 'paused' | 'stopped' | 'voided';

export type SessionEventKind = 'created' | 'paused' | 'resumed' | 'stopped' | 'voided';

export type EndReason = 'manual' | 'subject_switch' | 'void';

export interface ActiveSegmentRow {
  id?: number;
  sessionId: string;
  startedAtMs: number;
  /** null = 当前开放段 */
  endedAtMs: number | null;
}

export interface SessionRow {
  id: string;
  userId: string;
  subjectId: SubjectId;
  status: SessionStatus;
  intentNote: string | null;
  endNote: string | null;
  endReason: EndReason | null;
  startedAtMs: number;
  endedAtMs: number | null;
  activeSeconds: number;
  createdAtMs: number;
}

export interface SessionEventRow {
  id?: number;
  sessionId: string;
  kind: SessionEventKind;
  idempotencyKey: string;
  serverTimeMs: number;
  payloadJson: string | null;
}

export interface ManualAdjustmentRow {
  id?: number;
  sessionId: string;
  kind: 'retime' | 'void' | 'note';
  beforeJson: string;
  afterJson: string;
  reason: string | null;
  createdAtMs: number;
}

export interface ApiCredentialRow {
  id: string;
  name: string;
  scope: 'read_only';
  tokenSha256: string;
  revokedAtMs: number | null;
  createdAtMs: number;
}

/* ---------- API 契约类型（OpenAPI 对应） ---------- */

export interface SubjectEntry {
  subject_id: SubjectId;
  display_name: string;
  aggregate_group: AggregateGroup;
  color_id: string;
  sort_order: number;
}

export interface BySubjectEntry {
  subject_id: SubjectId;
  display_name: string;
  active_seconds: number;
  session_count: number;
}

export interface AggregateEntry {
  group: AggregateGroup;
  active_seconds: number;
}

export interface SessionEntry {
  session_id: string;
  subject_id: SubjectId;
  started_at: string; // UTC ISO 8601
  ended_at: string | null;
  active_seconds: number;
  status: SessionStatus;
  end_reason: EndReason | null;
  note: string | null;
}

/**
 * `/sessions` 详情条目：与 SessionEntry 的单日兼容字段共存，明确区分窗口裁剪值与会话全量事实。
 * 备注是公开时间执行元数据，不代表任何学习完成/掌握判断。
 */
export interface RangeSessionEntry extends SessionEntry {
  window_active_seconds: number;
  intent_note: string | null;
  end_note: string | null;
  session_active_seconds: number;
  longest_continuous_seconds: number;
  last_continuous_seconds: number;
  last_continuous_ended_at: string | null;
  segments: Array<{ started_at: string; ended_at: string | null }>;
}

export interface ReadAdjustmentEntry {
  session_id: string;
  subject_id: SubjectId;
  status: SessionStatus;
  kind: ManualAdjustmentRow['kind'];
  reason: string | null;
  at: string;
}

export interface RangeSessionsResponse {
  /** 兼容旧单日调用时存在。 */
  date?: string;
  from: string;
  to: string;
  timezone: 'Asia/Shanghai';
  generated_at: string;
  revision: number;
  count: number;
  sessions: RangeSessionEntry[];
  adjustments_or_revocations: ReadAdjustmentEntry[];
}

export interface DailyRangeDay {
  date: string;
  total_active_seconds: number;
  by_subject: BySubjectEntry[];
  aggregates: AggregateEntry[];
  session_count: number;
}

export interface DailySummariesResponse {
  from: string;
  to: string;
  timezone: 'Asia/Shanghai';
  generated_at: string;
  revision: number;
  total_active_seconds: number;
  by_subject: Array<Pick<BySubjectEntry, 'subject_id' | 'display_name' | 'active_seconds'>>;
  aggregates: AggregateEntry[];
  active_dates: string[];
  days: DailyRangeDay[];
}

export interface RunningSessionEntry {
  session_id: string;
  subject_id: SubjectId;
  started_at: string;
  status: 'running' | 'paused';
  /** 截至 generated_at 的暂算净秒数 */
  active_seconds: number;
  current_segment_started_at: string | null;
  /** 当前开放段的活跃秒数（running 时持续增长；paused 时冻结为末段净秒） */
  current_segment_active_seconds: number | null;
  /** 暂停开始时刻（paused 时存在；= 最后一段的结束时刻） */
  paused_at: string | null;
  intent_note: string | null;
}

export interface AdjustmentEntry {
  session_id: string;
  kind: ManualAdjustmentRow['kind'];
  reason: string | null;
  at: string;
}

export interface DailySummary {
  date: string; // YYYY-MM-DD
  timezone: 'Asia/Shanghai';
  revision: number;
  generated_at: string;
  total_active_seconds: number;
  by_subject: BySubjectEntry[];
  aggregates: AggregateEntry[];
  sessions: SessionEntry[];
  running_session: RunningSessionEntry | null;
  adjustments_or_revocations: AdjustmentEntry[];
}

export interface StateSnapshot {
  /** 前端用于单调时钟校准的服务端当前时间 */
  server_now_ms: number;
  server_now_iso: string;
  active_session: RunningSessionEntry | null;
  /** 今日（Asia/Shanghai）累计净秒数 */
  today_active_seconds: number;
  today_date: string;
  /** 神奇海螺已完成时间线 revision；开始/暂停/继续不推进。 */
  conch_revision: number;
}

export interface HealthResponse {
  status: 'ok';
  server_time: string;
  version: string;
}

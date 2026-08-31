/** API 客户端：所有写请求自动携带 Idempotency-Key（重试安全）。 */

export interface SubjectApi {
  subject_id: string;
  display_name: string;
  aggregate_group: string;
  color_id: string;
  sort_order: number;
}

export interface SegmentApi {
  started_at: string;
  ended_at: string | null;
}

export interface SessionApi {
  session_id: string;
  subject_id: string;
  started_at: string;
  ended_at: string | null;
  /** 兼容字段：当前查询窗口（date/from-to）内净秒数。 */
  active_seconds: number;
  /** 与 active_seconds 同值，供跨日消费者显式使用。 */
  window_active_seconds: number;
  status: 'running' | 'paused' | 'stopped' | 'voided';
  end_reason: 'manual' | 'subject_switch' | 'void' | null;
  note: string | null;
  intent_note: string | null;
  /** 仅结束备注（跨端判断「刚结束待补备注」用） */
  end_note: string | null;
  /** 会话全量净专注秒数，不按当前 date 查询窗口裁剪（结束反馈跨端一致性使用）。 */
  session_active_seconds: number;
  /** 所有计入片段中最长的一段，训练长时专注时的真实连续时长。 */
  longest_continuous_seconds: number;
  /** 最后一个计入片段的时长，休息预算使用。 */
  last_continuous_seconds: number;
  /** 最后一个计入片段结束时刻，跨端休息锚点使用。 */
  last_continuous_ended_at: string | null;
  segments: SegmentApi[];
}

/** stop 写路径返回的会话全量指标；发起端结束反馈以服务端事实校正。 */
export interface StopSessionApi {
  session_id: string;
  ended_at: string | null;
  session_active_seconds: number;
  longest_continuous_seconds: number;
  last_continuous_seconds: number;
  last_continuous_ended_at: string | null;
}

export interface ActiveSessionApi {
  session_id: string;
  subject_id: string;
  started_at: string;
  status: 'running' | 'paused';
  active_seconds: number;
  current_segment_started_at: string | null;
  /** 当前开放段活跃秒数（running 增长，paused 冻结） */
  current_segment_active_seconds: number | null;
  /** 暂停（离开）开始时刻 */
  paused_at: string | null;
  intent_note: string | null;
}

export interface StateApi {
  server_now_ms: number;
  server_now_iso: string;
  active_session: ActiveSessionApi | null;
  today_active_seconds: number;
  today_date: string;
  /** 通用审计事件水位（= 最大审计 id）；ETag/诊断使用，不作为海螺缓存键。 */
  revision: number;
  /** 海螺已完成时间线 revision；仅完成/备注/修正/撤回/重开推进。 */
  conch_revision: number;
}

/** SPA 刷新专用原子快照：服务端一次读取同时给状态和当天时间轴，减少 Worker 请求。 */
export interface SnapshotApi {
  state: StateApi;
  sessions: SessionApi[];
}

export interface RangeSessionsApi {
  date?: string;
  from: string;
  to: string;
  timezone: 'Asia/Shanghai';
  generated_at: string;
  revision: number;
  count: number;
  sessions: SessionApi[];
  adjustments_or_revocations: Array<{
    session_id: string;
    subject_id: string;
    status: SessionApi['status'];
    kind: 'retime' | 'void' | 'note';
    reason: string | null;
    at: string;
  }>;
}

export interface RangeDailySummaryApi {
  from: string;
  to: string;
  timezone: 'Asia/Shanghai';
  generated_at: string;
  revision: number;
  total_active_seconds: number;
  by_subject: Array<{ subject_id: string; display_name: string; active_seconds: number }>;
  aggregates: Array<{ group: 'math' | 'english' | '408' | 'politics'; active_seconds: number }>;
  active_dates: string[];
  days: Array<{
    date: string;
    total_active_seconds: number;
    by_subject: DailySummaryApi['by_subject'];
    aggregates: Array<{ group: 'math' | 'english' | '408' | 'politics'; active_seconds: number }>;
    session_count: number;
  }>;
}

export interface DailySummaryApi {
  date: string;
  total_active_seconds: number;
  by_subject: Array<{ subject_id: string; display_name: string; active_seconds: number; session_count: number }>;
}

/* ---------- 神奇海螺 ---------- */

export type ConchWindow = 'all' | '30d' | '7d';

export interface ConchSubjectApi {
  subject_id: string;
  display_name: string;
  running_now: boolean;
  last_active_date: string;
  next_action: string;
  action_kind: 'lecture' | 'problems' | 'book' | 'review' | 'test' | 'other';
  topic: string | null;
  pattern: string | null;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  alternatives: string[];
}

export interface ConchSkippedApi {
  subject_id: string;
  display_name: string;
  reason: 'not_started' | 'inactive';
}

export interface ConchAskResponseApi {
  window: ConchWindow;
  generated_at: string;
  /** 服务端缓存与本机展示缓存的共同失效时刻（最早输入变化边界，最晚为下一个北京时间自然日）。 */
  cache_valid_until: string;
  conch_revision: number;
  revision: number;
  model: string;
  subjects: ConchSubjectApi[];
  skipped: ConchSkippedApi[];
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/** 海螺专用结果：只有浏览器 fetch 被拒绝时 networkError 才为 true。 */
export interface ConchAskResult extends ApiResult<ConchAskResponseApi> {
  networkError: boolean;
  requestId: string;
  /** 同一建议正在生成，或时间线在生成中更新；客户端应等待后自动重试。 */
  generating: boolean;
  retryAfterMs: number | null;
}

/**
 * 海螺不产生状态变更，不能继承会话写路径的 Idempotency-Key。
 * Safari 旧版缺少 crypto.randomUUID() 时仍使用 Web Crypto 的随机字节生成诊断号。
 */
export async function conchAsk(window: ConchWindow, force = false): Promise<ConchAskResult> {
  let requestId = 'conch-client-unavailable';
  try {
    requestId = `conch-${createClientUuid()}`;
    const result = await apiPost<ConchAskResponseApi>('/api/v1/conch/ask', { window, ...(force ? { force: true } : {}) }, {
      idempotency: false,
      clientRequestId: requestId,
    });
    const error = (result.data as unknown as { error?: string; retry_after_ms?: unknown } | null)?.error;
    const retryAfter = (result.data as unknown as { retry_after_ms?: unknown } | null)?.retry_after_ms;
    return {
      ...result,
      networkError: false,
      requestId,
      generating: result.status === 409 && (error === 'CONCH_GENERATING' || error === 'CONCH_CONTEXT_STALE'),
      retryAfterMs: typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null,
    };
  } catch {
    return { ok: false, status: 0, data: null, networkError: true, requestId, generating: false, retryAfterMs: null };
  }
}

/** 海螺缓存校验专用：仅取已完成时间线的 semantic revision。 */
export function getConchRevision() {
  return apiGet<{ conch_revision: number; model: string | null }>('/api/v1/conch/revision');
}

/**
 * 所有浏览器端随机关联键的唯一实现。Safari 未提供 randomUUID 时仍使用 Web Crypto，
 * 不能让已成功的计时写操作在本地同步通知阶段抛异常。
 */
export function createClientUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 v4：保持幂等键与诊断编号均使用 Web Crypto，不降级到 Math.random。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newIdempotencyKey(): string {
  return createClientUuid();
}

interface RequestOptions {
  /** 会话写操作默认启用；读取、连接管理和海螺请求明确关闭。 */
  idempotency?: boolean;
  /** 仅海螺用于把 Safari 端请求与 Worker 安全日志关联。 */
  clientRequestId?: string;
}

async function request(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const needsIdempotency = options.idempotency ?? (method !== 'GET' && method !== 'HEAD');
  if (needsIdempotency) headers['idempotency-key'] = newIdempotencyKey();
  if (options.clientRequestId) headers['x-client-request-id'] = options.clientRequestId;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await request('GET', path);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
  const res = await request('POST', path, body ?? {}, options);
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

export async function apiPatch<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  const res = await request('PATCH', path, body);
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

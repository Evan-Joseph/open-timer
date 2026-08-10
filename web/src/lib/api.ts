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
  active_seconds: number;
  status: 'running' | 'paused' | 'stopped' | 'voided';
  end_reason: 'manual' | 'subject_switch' | 'void' | null;
  note: string | null;
  segments: SegmentApi[];
}

export interface ActiveSessionApi {
  session_id: string;
  subject_id: string;
  started_at: string;
  status: 'running' | 'paused';
  active_seconds: number;
  current_segment_started_at: string | null;
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
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers['idempotency-key'] = newIdempotencyKey();
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

export async function apiPost<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await request('POST', path, body ?? {});
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

export async function apiPatch<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T | null }> {
  const res = await request('PATCH', path, body);
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * 每日备份：events.jsonl（可重放权威源）+ sessions.jsonl 写入 R2。
 * 由 Cron Triggers 触发（wrangler.jsonc triggers.crons，15:00 UTC = 北京 23:00）。
 * 滚动保留 RETENTION_DAYS 天；更早的备份对象删除。
 *
 * 行格式与 GET /api/v1/export/events.jsonl 完全一致（共用 eventToLine），
 * 备份文件可直接用于重放重建。
 */

import { utcMsToShanghaiDate } from '@clock/shared';
import type { SessionEventRow, SessionRow } from '@clock/shared';

/** R2 binding 的最小接口（Workers 的 R2Bucket 结构兼容）。 */
export interface BackupBucket {
  put(key: string, value: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
  delete(keys: string[]): Promise<unknown>;
}

export interface BackupSource {
  allEvents(): Promise<SessionEventRow[]>;
  allSessions(): Promise<SessionRow[]>;
}

export interface BackupResult {
  date: string;
  written: string[];
  pruned: string[];
}

export const RETENTION_DAYS = 30;

/** 与导出端点同一行格式：重放字段齐全，payload 解析为对象。 */
export function eventToLine(e: SessionEventRow): string {
  return JSON.stringify({
    event_id: e.id,
    session_id: e.sessionId,
    kind: e.kind,
    idempotency_key: e.idempotencyKey,
    server_time_ms: e.serverTimeMs,
    payload: e.payloadJson ? JSON.parse(e.payloadJson) : null,
  });
}

export function sessionToLine(s: SessionRow): string {
  return JSON.stringify({
    session_id: s.id,
    user_id: s.userId,
    subject_id: s.subjectId,
    status: s.status,
    intent_note: s.intentNote,
    end_note: s.endNote,
    end_reason: s.endReason,
    started_at_ms: s.startedAtMs,
    ended_at_ms: s.endedAtMs,
    active_seconds: s.activeSeconds,
    created_at_ms: s.createdAtMs,
  });
}

function toNdjson(lines: string[]): string {
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** 备份键日期早于保留窗口则清理；键格式 backup/YYYY-MM-DD/<file>。 */
export function staleBackupKeys(keys: string[], nowMs: number): string[] {
  const cutoffMs = nowMs - RETENTION_DAYS * 86_400_000;
  return keys.filter((key) => {
    const day = key.split('/')[1];
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(dayMs) && dayMs < cutoffMs;
  });
}

export async function runBackup(source: BackupSource, bucket: BackupBucket, nowMs: number): Promise<BackupResult> {
  const date = utcMsToShanghaiDate(nowMs);
  const events = await source.allEvents();
  const sessions = await source.allSessions();

  const eventsKey = `backup/${date}/events.jsonl`;
  const sessionsKey = `backup/${date}/sessions.jsonl`;
  await bucket.put(eventsKey, toNdjson(events.map(eventToLine)));
  await bucket.put(sessionsKey, toNdjson(sessions.map(sessionToLine)));

  const listed = await bucket.list({ prefix: 'backup/' });
  const pruned = staleBackupKeys(
    listed.objects.map((o) => o.key),
    nowMs,
  );
  if (pruned.length > 0) await bucket.delete(pruned);

  return { date, written: [eventsKey, sessionsKey], pruned };
}

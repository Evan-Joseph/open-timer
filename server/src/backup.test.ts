import { describe, expect, it } from 'vitest';
import { runBackup, staleBackupKeys, eventToLine, RETENTION_DAYS } from './backup.js';
import type { BackupBucket } from './backup.js';
import type { BackupSource } from './backup.js';
import type { SessionEventRow, SessionRow } from '@clock/shared';

/** 北京 2026-08-20 23:00（= 15:00 UTC，即 cron 触发时刻） */
const NOW_MS = Date.parse('2026-08-20T15:00:00Z');

function makeFakeBucket(initialKeys: string[] = []) {
  const store = new Map<string, string>();
  const keys = new Set(initialKeys);
  const bucket: BackupBucket = {
    async put(key, value) {
      store.set(key, value);
      keys.add(key);
    },
    async list({ prefix }) {
      return { objects: [...keys].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(toDelete) {
      for (const k of toDelete) {
        keys.delete(k);
        store.delete(k);
      }
    },
  };
  return { bucket, store, keys };
}

const EVENTS: SessionEventRow[] = [
  {
    id: 1,
    sessionId: '01SESSION',
    kind: 'created',
    idempotencyKey: 'start:key-0001',
    serverTimeMs: NOW_MS - 3_600_000,
    payloadJson: JSON.stringify({ subject_id: 'math' }),
  },
  {
    id: 2,
    sessionId: '01SESSION',
    kind: 'stopped',
    idempotencyKey: 'stop:key-0002',
    serverTimeMs: NOW_MS - 1_800_000,
    payloadJson: null,
  },
];

const SESSIONS: SessionRow[] = [
  {
    id: '01SESSION',
    userId: 'owner',
    subjectId: 'math',
    status: 'stopped',
    intentNote: null,
    endNote: null,
    endReason: 'manual',
    startedAtMs: NOW_MS - 3_600_000,
    endedAtMs: NOW_MS - 1_800_000,
    activeSeconds: 1800,
    createdAtMs: NOW_MS - 3_600_000,
  },
];

const SOURCE: BackupSource = {
  allEvents: async () => EVENTS,
  allSessions: async () => SESSIONS,
};

describe('每日备份（Cron + R2）', () => {
  it('events.jsonl 行格式与导出端点契约一致（可重放字段）', () => {
    const line = JSON.parse(eventToLine(EVENTS[0]));
    expect(line).toEqual({
      event_id: 1,
      session_id: '01SESSION',
      kind: 'created',
      idempotency_key: 'start:key-0001',
      server_time_ms: EVENTS[0].serverTimeMs,
      payload: { subject_id: 'math' },
    });
    // payload_json 为 null 时 payload 落 null 而非解析错误
    expect(JSON.parse(eventToLine(EVENTS[1])).payload).toBeNull();
  });

  it('按北京日期写入 events.jsonl 与 sessions.jsonl', async () => {
    const { bucket, store } = makeFakeBucket();
    const result = await runBackup(SOURCE, bucket, NOW_MS);
    expect(result.date).toBe('2026-08-20'); // 15:00 UTC 在北京是 23:00 同日
    expect(result.written).toEqual(['backup/2026-08-20/events.jsonl', 'backup/2026-08-20/sessions.jsonl']);

    const events = store.get('backup/2026-08-20/events.jsonl')!;
    expect(events.trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(events.trim().split('\n')[0]).event_id).toBe(1);

    const sessions = store.get('backup/2026-08-20/sessions.jsonl')!;
    const parsed = JSON.parse(sessions.trim());
    expect(parsed.session_id).toBe('01SESSION');
    expect(parsed.active_seconds).toBe(1800);
  });

  it('滚动保留：早于 30 天的备份键被清理，窗口内保留', async () => {
    const stale = 'backup/2026-07-01/events.jsonl'; // 50 天前
    const recent = 'backup/2026-08-01/events.jsonl'; // 19 天前
    const { bucket, keys } = makeFakeBucket([stale, recent]);
    const result = await runBackup(SOURCE, bucket, NOW_MS);
    expect(result.pruned).toEqual([stale]);
    expect(keys.has(stale)).toBe(false);
    expect(keys.has(recent)).toBe(true);
    expect(RETENTION_DAYS).toBe(30);
  });

  it('空库也能产出空 NDJSON 且不误删未知键', async () => {
    const empty: BackupSource = { allEvents: async () => [], allSessions: async () => [] };
    const { bucket, store, keys } = makeFakeBucket(['backup/notes.txt']);
    const result = await runBackup(empty, bucket, NOW_MS);
    expect(store.get('backup/2026-08-20/events.jsonl')).toBe('');
    expect(result.pruned).toEqual([]); // notes.txt 无日期段，不清理
    expect(keys.has('backup/notes.txt')).toBe(true);
  });

  it('staleBackupKeys 边界：保留窗口首日不清理，前一天清理', () => {
    // cutoff = NOW_MS - 30d = 2026-07-21T15:00Z；键按当日 00:00Z 比较
    const firstKept = '2026-07-22';
    const pruned = '2026-07-21';
    expect(staleBackupKeys([`backup/${firstKept}/e.jsonl`], NOW_MS)).toEqual([]);
    expect(staleBackupKeys([`backup/${pruned}/e.jsonl`], NOW_MS)).toEqual([`backup/${pruned}/e.jsonl`]);
  });

  it('写入 last-run.json 运行状态（ok/日期/计数），便于免凭据核对', async () => {
    const { bucket, store } = makeFakeBucket();
    await runBackup(SOURCE, bucket, NOW_MS);
    const status = JSON.parse(store.get('backup/last-run.json')!);
    expect(status.ok).toBe(true);
    expect(status.date).toBe('2026-08-20');
    expect(status.events).toBe(2);
    expect(status.sessions).toBe(1);
    expect(status.ran_at_ms).toBe(NOW_MS);
  });
});

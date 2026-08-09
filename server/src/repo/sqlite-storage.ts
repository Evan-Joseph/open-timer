/**
 * SQLite 存储适配器（better-sqlite3）。
 * 所有写路径在单个事务内完成"事件 + 段 + 会话状态"，保证可重放事实一致性。
 * 接口异步化，与 D1 适配器保持同一契约。
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SessionRow,
  SessionEventRow,
  ActiveSegmentRow,
  ManualAdjustmentRow,
  ApiCredentialRow,
  SubjectId,
} from '@clock/shared';
import { SUBJECTS } from '@clock/shared';
import type { Storage, ActiveSessionWithSegments } from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    subjectId: r.subject_id as SubjectId,
    status: r.status as SessionRow['status'],
    intentNote: (r.intent_note as string | null) ?? null,
    endNote: (r.end_note as string | null) ?? null,
    endReason: (r.end_reason as SessionRow['endReason']) ?? null,
    startedAtMs: r.started_at_ms as number,
    endedAtMs: (r.ended_at_ms as number | null) ?? null,
    activeSeconds: r.active_seconds as number,
    createdAtMs: r.created_at_ms as number,
  };
}

function rowToSegment(r: Record<string, unknown>): ActiveSegmentRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    startedAtMs: r.started_at_ms as number,
    endedAtMs: (r.ended_at_ms as number | null) ?? null,
  };
}

export class SqliteStorage implements Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  nowMs(): number {
    return Date.now();
  }

  async migrate(): Promise<void> {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)');
    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
    );
    for (const file of files) {
      const version = Number(file.split('_')[0]);
      if (!Number.isFinite(version)) throw new Error(`bad migration file name: ${file}`);
      if (applied.has(version)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const run = this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)').run(version, Date.now());
      });
      run();
    }
    this.seedSubjects();
  }

  private seedSubjects(): void {
    const insert = this.db.prepare(
      'INSERT INTO subject (id, display_name, aggregate_group, color_id, sort_order) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, aggregate_group=excluded.aggregate_group, color_id=excluded.color_id, sort_order=excluded.sort_order',
    );
    const tx = this.db.transaction(() => {
      for (const s of SUBJECTS) insert.run(s.id, s.displayName, s.aggregateGroup, s.colorId, s.sortOrder);
    });
    tx();
  }

  close(): void {
    this.db.close();
  }

  /* ---- owner ---- */

  async getOwnerPasswordHash(): Promise<string | null> {
    const r = this.db.prepare('SELECT password_hash FROM owner_credential WHERE id = 1').get() as
      | { password_hash: string }
      | undefined;
    return r?.password_hash ?? null;
  }

  async setOwnerPasswordHash(hash: string): Promise<void> {
    this.db
      .prepare('INSERT INTO owner_credential (id, password_hash, updated_at_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, updated_at_ms=excluded.updated_at_ms')
      .run(hash, Date.now());
  }

  async getOwnerSession(tokenSha: string): Promise<{ expiresAtMs: number } | null> {
    const r = this.db.prepare('SELECT expires_at_ms FROM owner_session WHERE token_sha = ?').get(tokenSha) as
      | { expires_at_ms: number }
      | undefined;
    if (!r) return null;
    if (r.expires_at_ms < Date.now()) {
      this.db.prepare('DELETE FROM owner_session WHERE token_sha = ?').run(tokenSha);
      return null;
    }
    return { expiresAtMs: r.expires_at_ms };
  }

  async createOwnerSession(tokenSha: string, expiresAtMs: number): Promise<void> {
    this.db
      .prepare('INSERT INTO owner_session (token_sha, expires_at_ms) VALUES (?, ?) ON CONFLICT(token_sha) DO UPDATE SET expires_at_ms=excluded.expires_at_ms')
      .run(tokenSha, expiresAtMs);
  }

  async deleteOwnerSession(tokenSha: string): Promise<void> {
    this.db.prepare('DELETE FROM owner_session WHERE token_sha = ?').run(tokenSha);
  }

  /* ---- sessions ---- */

  private sessionById(id: string): SessionRow | null {
    const r = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? rowToSession(r) : null;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.sessionById(id);
  }

  async getActiveSession(userId: string): Promise<ActiveSessionWithSegments | null> {
    const r = this.db
      .prepare("SELECT * FROM session WHERE user_id = ? AND status IN ('running','paused')")
      .get(userId) as Record<string, unknown> | undefined;
    if (!r) return null;
    const session = rowToSession(r);
    return { session, segments: await this.getSegments(session.id) };
  }

  async getSegments(sessionId: string): Promise<ActiveSegmentRow[]> {
    return (
      this.db
        .prepare('SELECT * FROM active_segment WHERE session_id = ? ORDER BY started_at_ms, id')
        .all(sessionId) as Array<Record<string, unknown>>
    ).map(rowToSegment);
  }

  private appendEvent(sessionId: string, kind: SessionEventRow['kind'], idempotencyKey: string, nowMs: number, payload?: unknown): void {
    this.db
      .prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, kind, idempotencyKey, nowMs, payload === undefined ? null : JSON.stringify(payload));
  }

  private recomputeActiveSeconds(sessionId: string): void {
    const rows = this.db
      .prepare('SELECT started_at_ms, ended_at_ms FROM active_segment WHERE session_id = ?')
      .all(sessionId) as Array<{ started_at_ms: number; ended_at_ms: number | null }>;
    let ms = 0;
    for (const s of rows) {
      if (s.ended_at_ms !== null) ms += Math.max(0, s.ended_at_ms - s.started_at_ms);
    }
    this.db.prepare('UPDATE session SET active_seconds = ? WHERE id = ?').run(Math.floor(ms / 1000), sessionId);
  }

  async createSession(args: {
    id: string;
    userId: string;
    subjectId: SubjectId;
    intentNote: string | null;
    nowMs: number;
    idempotencyKey: string;
  }): Promise<SessionRow | null> {
    const existing = await this.getActiveSession(args.userId);
    if (existing) return null; // 并发冲突：已有活动会话
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO session (id, user_id, subject_id, status, intent_note, end_note, end_reason, started_at_ms, ended_at_ms, active_seconds, created_at_ms) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, ?)',
        )
        .run(args.id, args.userId, args.subjectId, 'running', args.intentNote, args.nowMs, args.nowMs);
      this.db.prepare('INSERT INTO active_segment (session_id, started_at_ms, ended_at_ms) VALUES (?, ?, NULL)').run(args.id, args.nowMs);
      this.appendEvent(args.id, 'created', args.idempotencyKey, args.nowMs, { subject_id: args.subjectId });
    });
    try {
      tx();
    } catch (e) {
      // 唯一索引冲突（并发 start）
      return null;
    }
    return this.sessionById(args.id);
  }

  private requireActive(sessionId: string): SessionRow {
    const s = this.sessionById(sessionId);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    return s;
  }

  async pauseSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const s = this.requireActive(sessionId);
      if (s.status !== 'running') throw new Error('ILLEGAL_TRANSITION');
      this.db
        .prepare('UPDATE active_segment SET ended_at_ms = ? WHERE session_id = ? AND ended_at_ms IS NULL')
        .run(nowMs, sessionId);
      this.db.prepare("UPDATE session SET status = 'paused' WHERE id = ?").run(sessionId);
      this.appendEvent(sessionId, 'paused', idempotencyKey, nowMs);
      this.recomputeActiveSeconds(sessionId);
    });
    tx();
  }

  async resumeSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const s = this.requireActive(sessionId);
      if (s.status !== 'paused') throw new Error('ILLEGAL_TRANSITION');
      this.db.prepare('INSERT INTO active_segment (session_id, started_at_ms, ended_at_ms) VALUES (?, ?, NULL)').run(sessionId, nowMs);
      this.db.prepare("UPDATE session SET status = 'running' WHERE id = ?").run(sessionId);
      this.appendEvent(sessionId, 'resumed', idempotencyKey, nowMs);
    });
    tx();
  }

  async stopSession(sessionId: string, nowMs: number, endReason: string, idempotencyKey: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const s = this.requireActive(sessionId);
      if (s.status !== 'running' && s.status !== 'paused') throw new Error('ILLEGAL_TRANSITION');
      this.db
        .prepare('UPDATE active_segment SET ended_at_ms = ? WHERE session_id = ? AND ended_at_ms IS NULL')
        .run(nowMs, sessionId);
      this.db
        .prepare("UPDATE session SET status = 'stopped', ended_at_ms = ?, end_reason = ? WHERE id = ?")
        .run(nowMs, endReason, sessionId);
      this.appendEvent(sessionId, 'stopped', idempotencyKey, nowMs, { end_reason: endReason });
      this.recomputeActiveSeconds(sessionId);
    });
    tx();
  }

  async voidSession(sessionId: string, nowMs: number, reason: string | null, idempotencyKey: string): Promise<void> {
    const tx = this.db.transaction(() => {
      const s = this.requireActive(sessionId);
      if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
      this.db.prepare("UPDATE session SET status = 'voided', end_reason = 'void' WHERE id = ?").run(sessionId);
      this.appendEvent(sessionId, 'voided', idempotencyKey, nowMs, { reason });
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          sessionId,
          'void',
          JSON.stringify({ status: 'stopped', active_seconds: s.activeSeconds }),
          JSON.stringify({ status: 'voided' }),
          reason,
          nowMs,
        );
    });
    tx();
  }

  async setSessionNote(sessionId: string, note: string, nowMs: number): Promise<void> {
    const s = this.requireActive(sessionId);
    if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE session SET end_note = ? WHERE id = ?').run(note, sessionId);
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, 'note', JSON.stringify({ end_note: s.endNote }), JSON.stringify({ end_note: note }), null, nowMs);
    });
    tx();
  }

  async applyRetime(sessionId: string, deltaSeconds: number, reason: string | null, nowMs: number): Promise<void> {
    const s = this.requireActive(sessionId);
    if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    const before = s.activeSeconds;
    const after = Math.max(0, before + deltaSeconds);
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE session SET active_seconds = ? WHERE id = ?').run(after, sessionId);
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(sessionId, 'retime', JSON.stringify({ active_seconds: before }), JSON.stringify({ active_seconds: after }), reason, nowMs);
      this.db
        .prepare('INSERT INTO audit_log (actor, action, target, detail_json, server_time_ms) VALUES (?, ?, ?, ?, ?)')
        .run('owner', 'retime', sessionId, JSON.stringify({ delta_seconds: deltaSeconds }), nowMs);
    });
    tx();
  }

  /* ---- 查询 ---- */

  async sessionsOverlapping(startMs: number, endMs: number): Promise<SessionRow[]> {
    return (
      this.db
        .prepare(
          `SELECT * FROM session WHERE status != 'voided' AND started_at_ms < ?
           AND (ended_at_ms IS NULL OR ended_at_ms > ?) ORDER BY started_at_ms`,
        )
        .all(endMs, startMs) as Array<Record<string, unknown>>
    ).map(rowToSession);
  }

  async segmentsForSessions(sessionIds: string[]): Promise<Map<string, ActiveSegmentRow[]>> {
    const map = new Map<string, ActiveSegmentRow[]>();
    if (sessionIds.length === 0) return map;
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM active_segment WHERE session_id IN (${placeholders}) ORDER BY started_at_ms, id`)
      .all(...sessionIds) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const seg = rowToSegment(r);
      const arr = map.get(seg.sessionId) ?? [];
      arr.push(seg);
      map.set(seg.sessionId, arr);
    }
    return map;
  }

  async adjustmentsSince(ms: number): Promise<ManualAdjustmentRow[]> {
    return (
      this.db.prepare('SELECT * FROM manual_adjustment WHERE created_at_ms >= ? ORDER BY created_at_ms').all(ms) as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      kind: r.kind as ManualAdjustmentRow['kind'],
      beforeJson: r.before_json as string,
      afterJson: r.after_json as string,
      reason: (r.reason as string | null) ?? null,
      createdAtMs: r.created_at_ms as number,
    }));
  }

  async maxEventId(): Promise<number> {
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM session_event').get() as { m: number };
    return r.m;
  }

  /* ---- API 凭据 ---- */

  async listCredentials(): Promise<ApiCredentialRow[]> {
    return (this.db.prepare('SELECT * FROM api_credential ORDER BY created_at_ms DESC').all() as Array<Record<string, unknown>>).map(
      (r) => ({
        id: r.id as string,
        name: r.name as string,
        scope: 'read_only' as const,
        tokenSha256: r.token_sha256 as string,
        revokedAtMs: (r.revoked_at_ms as number | null) ?? null,
        createdAtMs: r.created_at_ms as number,
      }),
    );
  }

  async createCredential(row: ApiCredentialRow): Promise<void> {
    this.db
      .prepare('INSERT INTO api_credential (id, name, scope, token_sha256, revoked_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.name, row.scope, row.tokenSha256, row.revokedAtMs, row.createdAtMs);
  }

  async revokeCredential(id: string, nowMs: number): Promise<void> {
    this.db.prepare('UPDATE api_credential SET revoked_at_ms = ? WHERE id = ?').run(nowMs, id);
  }

  async credentialByTokenSha(tokenSha: string): Promise<ApiCredentialRow | null> {
    const r = this.db.prepare('SELECT * FROM api_credential WHERE token_sha256 = ?').get(tokenSha) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      scope: 'read_only' as const,
      tokenSha256: r.token_sha256 as string,
      revokedAtMs: (r.revoked_at_ms as number | null) ?? null,
      createdAtMs: r.created_at_ms as number,
    };
  }

  /* ---- 幂等 ---- */

  async getIdempotentResponse(key: string): Promise<{ endpoint: string; responseJson: string } | null> {
    const r = this.db.prepare('SELECT endpoint, response_json FROM idempotency_record WHERE key = ?').get(key) as
      | { endpoint: string; response_json: string }
      | undefined;
    return r ? { endpoint: r.endpoint, responseJson: r.response_json } : null;
  }

  async saveIdempotentResponse(key: string, endpoint: string, responseJson: string, nowMs: number): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency_record (key, endpoint, response_json, created_at_ms) VALUES (?, ?, ?, ?)')
      .run(key, endpoint, responseJson, nowMs);
  }

  async purgeIdempotentBefore(ms: number): Promise<void> {
    this.db.prepare('DELETE FROM idempotency_record WHERE created_at_ms < ?').run(ms);
  }

  /* ---- 审计与导出 ---- */

  async appendAudit(actor: string, action: string, target: string, detailJson: string | null, nowMs: number): Promise<void> {
    this.db
      .prepare('INSERT INTO audit_log (actor, action, target, detail_json, server_time_ms) VALUES (?, ?, ?, ?, ?)')
      .run(actor, action, target, detailJson, nowMs);
  }

  async allEvents(): Promise<SessionEventRow[]> {
    return (this.db.prepare('SELECT * FROM session_event ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      kind: r.kind as SessionEventRow['kind'],
      idempotencyKey: r.idempotency_key as string,
      serverTimeMs: r.server_time_ms as number,
      payloadJson: (r.payload_json as string | null) ?? null,
    }));
  }

  async allSessions(): Promise<SessionRow[]> {
    return (this.db.prepare('SELECT * FROM session ORDER BY started_at_ms').all() as Array<Record<string, unknown>>).map(rowToSession);
  }
}

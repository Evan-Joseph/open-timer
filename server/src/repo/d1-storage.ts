/**
 * Cloudflare D1 存储适配器。与 SqliteStorage 同一 Storage 契约。
 * D1 的 batch() 提供原子性（替代 SQLite 事务）。
 * 最小 D1 类型在此声明，避免把 workers-types 泄漏进 Node 侧代码。
 */

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

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

export interface D1Database {
  prepare(query: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

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

/**
 * 把迁移 SQL 文本拆成语句数组：先剔除 `--` 整行注释，再按分号拆分。
 * 兼容单行与多行语句；本项目迁移 SQL 无字符串内嵌分号。
 */
export function splitMigrationSql(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export class D1Storage implements Storage {
  constructor(
    private db: D1Database,
    private migrationSql: string,
  ) {}

  nowMs(): number {
    return Date.now();
  }

  close(): void {
    /* D1 无需关闭 */
  }

  async migrate(): Promise<void> {
    // 不用 D1 exec：exec 对「多语句 + 注释行」混合的 SQL 解析不稳定（D1_EXEC_ERROR）。
    // 按分号拆分（先剥整行注释）后用 batch 原子执行；全部语句幂等
    // （IF NOT EXISTS / ON CONFLICT），可重复执行。
    const statements = splitMigrationSql(this.migrationSql);
    await this.db.batch(statements.map((sql) => this.db.prepare(sql)));
    const stmts = SUBJECTS.map((s) =>
      this.db
        .prepare(
          'INSERT INTO subject (id, display_name, aggregate_group, color_id, sort_order) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, aggregate_group=excluded.aggregate_group, color_id=excluded.color_id, sort_order=excluded.sort_order',
        )
        .bind(s.id, s.displayName, s.aggregateGroup, s.colorId, s.sortOrder),
    );
    await this.db.batch(stmts);
  }

  /* ---- owner ---- */

  async getOwnerPasswordHash(): Promise<string | null> {
    const r = await this.db.prepare('SELECT password_hash FROM owner_credential WHERE id = 1').first<{ password_hash: string }>();
    return r?.password_hash ?? null;
  }

  async setOwnerPasswordHash(hash: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO owner_credential (id, password_hash, updated_at_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash, updated_at_ms=excluded.updated_at_ms',
      )
      .bind(hash, Date.now())
      .run();
  }

  async getOwnerSession(tokenSha: string): Promise<{ expiresAtMs: number } | null> {
    const r = await this.db.prepare('SELECT expires_at_ms FROM owner_session WHERE token_sha = ?').bind(tokenSha).first<{ expires_at_ms: number }>();
    if (!r) return null;
    if (r.expires_at_ms < Date.now()) {
      await this.db.prepare('DELETE FROM owner_session WHERE token_sha = ?').bind(tokenSha).run();
      return null;
    }
    return { expiresAtMs: r.expires_at_ms };
  }

  async createOwnerSession(tokenSha: string, expiresAtMs: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO owner_session (token_sha, expires_at_ms) VALUES (?, ?) ON CONFLICT(token_sha) DO UPDATE SET expires_at_ms=excluded.expires_at_ms')
      .bind(tokenSha, expiresAtMs)
      .run();
  }

  async deleteOwnerSession(tokenSha: string): Promise<void> {
    await this.db.prepare('DELETE FROM owner_session WHERE token_sha = ?').bind(tokenSha).run();
  }

  /* ---- sessions ---- */

  private async sessionById(id: string): Promise<SessionRow | null> {
    const r = await this.db.prepare('SELECT * FROM session WHERE id = ?').bind(id).first<Record<string, unknown>>();
    return r ? rowToSession(r) : null;
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return this.sessionById(id);
  }

  async getActiveSession(userId: string): Promise<ActiveSessionWithSegments | null> {
    const r = await this.db
      .prepare("SELECT * FROM session WHERE user_id = ? AND status IN ('running','paused')")
      .bind(userId)
      .first<Record<string, unknown>>();
    if (!r) return null;
    const session = rowToSession(r);
    return { session, segments: await this.getSegments(session.id) };
  }

  async getSegments(sessionId: string): Promise<ActiveSegmentRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM active_segment WHERE session_id = ? ORDER BY started_at_ms, id')
      .bind(sessionId)
      .all<Record<string, unknown>>();
    return results.map(rowToSegment);
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
    if (existing) return null;
    try {
      await this.db.batch([
        this.db
          .prepare(
            'INSERT INTO session (id, user_id, subject_id, status, intent_note, end_note, end_reason, started_at_ms, ended_at_ms, active_seconds, created_at_ms) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, ?)',
          )
          .bind(args.id, args.userId, args.subjectId, 'running', args.intentNote, args.nowMs, args.nowMs),
        this.db
          .prepare('INSERT INTO active_segment (session_id, started_at_ms, ended_at_ms) VALUES (?, ?, NULL)')
          .bind(args.id, args.nowMs),
        this.db
          .prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)')
          .bind(args.id, 'created', args.idempotencyKey, args.nowMs, JSON.stringify({ subject_id: args.subjectId })),
      ]);
    } catch {
      // 唯一索引冲突（并发 start）
      return null;
    }
    return this.sessionById(args.id);
  }

  private async requireActive(sessionId: string): Promise<SessionRow> {
    const s = await this.sessionById(sessionId);
    if (!s) throw new Error('SESSION_NOT_FOUND');
    return s;
  }

  async pauseSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'running') throw new Error('ILLEGAL_TRANSITION');
    // active_seconds 更新并入同一 batch（原子）：此前它在 batch 外单独执行，存在
    // 「段已关但快照未更新」的窗口，与 SQLite 本地版（事务内）行为不一致。
    await this.db.batch([
      this.db.prepare('UPDATE active_segment SET ended_at_ms = ? WHERE session_id = ? AND ended_at_ms IS NULL').bind(nowMs, sessionId),
      this.db.prepare("UPDATE session SET status = 'paused' WHERE id = ?").bind(sessionId),
      this.db.prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)').bind(sessionId, 'paused', idempotencyKey, nowMs, null),
      this.db
        .prepare(
          'UPDATE session SET active_seconds = (SELECT COALESCE(SUM(MAX(0, ended_at_ms - started_at_ms)), 0) / 1000 FROM active_segment WHERE session_id = ?) WHERE id = ?',
        )
        .bind(sessionId, sessionId),
    ]);
  }

  async resumeSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'paused' && s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    const statusStmt =
      s.status === 'stopped'
        ? this.db.prepare("UPDATE session SET status = 'running', ended_at_ms = NULL, end_reason = NULL WHERE id = ?").bind(sessionId)
        : this.db.prepare("UPDATE session SET status = 'running' WHERE id = ?").bind(sessionId);
    await this.db.batch([
      statusStmt,
      this.db.prepare('INSERT INTO active_segment (session_id, started_at_ms, ended_at_ms) VALUES (?, ?, NULL)').bind(sessionId, nowMs),
      this.db
        .prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)')
        .bind(sessionId, 'resumed', idempotencyKey, nowMs, s.status === 'stopped' ? JSON.stringify({ reopened_from: 'stopped' }) : null),
    ]);
  }

  async stopSession(sessionId: string, nowMs: number, endReason: string, idempotencyKey: string): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'running' && s.status !== 'paused') throw new Error('ILLEGAL_TRANSITION');
    await this.db.batch([
      this.db.prepare('UPDATE active_segment SET ended_at_ms = ? WHERE session_id = ? AND ended_at_ms IS NULL').bind(nowMs, sessionId),
      this.db.prepare('UPDATE session SET status = ?, ended_at_ms = ?, end_reason = ? WHERE id = ?').bind('stopped', nowMs, endReason, sessionId),
      this.db
        .prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)')
        .bind(sessionId, 'stopped', idempotencyKey, nowMs, JSON.stringify({ end_reason: endReason })),
      this.db
        .prepare(
          'UPDATE session SET active_seconds = (SELECT COALESCE(SUM(MAX(0, ended_at_ms - started_at_ms)), 0) / 1000 FROM active_segment WHERE session_id = ?) WHERE id = ?',
        )
        .bind(sessionId, sessionId),
    ]);
  }

  async voidSession(sessionId: string, nowMs: number, reason: string | null, idempotencyKey: string): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    await this.db.batch([
      this.db.prepare("UPDATE session SET status = 'voided', end_reason = 'void' WHERE id = ?").bind(sessionId),
      this.db
        .prepare('INSERT INTO session_event (session_id, kind, idempotency_key, server_time_ms, payload_json) VALUES (?, ?, ?, ?, ?)')
        .bind(sessionId, 'voided', idempotencyKey, nowMs, JSON.stringify({ reason })),
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(sessionId, 'void', JSON.stringify({ status: 'stopped', active_seconds: s.activeSeconds }), JSON.stringify({ status: 'voided' }), reason, nowMs),
    ]);
  }

  async setSessionNote(sessionId: string, note: string, nowMs: number): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    await this.db.batch([
      this.db.prepare('UPDATE session SET end_note = ? WHERE id = ?').bind(note, sessionId),
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(sessionId, 'note', JSON.stringify({ end_note: s.endNote }), JSON.stringify({ end_note: note }), null, nowMs),
    ]);
  }

  async applyRetime(sessionId: string, deltaSeconds: number, reason: string | null, nowMs: number): Promise<void> {
    const s = await this.requireActive(sessionId);
    if (s.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    // 时长修正落到末段结束时刻（而非只改 active_seconds 快照）：所有读端点都按段重算。
    const segs = await this.getSegments(sessionId);
    if (segs.length === 0) throw new Error('SESSION_HAS_NO_SEGMENTS');
    const last = segs[segs.length - 1];
    if (last.endedAtMs == null) throw new Error('ILLEGAL_TRANSITION');
    const newEndMs = last.endedAtMs + deltaSeconds * 1000;
    if (newEndMs < last.startedAtMs) throw new Error('INVALID_RETIME');
    const before = s.activeSeconds;
    await this.db.batch([
      this.db.prepare('UPDATE active_segment SET ended_at_ms = ? WHERE id = ?').bind(newEndMs, last.id),
      this.db
        .prepare(
          'UPDATE session SET active_seconds = (SELECT COALESCE(SUM(MAX(0, ended_at_ms - started_at_ms)), 0) / 1000 FROM active_segment WHERE session_id = ?) WHERE id = ?',
        )
        .bind(sessionId, sessionId),
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(sessionId, 'retime', JSON.stringify({ active_seconds: before, ended_at_ms: last.endedAtMs }), JSON.stringify({ ended_at_ms: newEndMs }), reason, nowMs),
      this.db
        .prepare('INSERT INTO audit_log (actor, action, target, detail_json, server_time_ms) VALUES (?, ?, ?, ?, ?)')
        .bind('owner', 'retime', sessionId, JSON.stringify({ delta_seconds: deltaSeconds }), nowMs),
    ]);
  }

  async adjustSessionStart(sessionId: string, startedAtMs: number, reason: string | null, nowMs: number): Promise<void> {
    const session = await this.requireActive(sessionId);
    if (session.status !== 'stopped') throw new Error('ILLEGAL_TRANSITION');
    const first = await this.db
      .prepare('SELECT * FROM active_segment WHERE session_id = ? ORDER BY started_at_ms, id LIMIT 1')
      .bind(sessionId)
      .first<Record<string, unknown>>();
    if (!first || first.ended_at_ms == null || startedAtMs >= Number(first.ended_at_ms)) throw new Error('INVALID_START');
    const deltaSeconds = Math.round((Number(first.started_at_ms) - startedAtMs) / 1000);
    const activeSeconds = session.activeSeconds + deltaSeconds;
    if (activeSeconds < 0) throw new Error('INVALID_START');
    await this.db.batch([
      this.db.prepare('UPDATE session SET started_at_ms = ?, active_seconds = ? WHERE id = ?').bind(startedAtMs, activeSeconds, sessionId),
      this.db.prepare('UPDATE active_segment SET started_at_ms = ? WHERE id = ?').bind(startedAtMs, Number(first.id)),
      this.db
        .prepare('INSERT INTO manual_adjustment (session_id, kind, before_json, after_json, reason, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(sessionId, 'retime', JSON.stringify({ started_at_ms: session.startedAtMs }), JSON.stringify({ started_at_ms: startedAtMs }), reason, nowMs),
      this.db
        .prepare('INSERT INTO audit_log (actor, action, target, detail_json, server_time_ms) VALUES (?, ?, ?, ?, ?)')
        .bind('owner', 'session_start_adjust', sessionId, JSON.stringify({ started_at_ms: startedAtMs }), nowMs),
    ]);
  }

  /* ---- 查询 ---- */

  async sessionsOverlapping(startMs: number, endMs: number, options: { includeVoided?: boolean } = {}): Promise<SessionRow[]> {
    // 与 [startMs, endMs) 相交的会话 = 「在窗口起点之后结束的」∪「仍开放的」。
    // 前半走 session_ended(ended_at_ms) 索引 range（只扫近期结束的少量会话），
    // 后半走 one_active_session 部分索引（≤1 行）——避免全表扫描
    // （D1 按行读计费，全表扫会在约 250 个历史会话时撞穿 500 万行读/天免费额度）。
    const completedWhere = options.includeVoided ? '' : "status != 'voided' AND ";
    const { results } = await this.db
      .prepare(
        `SELECT * FROM session WHERE ${completedWhere}ended_at_ms IS NOT NULL AND ended_at_ms > ? AND started_at_ms < ?
         UNION
         SELECT * FROM session WHERE status IN ('running','paused') AND started_at_ms < ?
         ORDER BY started_at_ms, id`,
      )
      .bind(startMs, endMs, endMs)
      .all<Record<string, unknown>>();
    return results.map(rowToSession);
  }

  async segmentsForSessions(sessionIds: string[]): Promise<Map<string, ActiveSegmentRow[]>> {
    const map = new Map<string, ActiveSegmentRow[]>();
    // Cloudflare D1 每条语句最多 100 个 bound parameters。海螺会读取全历史，
    // 不能把所有 session ID 拼成一条 IN 查询，否则会话超过阈值后直接失败。
    const uniqueIds = [...new Set(sessionIds)];
    const D1_MAX_BOUND_PARAMETERS = 100;
    for (let offset = 0; offset < uniqueIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
      const batch = uniqueIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
      const placeholders = batch.map(() => '?').join(',');
      const { results } = await this.db
        .prepare(`SELECT * FROM active_segment WHERE session_id IN (${placeholders}) ORDER BY started_at_ms, id`)
        .bind(...batch)
        .all<Record<string, unknown>>();
      for (const r of results) {
        const seg = rowToSegment(r);
        const arr = map.get(seg.sessionId) ?? [];
        arr.push(seg);
        map.set(seg.sessionId, arr);
      }
    }
    return map;
  }

  async adjustmentsSince(ms: number): Promise<ManualAdjustmentRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM manual_adjustment WHERE created_at_ms >= ? ORDER BY created_at_ms')
      .bind(ms)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      kind: r.kind as ManualAdjustmentRow['kind'],
      beforeJson: r.before_json as string,
      afterJson: r.after_json as string,
      reason: (r.reason as string | null) ?? null,
      createdAtMs: r.created_at_ms as number,
    }));
  }

  async adjustmentsForSessions(sessionIds: string[]): Promise<ManualAdjustmentRow[]> {
    if (sessionIds.length === 0) return [];
    const placeholders = sessionIds.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(
        `SELECT * FROM manual_adjustment WHERE session_id IN (${placeholders}) ORDER BY created_at_ms, id`,
      )
      .bind(...sessionIds)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
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
    // revision = 审计日志最大 id（覆盖所有写操作，见 sqlite-storage 同款注释）。
    const r = await this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log').first<{ m: number }>();
    return r?.m ?? 0;
  }

  async getConchRevision(): Promise<number> {
    const row = await this.db
      .prepare('SELECT revision FROM conch_timeline_state WHERE id = 1')
      .first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  async bumpConchRevision(): Promise<void> {
    await this.db.prepare('UPDATE conch_timeline_state SET revision = revision + 1 WHERE id = 1').run();
  }

  /* ---- API 凭据 ---- */

  async listCredentials(): Promise<ApiCredentialRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM api_credential ORDER BY created_at_ms DESC').all<Record<string, unknown>>();
    return results.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      scope: 'read_only' as const,
      tokenSha256: r.token_sha256 as string,
      revokedAtMs: (r.revoked_at_ms as number | null) ?? null,
      createdAtMs: r.created_at_ms as number,
    }));
  }

  async createCredential(row: ApiCredentialRow): Promise<void> {
    await this.db
      .prepare('INSERT INTO api_credential (id, name, scope, token_sha256, revoked_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(row.id, row.name, row.scope, row.tokenSha256, row.revokedAtMs, row.createdAtMs)
      .run();
  }

  async revokeCredential(id: string, nowMs: number): Promise<void> {
    await this.db.prepare('UPDATE api_credential SET revoked_at_ms = ? WHERE id = ?').bind(nowMs, id).run();
  }

  async credentialByTokenSha(tokenSha: string): Promise<ApiCredentialRow | null> {
    const r = await this.db.prepare('SELECT * FROM api_credential WHERE token_sha256 = ?').bind(tokenSha).first<Record<string, unknown>>();
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
    const r = await this.db.prepare('SELECT endpoint, response_json FROM idempotency_record WHERE key = ?').bind(key).first<{ endpoint: string; response_json: string }>();
    return r ? { endpoint: r.endpoint, responseJson: r.response_json } : null;
  }

  async saveIdempotentResponse(key: string, endpoint: string, responseJson: string, nowMs: number): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO idempotency_record (key, endpoint, response_json, created_at_ms) VALUES (?, ?, ?, ?)')
      .bind(key, endpoint, responseJson, nowMs)
      .run();
  }

  async purgeIdempotentBefore(ms: number): Promise<void> {
    await this.db.prepare('DELETE FROM idempotency_record WHERE created_at_ms < ?').bind(ms).run();
  }

  /* ---- 审计与导出 ---- */

  async appendAudit(actor: string, action: string, target: string, detailJson: string | null, nowMs: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO audit_log (actor, action, target, detail_json, server_time_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(actor, action, target, detailJson, nowMs)
      .run();
  }

  async allEvents(): Promise<SessionEventRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM session_event ORDER BY id').all<Record<string, unknown>>();
    return results.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      kind: r.kind as SessionEventRow['kind'],
      idempotencyKey: r.idempotency_key as string,
      serverTimeMs: r.server_time_ms as number,
      payloadJson: (r.payload_json as string | null) ?? null,
    }));
  }

  async allSessions(): Promise<SessionRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM session ORDER BY started_at_ms').all<Record<string, unknown>>();
    return results.map(rowToSession);
  }

  /* ---- 用户 UI 偏好 ---- */

  async getPrefs(): Promise<{ prefsJson: string; updatedAtMs: number } | null> {
    const r = await this.db
      .prepare('SELECT prefs_json, updated_at_ms FROM user_pref WHERE id = 1')
      .first<{ prefs_json: string; updated_at_ms: number }>();
    return r ? { prefsJson: r.prefs_json, updatedAtMs: r.updated_at_ms } : null;
  }

  async setPrefs(prefsJson: string, nowMs: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO user_pref (id, prefs_json, updated_at_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET prefs_json=excluded.prefs_json, updated_at_ms=excluded.updated_at_ms')
      .bind(prefsJson, nowMs)
      .run();
  }
}

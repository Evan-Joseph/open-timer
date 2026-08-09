/**
 * Repository 契约：领域与存储之间的唯一边界。
 * 本地实现为 SQLite；D1/CloudBase 只需提供同接口的新适配器。
 * 所有时间戳参数为 UTC epoch ms。
 */

import type {
  SessionRow,
  SessionEventRow,
  ActiveSegmentRow,
  ManualAdjustmentRow,
  ApiCredentialRow,
  SubjectId,
  SessionStatus,
} from '@clock/shared';

export interface ActiveSessionWithSegments {
  session: SessionRow;
  segments: ActiveSegmentRow[];
}

export interface Storage {
  /* ---- schema / admin ---- */
  migrate(): void;
  close(): void;
  nowMs(): number;

  /* ---- owner 凭据 ---- */
  getOwnerPasswordHash(): string | null;
  setOwnerPasswordHash(hash: string): void;
  getOwnerSession(tokenSha: string): { expiresAtMs: number } | null;
  createOwnerSession(tokenSha: string, expiresAtMs: number): void;
  deleteOwnerSession(tokenSha: string): void;

  /* ---- sessions ---- */
  getActiveSession(userId: string): ActiveSessionWithSegments | null;
  getSession(id: string): SessionRow | null;
  getSegments(sessionId: string): ActiveSegmentRow[];
  /** 创建会话并开第一段 + 写 created 事件。返回 null 表示并发冲突（已有活动会话）。 */
  createSession(args: {
    id: string;
    userId: string;
    subjectId: SubjectId;
    intentNote: string | null;
    nowMs: number;
    idempotencyKey: string;
  }): SessionRow | null;
  /** 关闭开放段并追加事件。 */
  pauseSession(sessionId: string, nowMs: number, idempotencyKey: string): void;
  /** 开新段并追加事件。 */
  resumeSession(sessionId: string, nowMs: number, idempotencyKey: string): void;
  /** 关闭开放段、定格会话。 */
  stopSession(sessionId: string, nowMs: number, endReason: string, idempotencyKey: string): void;
  /** 作废会话（保留全部事件与段）。 */
  voidSession(sessionId: string, nowMs: number, reason: string | null, idempotencyKey: string): void;
  /** 修改结束备注（仅 stopped）。 */
  setSessionNote(sessionId: string, note: string, nowMs: number): void;
  /** 手动改时（retime）：重算 activeSeconds 并记录 adjustment；段保持事件链，adjustment 记录差值。 */
  applyRetime(sessionId: string, deltaSeconds: number, reason: string | null, nowMs: number): void;

  /* ---- 查询 ---- */
  /** 与给定 UTC 窗口有交集的非 void 会话。 */
  sessionsOverlapping(startMs: number, endMs: number): SessionRow[];
  /** 给定会话的段（含开放段）。 */
  segmentsForSessions(sessionIds: string[]): Map<string, ActiveSegmentRow[]>;
  /** 某会话开始的日内的 adjustments。 */
  adjustmentsSince(ms: number): ManualAdjustmentRow[];
  /** revision = 截至 now 的最大事件 id（用于 ETag 确定性）。 */
  maxEventId(): number;

  /* ---- API 凭据 ---- */
  listCredentials(): ApiCredentialRow[];
  createCredential(row: ApiCredentialRow): void;
  revokeCredential(id: string, nowMs: number): void;
  credentialByTokenSha(tokenSha: string): ApiCredentialRow | null;

  /* ---- 幂等 ---- */
  getIdempotentResponse(key: string): { endpoint: string; responseJson: string } | null;
  saveIdempotentResponse(key: string, endpoint: string, responseJson: string, nowMs: number): void;
  purgeIdempotentBefore(ms: number): void;

  /* ---- 审计与导出 ---- */
  appendAudit(actor: string, action: string, target: string, detailJson: string | null, nowMs: number): void;
  allEvents(): SessionEventRow[];
  allSessions(): SessionRow[];
}

/**
 * Repository 契约：领域与存储之间的唯一边界。
 * 本地实现为 SQLite；Cloudflare D1 / CloudBase 提供同接口的新适配器。
 * 所有时间戳参数为 UTC epoch ms。所有方法异步，保证跨运行时一致。
 */

import type {
  SessionRow,
  SessionEventRow,
  ActiveSegmentRow,
  ManualAdjustmentRow,
  ApiCredentialRow,
  SubjectId,
} from '@clock/shared';

export interface ActiveSessionWithSegments {
  session: SessionRow;
  segments: ActiveSegmentRow[];
}

export interface Storage {
  /* ---- schema / admin ---- */
  migrate(): Promise<void>;
  close(): void;
  nowMs(): number;

  /* ---- owner 凭据 ---- */
  getOwnerPasswordHash(): Promise<string | null>;
  setOwnerPasswordHash(hash: string): Promise<void>;
  getOwnerSession(tokenSha: string): Promise<{ expiresAtMs: number } | null>;
  createOwnerSession(tokenSha: string, expiresAtMs: number): Promise<void>;
  deleteOwnerSession(tokenSha: string): Promise<void>;

  /* ---- sessions ---- */
  getActiveSession(userId: string): Promise<ActiveSessionWithSegments | null>;
  getSession(id: string): Promise<SessionRow | null>;
  getSegments(sessionId: string): Promise<ActiveSegmentRow[]>;
  /** 创建会话并开第一段 + 写 created 事件。返回 null 表示并发冲突（已有活动会话）。 */
  createSession(args: {
    id: string;
    userId: string;
    subjectId: SubjectId;
    intentNote: string | null;
    nowMs: number;
    idempotencyKey: string;
  }): Promise<SessionRow | null>;
  /** 关闭开放段并追加事件。 */
  pauseSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void>;
  /** 开新段并追加事件。 */
  resumeSession(sessionId: string, nowMs: number, idempotencyKey: string): Promise<void>;
  /** 关闭开放段、定格会话。 */
  stopSession(sessionId: string, nowMs: number, endReason: string, idempotencyKey: string): Promise<void>;
  /** 作废会话（保留全部事件与段）。 */
  voidSession(sessionId: string, nowMs: number, reason: string | null, idempotencyKey: string): Promise<void>;
  /** 修改结束备注（仅 stopped）。 */
  setSessionNote(sessionId: string, note: string, nowMs: number): Promise<void>;
  /** 手动改时（retime）：重算 activeSeconds 并记录 adjustment。 */
  applyRetime(sessionId: string, deltaSeconds: number, reason: string | null, nowMs: number): Promise<void>;
  /** 调整已结束会话的起点，同时修正首段、净时长并保留审计。 */
  adjustSessionStart(sessionId: string, startedAtMs: number, reason: string | null, nowMs: number): Promise<void>;

  /* ---- 查询 ---- */
  sessionsOverlapping(startMs: number, endMs: number): Promise<SessionRow[]>;
  segmentsForSessions(sessionIds: string[]): Promise<Map<string, ActiveSegmentRow[]>>;
  adjustmentsSince(ms: number): Promise<ManualAdjustmentRow[]>;
  /** revision = 截至 now 的最大事件 id（用于 ETag 确定性）。 */
  maxEventId(): Promise<number>;

  /* ---- API 凭据 ---- */
  listCredentials(): Promise<ApiCredentialRow[]>;
  createCredential(row: ApiCredentialRow): Promise<void>;
  revokeCredential(id: string, nowMs: number): Promise<void>;
  credentialByTokenSha(tokenSha: string): Promise<ApiCredentialRow | null>;

  /* ---- 幂等 ---- */
  getIdempotentResponse(key: string): Promise<{ endpoint: string; responseJson: string } | null>;
  saveIdempotentResponse(key: string, endpoint: string, responseJson: string, nowMs: number): Promise<void>;
  purgeIdempotentBefore(ms: number): Promise<void>;

  /* ---- 审计与导出 ---- */
  appendAudit(actor: string, action: string, target: string, detailJson: string | null, nowMs: number): Promise<void>;
  allEvents(): Promise<SessionEventRow[]>;
  allSessions(): Promise<SessionRow[]>;
}

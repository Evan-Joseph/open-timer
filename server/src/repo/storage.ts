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
  /** 开新段并追加事件；stopped 会话可被重开（误触继续）：清除结束时刻并开新段。 */
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
  /**
   * 与 [startMs,endMs) 相交的会话，稳定排序 started_at_ms,id。
   * includeVoided 仅供审计摘要使用；普通时间执行统计仍由调用方默认排除 voided。
   */
  sessionsOverlapping(startMs: number, endMs: number, options?: { includeVoided?: boolean }): Promise<SessionRow[]>;
  segmentsForSessions(sessionIds: string[]): Promise<Map<string, ActiveSegmentRow[]>>;
  adjustmentsSince(ms: number): Promise<ManualAdjustmentRow[]>;
  /** 指定会话的全部修正/撤回链（不受修正发生日期限制，历史归档可定位后续更正）。 */
  adjustmentsForSessions(sessionIds: string[]): Promise<ManualAdjustmentRow[]>;
  /** revision = 截至 now 的审计日志最大 id（audit_log 覆盖所有写操作，含
   *  note/retime/adjust-start 这类不写 session_event 的变更）。用于 ETag 确定性：
   *  任何影响资源的写操作都使 revision 前进、ETag 失效。 */
  maxEventId(): Promise<number>;
  /** 神奇海螺输入的已完成时间线 revision；开始/暂停/继续不推进。 */
  getConchRevision(): Promise<number>;
  /** 仅在已完成时间线事实变化后调用。 */
  bumpConchRevision(): Promise<void>;
  /** 跨 Worker 的成功推荐缓存。只保存已清洗后的结构化建议，key 与语义 revision / 模型 / 窗口绑定。 */
  getConchResponseCache(conchRevision: number, model: string, window: 'all' | '30d' | '7d'): Promise<string | null>;
  /**
   * 仅当写入瞬间 semantic revision 仍等于缓存键时保存。这个条件写阻止旧上下文
   * 在完成/备注/撤回并发发生后被误写进新 revision 的缓存行。
   */
  saveConchResponseCacheIfCurrentRevision(
    conchRevision: number,
    model: string,
    window: 'all' | '30d' | '7d',
    payloadJson: string,
    generatedAtMs: number,
  ): Promise<boolean>;
  /** 同一语义键的上游推理租约。true 表示本请求获得唯一生成权；leaseToken 用于安全释放。 */
  acquireConchGenerationLease(
    conchRevision: number,
    model: string,
    window: 'all' | '30d' | '7d',
    leaseToken: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean>;
  releaseConchGenerationLease(conchRevision: number, model: string, window: 'all' | '30d' | '7d', leaseToken: string): Promise<void>;
  /** 仅在真正调用上游前占用一次小时额度；跨 Worker / 冷启动一致。 */
  takeConchQuota(windowStartMs: number, maxHits: number, nowMs: number): Promise<boolean>;

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

  /* ---- 用户 UI 偏好（多端同步） ---- */
  getPrefs(): Promise<{ prefsJson: string; updatedAtMs: number } | null>;
  setPrefs(prefsJson: string, nowMs: number): Promise<void>;
}

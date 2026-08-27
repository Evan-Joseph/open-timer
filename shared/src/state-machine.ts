/**
 * 计时状态机（纯函数）。服务端与测试共用；UI 层不做状态判定。
 *
 * idle → running → paused → running → stopped
 * 附加：stopped → voided（作废，保留审计）；stopped → running（误触结束后继续，重开会话）。
 * 切换科目不在状态机内表达：先 stop(end_reason='subject_switch') 再 start 新会话。
 */

import type { SessionStatus, SessionEventKind, ActiveSegmentRow } from './types.js';

/**
 * 误触过滤：短于该阈值的已关闭片段不计入统计与展示（默认 10 秒）。
 * 阈值可由服务端配置覆盖（如测试环境置 0）。
 */
export const DEFAULT_MIN_COUNTED_SEGMENT_MS = 10_000;

/**
 * 片段是否计入：开放段（endedAtMs=null）仍在计时，始终计入；
 * 已关闭段须达到最小阈值，否则视为误触。
 */
export function isCountedSegment(
  seg: Pick<ActiveSegmentRow, 'startedAtMs' | 'endedAtMs'>,
  minMs: number,
): boolean {
  if (seg.endedAtMs === null) return true;
  return seg.endedAtMs - seg.startedAtMs >= minMs;
}

/** 每个动作要求的前置状态集合。 */
const ACTION_PRECONDITIONS: Record<SessionEventKind, readonly SessionStatus[] | null> = {
  // created 作用于 idle（无活动会话），用 null 表示无活动会话前提
  created: null,
  paused: ['running'],
  // stopped 也允许 resumed：误触结束后可继续该会话（重开会话、开新段）
  resumed: ['paused', 'stopped'],
  stopped: ['running', 'paused'],
  voided: ['stopped'],
};

export class StateMachineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StateMachineError';
  }
}

/** 判定某动作在当前状态下是否合法。currentStatus=null 表示 idle（无活动会话）。 */
export function canTransition(currentStatus: SessionStatus | null, action: SessionEventKind): boolean {
  const pre = ACTION_PRECONDITIONS[action];
  if (action === 'created') return currentStatus === null;
  return pre !== null && currentStatus !== null && pre.includes(currentStatus);
}

/** 应用动作后的新状态；非法动作抛 StateMachineError。 */
export function nextStatus(currentStatus: SessionStatus | null, action: SessionEventKind): SessionStatus | null {
  if (!canTransition(currentStatus, action)) {
    throw new StateMachineError(
      'ILLEGAL_TRANSITION',
      `cannot apply '${action}' when session is '${currentStatus ?? 'idle'}'`,
    );
  }
  switch (action) {
    case 'created':
      return 'running';
    case 'paused':
      return 'paused';
    case 'resumed':
      return 'running';
    case 'stopped':
      return 'stopped';
    case 'voided':
      return 'voided';
  }
}

/**
 * 从有序事件序列计算净活跃秒数（可重放）。
 * 规则：created 开启段；paused 关闭开放段；resumed 开新段；stopped 关闭开放段并封顶。
 * 所有时间以服务端时间戳为准。负段/乱序段钳制为 0（防御，不应出现）。
 */
export function computeActiveSeconds(
  segments: ReadonlyArray<Pick<ActiveSegmentRow, 'startedAtMs' | 'endedAtMs'>>,
  atMs?: number,
): number {
  let total = 0;
  for (const seg of segments) {
    const end = seg.endedAtMs ?? atMs;
    if (end === undefined || end === null) continue;
    const dur = Math.max(0, end - seg.startedAtMs);
    total += dur;
  }
  return Math.floor(total / 1000);
}

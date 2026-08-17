/** 自由计时场景的休息预算与提醒阶段。 */
export type RestStage = 'resting' | 'due-soon' | 'due' | 'overdue';
export type RestKind = 'brief' | 'short' | 'long';

export interface FocusInterval {
  startedAtMs: number;
  endedAtMs: number;
}

export interface RestPlan {
  focusSeconds: number;
  cycleFocusSeconds: number;
  kind: RestKind;
  recommendedSeconds: number;
  softReminderSeconds: number;
  overdueReminderSeconds: number;
  basis: 'flowtime-ratio-and-recovery-cycle';
}

/** 达到这段连续离开后，下一段专注从新的恢复周期开始。 */
export const RECOVERY_RESET_SECONDS = 15 * 60;
export const LONG_REST_TRIGGER_SECONDS = 90 * 60;

const BRIEF_FOCUS_SECONDS = 15 * 60;
const BRIEF_MIN_REST_SECONDS = 2 * 60;
const SHORT_MIN_REST_SECONDS = 5 * 60;
const SHORT_MAX_REST_SECONDS = 15 * 60;
const LONG_REST_SECONDS = 15 * 60;
const EXTENDED_LONG_REST_SECONDS = 20 * 60;
const EXTENDED_LONG_REST_TRIGGER_SECONDS = 2 * 60 * 60;
const OVERDUE_GRACE_SECONDS = 5 * 60;

function validInterval(interval: FocusInterval): boolean {
  return Number.isFinite(interval.startedAtMs)
    && Number.isFinite(interval.endedAtMs)
    && interval.endedAtMs > interval.startedAtMs;
}

/**
 * 计算当前专注段所属恢复周期内的累计专注。
 * 至少 15 分钟的真实间隔会切断周期；短暂停顿不会清空累计量。
 */
export function focusCycleSeconds(current: FocusInterval, history: readonly FocusInterval[]): number {
  if (!validInterval(current)) return 0;

  const prior = history
    .filter((interval) => validInterval(interval) && interval.endedAtMs <= current.startedAtMs)
    .sort((a, b) => a.startedAtMs - b.startedAtMs);
  const merged: FocusInterval[] = [];
  for (const interval of prior) {
    const last = merged.at(-1);
    if (last && interval.startedAtMs <= last.endedAtMs) {
      last.endedAtMs = Math.max(last.endedAtMs, interval.endedAtMs);
    } else {
      merged.push({ ...interval });
    }
  }

  let totalMs = current.endedAtMs - current.startedAtMs;
  let nextStartMs = current.startedAtMs;
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const interval = merged[index];
    if (nextStartMs - interval.endedAtMs >= RECOVERY_RESET_SECONDS * 1000) break;
    totalMs += interval.endedAtMs - interval.startedAtMs;
    nextStartMs = interval.startedAtMs;
  }
  return Math.max(0, Math.floor(totalMs / 1000));
}

/**
 * Flowtime 默认策略：
 * - 单段休息约为专注的 20%；
 * - 少于 15 分钟的短段只给 2-5 分钟短暂离开窗口；
 * - 一个恢复周期累计专注达到 90 分钟后，给 15-20 分钟长休息。
 */
export function restPlanForFocus(focusSeconds: number, cycleFocusSeconds = focusSeconds): RestPlan {
  const focus = Math.max(0, Math.floor(focusSeconds));
  const cycleFocus = Math.max(focus, Math.floor(cycleFocusSeconds));
  const ratioSeconds = Math.round(focus / 5);
  const kind: RestKind = cycleFocus >= LONG_REST_TRIGGER_SECONDS
    ? 'long'
    : focus < BRIEF_FOCUS_SECONDS
      ? 'brief'
      : 'short';
  const recommendedSeconds = kind === 'long'
    ? (cycleFocus >= EXTENDED_LONG_REST_TRIGGER_SECONDS ? EXTENDED_LONG_REST_SECONDS : LONG_REST_SECONDS)
    : kind === 'brief'
      ? Math.min(SHORT_MIN_REST_SECONDS, Math.max(BRIEF_MIN_REST_SECONDS, ratioSeconds))
      : Math.min(SHORT_MAX_REST_SECONDS, Math.max(SHORT_MIN_REST_SECONDS, ratioSeconds));
  return {
    focusSeconds: focus,
    cycleFocusSeconds: cycleFocus,
    kind,
    recommendedSeconds,
    softReminderSeconds: Math.max(60, recommendedSeconds - 60),
    overdueReminderSeconds: recommendedSeconds + OVERDUE_GRACE_SECONDS,
    basis: 'flowtime-ratio-and-recovery-cycle',
  };
}

export function restStageOf(restSeconds: number, plan: RestPlan): RestStage {
  const elapsed = Math.max(0, restSeconds);
  if (elapsed >= plan.overdueReminderSeconds) return 'overdue';
  if (elapsed >= plan.recommendedSeconds) return 'due';
  if (elapsed >= plan.softReminderSeconds) return 'due-soon';
  return 'resting';
}

export function restStageLabel(stage: RestStage): string {
  switch (stage) {
    case 'due-soon': return '休息快到时间';
    case 'due': return '建议开始下一段';
    case 'overdue': return '休息已超时';
    default: return '休息中';
  }
}

export function restKindLabel(kind: RestKind): string {
  switch (kind) {
    case 'long': return '长休息';
    case 'short': return '短休息';
    default: return '短暂离开';
  }
}

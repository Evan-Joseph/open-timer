/** 自由计时场景的休息预算与提醒阶段。 */
export type RestStage = 'resting' | 'due-soon' | 'due' | 'overdue';

export interface RestPlan {
  focusSeconds: number;
  recommendedSeconds: number;
  softReminderSeconds: number;
  overdueReminderSeconds: number;
  basis: 'previous-focus-segment';
}

const MIN_REST_SECONDS = 2 * 60;
const MAX_REST_SECONDS = 20 * 60;
const MIN_OVERDUE_GRACE_SECONDS = 2 * 60;

/**
 * Flowtime 统一策略：只依据刚结束的单段专注，休息预算为其 20%。
 * 2–20 分钟的边界避免极短记录立即召回，也避免超长专注产生过长离开窗口。
 */
export function restPlanForFocus(focusSeconds: number): RestPlan {
  const focus = Math.max(0, Math.floor(focusSeconds));
  const recommendedSeconds = Math.min(
    MAX_REST_SECONDS,
    Math.max(MIN_REST_SECONDS, Math.round(focus / 5)),
  );
  return {
    focusSeconds: focus,
    recommendedSeconds,
    softReminderSeconds: Math.max(60, Math.round(recommendedSeconds * 0.75)),
    overdueReminderSeconds: Math.max(
      recommendedSeconds + MIN_OVERDUE_GRACE_SECONDS,
      Math.round(recommendedSeconds * 1.5),
    ),
    basis: 'previous-focus-segment',
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

/**
 * 专注段结束后的休息建议与提醒阶段。
 * 休息建议按刚结束的单个专注段计算：专注时长的 1/5，最少 5 分钟，最多 20 分钟。
 * 这是可解释的默认值，不把休息变成硬性倒计时；提醒只表达“建议回到下一段”。
 * 75% 时温和提示，达到建议时长进入应回到下一段，达到 150% 时强提醒。
 */
export type RestStage = 'resting' | 'due-soon' | 'due' | 'overdue';

export interface RestPlan {
  focusSeconds: number;
  recommendedSeconds: number;
  softReminderSeconds: number;
  overdueReminderSeconds: number;
  basis: 'previous-focus-segment';
}

const MIN_REST_SECONDS = 5 * 60;
const MAX_REST_SECONDS = 20 * 60;

export function restPlanForFocus(focusSeconds: number): RestPlan {
  const focus = Math.max(0, Math.floor(focusSeconds));
  const recommendedSeconds = Math.min(MAX_REST_SECONDS, Math.max(MIN_REST_SECONDS, Math.round(focus / 5)));
  return {
    focusSeconds: focus,
    recommendedSeconds,
    softReminderSeconds: Math.max(60, Math.floor(recommendedSeconds * 0.75)),
    overdueReminderSeconds: recommendedSeconds * 1.5,
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

import { describe, expect, it } from 'vitest';
import { restPlanForFocus, restStageOf } from './rest-policy.js';

describe('rest policy', () => {
  it('uses one fifth of focus with 5-20 minute bounds', () => {
    expect(restPlanForFocus(25 * 60).recommendedSeconds).toBe(5 * 60);
    expect(restPlanForFocus(50 * 60).recommendedSeconds).toBe(10 * 60);
    expect(restPlanForFocus(3 * 60 * 60).recommendedSeconds).toBe(20 * 60);
    expect(restPlanForFocus(50 * 60).basis).toBe('previous-focus-segment');
  });

  it('progresses from soft reminder to due and overdue', () => {
    const plan = restPlanForFocus(50 * 60);
    expect(restStageOf(plan.softReminderSeconds - 1, plan)).toBe('resting');
    expect(restStageOf(plan.softReminderSeconds, plan)).toBe('due-soon');
    expect(restStageOf(plan.recommendedSeconds, plan)).toBe('due');
    expect(restStageOf(plan.overdueReminderSeconds, plan)).toBe('overdue');
  });
});

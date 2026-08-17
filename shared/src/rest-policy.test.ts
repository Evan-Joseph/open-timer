import { describe, expect, it } from 'vitest';
import { restPlanForFocus, restStageOf } from './rest-policy.js';

describe('rest policy', () => {
  it.each([
    [0, 2],
    [1, 2],
    [5 * 60, 2],
    [10 * 60, 2],
    [15 * 60 - 1, 3],
    [15 * 60, 3],
    [25 * 60, 5],
    [50 * 60, 10],
    [75 * 60, 15],
    [100 * 60, 20],
    [3 * 60 * 60, 20],
  ])('maps %i focus seconds to a %i minute rest budget', (focusSeconds, restMinutes) => {
    expect(restPlanForFocus(focusSeconds)).toMatchObject({
      focusSeconds,
      recommendedSeconds: restMinutes * 60,
      basis: 'previous-focus-segment',
    });
  });

  it('has no long/short category or accumulated-cycle input', () => {
    const plan = restPlanForFocus(25 * 60);
    expect(plan).not.toHaveProperty('kind');
    expect(plan).not.toHaveProperty('cycleFocusSeconds');
  });

  it.each([
    [2 * 60, 90, 4 * 60],
    [5 * 60, 225, 450],
    [10 * 60, 450, 15 * 60],
    [20 * 60, 15 * 60, 30 * 60],
  ])('scales reminders for a %i second budget', (budget, soft, overdue) => {
    const plan = restPlanForFocus(budget * 5);
    expect(plan.softReminderSeconds).toBe(soft);
    expect(plan.overdueReminderSeconds).toBe(overdue);
    expect(restStageOf(soft - 1, plan)).toBe('resting');
    expect(restStageOf(soft, plan)).toBe('due-soon');
    expect(restStageOf(budget, plan)).toBe('due');
    expect(restStageOf(overdue, plan)).toBe('overdue');
  });

  it('normalizes invalid negative focus without creating a negative budget', () => {
    expect(restPlanForFocus(-60)).toMatchObject({ focusSeconds: 0, recommendedSeconds: 2 * 60 });
  });
});

import { describe, expect, it } from 'vitest';
import { focusCycleSeconds, restPlanForFocus, restStageOf } from './rest-policy.js';

describe('rest policy', () => {
  it('uses flowtime ratio for brief and regular focus segments', () => {
    expect(restPlanForFocus(60).kind).toBe('brief');
    expect(restPlanForFocus(60).recommendedSeconds).toBe(2 * 60);
    expect(restPlanForFocus(25 * 60)).toMatchObject({
      kind: 'short',
      recommendedSeconds: 5 * 60,
    });
    expect(restPlanForFocus(50 * 60).recommendedSeconds).toBe(10 * 60);
  });

  it('promotes accumulated focus to a 15-20 minute long rest', () => {
    expect(restPlanForFocus(25 * 60, 100 * 60)).toMatchObject({
      kind: 'long',
      recommendedSeconds: 15 * 60,
      cycleFocusSeconds: 100 * 60,
    });
    expect(restPlanForFocus(2 * 60 * 60, 2 * 60 * 60).recommendedSeconds).toBe(20 * 60);
  });

  it('progresses from soft reminder to due and overdue', () => {
    const plan = restPlanForFocus(50 * 60);
    expect(plan.softReminderSeconds).toBe(9 * 60);
    expect(plan.overdueReminderSeconds).toBe(15 * 60);
    expect(restStageOf(plan.softReminderSeconds - 1, plan)).toBe('resting');
    expect(restStageOf(plan.softReminderSeconds, plan)).toBe('due-soon');
    expect(restStageOf(plan.recommendedSeconds, plan)).toBe('due');
    expect(restStageOf(plan.overdueReminderSeconds, plan)).toBe('overdue');
  });

  it('accumulates adjacent focus and resets after a 15 minute recovery gap', () => {
    const minute = 60_000;
    const current = { startedAtMs: 100 * minute, endedAtMs: 125 * minute };
    const history = [
      { startedAtMs: 30 * minute, endedAtMs: 45 * minute },
      { startedAtMs: 65 * minute, endedAtMs: 90 * minute },
    ];

    expect(focusCycleSeconds(current, history)).toBe(50 * 60);
  });
});

import { describe, expect, it } from 'vitest';
import { RHYTHM_PRESETS, rhythmStatus, rhythmDots, isValidRhythm } from '../src/pomodoro.js';

const CLASSIC = RHYTHM_PRESETS.classic;

describe('番茄节奏（纯参考，不支配）', () => {
  it('段内第一轮的进度与剩余', () => {
    const s = rhythmStatus(10 * 60, CLASSIC); // 10 分钟
    expect(s.round).toBe(1);
    expect(s.roundElapsedSec).toBe(600);
    expect(s.roundRemainingSec).toBe(900);
    expect(s.progress).toBeCloseTo(600 / 1500, 5);
    expect(s.atCheckpoint).toBe(false);
    expect(s.completedRounds).toBe(0);
  });

  it('正好 25 分钟到达节奏点，建议短休息', () => {
    const s = rhythmStatus(25 * 60, CLASSIC);
    expect(s.atCheckpoint).toBe(true);
    expect(s.completedRounds).toBe(1);
    expect(s.suggestedBreak).toBe('short');
    expect(s.suggestedBreakSec).toBe(5 * 60);
    expect(s.progress).toBe(1);
  });

  it('第 4 轮完成后建议长休息', () => {
    const s = rhythmStatus(4 * 25 * 60, CLASSIC);
    expect(s.completedRounds).toBe(4);
    expect(s.atCheckpoint).toBe(true);
    expect(s.suggestedBreak).toBe('long');
    expect(s.suggestedBreakSec).toBe(15 * 60);
  });

  it('超过节奏点后进入下一轮，进度重新累计', () => {
    const s = rhythmStatus(25 * 60 + 120, CLASSIC);
    expect(s.round).toBe(2);
    expect(s.roundElapsedSec).toBe(120);
    expect(s.atCheckpoint).toBe(false);
  });

  it('负秒数钳制为 0', () => {
    const s = rhythmStatus(-50, CLASSIC);
    expect(s.roundElapsedSec).toBe(0);
    expect(s.round).toBe(1);
  });

  it('节奏关闭时仍可计算但 UI 应隐藏（enabled=false）', () => {
    expect(RHYTHM_PRESETS.off.enabled).toBe(false);
    const s = rhythmStatus(100, RHYTHM_PRESETS.off);
    expect(s.round).toBe(1);
  });

  it('轮次点：完成 2 轮时 current 是第 3 个点', () => {
    const s = rhythmStatus(2 * 25 * 60 + 60, CLASSIC);
    expect(rhythmDots(s, CLASSIC)).toEqual(['done', 'done', 'current', 'todo']);
  });

  it('周期轮转：完成 4 轮后点阵归零进入新周期', () => {
    const s = rhythmStatus(4 * 25 * 60 + 60, CLASSIC);
    expect(rhythmDots(s, CLASSIC)).toEqual(['current', 'todo', 'todo', 'todo']);
  });

  it('配置校验拒绝越界值', () => {
    expect(isValidRhythm({ ...CLASSIC, focusMin: 3 })).toBe(false);
    expect(isValidRhythm({ ...CLASSIC, focusMin: 200 })).toBe(false);
    expect(isValidRhythm({ ...CLASSIC, breakMin: 0 })).toBe(false);
    expect(isValidRhythm(null)).toBe(false);
    expect(isValidRhythm(CLASSIC)).toBe(true);
  });
});

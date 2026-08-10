import { describe, expect, it } from 'vitest';
import { RHYTHM_PRESETS, rhythmStatus, rhythmDots, rhythmPhase, isValidRhythm, type RhythmConfig } from '../src/pomodoro.js';

const CLASSIC: RhythmConfig = { enabled: true, focusMin: 25, breakMin: 5, longBreakEvery: 4, longBreakMin: 15 };

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

describe('rhythmPhase（自动阶段推导）', () => {
  it('未到节奏点：focus + 剩余秒数', () => {
    const p = rhythmPhase(10 * 60, 0, false, CLASSIC);
    expect(p.phase).toBe('focus');
    expect(p.seconds).toBe(15 * 60);
  });

  it('到节奏点且未暂停：ready_break', () => {
    const p = rhythmPhase(25 * 60, 0, false, CLASSIC);
    expect(p.phase).toBe('ready_break');
    expect(p.suggestedBreak).toBe('short');
  });

  it('到节奏点且暂停中、休息不够：focus（剩余休息参考）', () => {
    const p = rhythmPhase(25 * 60, 60, true, CLASSIC);
    expect(p.phase).toBe('focus');
    expect(p.seconds).toBe(5 * 60 - 60);
  });

  it('到节奏点且暂停中、休息够了：break_ready', () => {
    const p = rhythmPhase(25 * 60, 5 * 60, true, CLASSIC);
    expect(p.phase).toBe('break_ready');
    expect(p.seconds).toBe(0);
  });

  it('休息超时：break_ready 且显示超出秒数', () => {
    const p = rhythmPhase(25 * 60, 5 * 60 + 40, true, CLASSIC);
    expect(p.phase).toBe('break_ready');
    expect(p.seconds).toBe(40);
  });

  it('第 4 轮后建议长休息', () => {
    const p = rhythmPhase(4 * 25 * 60, 0, false, CLASSIC);
    expect(p.phase).toBe('ready_break');
    expect(p.suggestedBreak).toBe('long');
  });
});

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

import { dayRhythm } from '../src/pomodoro.js';

const CFG90: RhythmConfig = { enabled: true, focusMin: 90, breakMin: 20, longBreakEvery: 2, longBreakMin: 30 };

describe('dayRhythm（跨科目/跨会话节奏）', () => {
  const T0 = Date.UTC(2026, 7, 10, 1, 0, 0); // 北京时间 09:00

  it('没有会话 → fresh', () => {
    const r = dayRhythm([], T0, CFG90);
    expect(r.phase).toBe('fresh');
    expect(r.focusRemainingSec).toBe(90 * 60);
  });

  it('背单词 85 分钟（未达整轮）后结束 → resting + 短休息 + 预计回归时间', () => {
    const stamps = [{ startedAtMs: T0, endedAtMs: T0 + 85 * 60000, activeSeconds: 85 * 60 }];
    const r = dayRhythm(stamps, T0 + 92 * 60000, CFG90); // 结束后 7 分钟
    expect(r.phase).toBe('resting');
    expect(r.focusAccumSec).toBe(85 * 60);
    expect(r.suggestedBreakSec).toBe(20 * 60); // 未达整轮也给短休息
    expect(r.restElapsedSec).toBe(7 * 60);
    expect(r.restRemainingSec).toBe(13 * 60);
    expect(r.projectedResumeMs).toBe(T0 + 85 * 60000 + 20 * 60000);
    expect(r.roundsDone).toBe(0);
  });

  it('专注达 90 分钟 → 长休息（每 2 轮）判断正确', () => {
    const stamps = [
      { startedAtMs: T0, endedAtMs: T0 + 90 * 60000, activeSeconds: 90 * 60 },
    ];
    const r = dayRhythm(stamps, T0 + 95 * 60000, CFG90);
    expect(r.roundsDone).toBe(1);
    expect(r.isLongBreak).toBe(false); // 第 1 轮后是短休息
    expect(r.suggestedBreakSec).toBe(20 * 60);
  });

  it('第 2 轮后 → 长休息 30 分', () => {
    const stamps = [
      { startedAtMs: T0, endedAtMs: T0 + 90 * 60000, activeSeconds: 90 * 60 },
      { startedAtMs: T0 + 110 * 60000, endedAtMs: T0 + 200 * 60000, activeSeconds: 90 * 60 },
    ];
    const r = dayRhythm(stamps, T0 + 205 * 60000, CFG90);
    expect(r.roundsDone).toBe(2);
    expect(r.isLongBreak).toBe(true);
    expect(r.suggestedBreakSec).toBe(30 * 60);
  });

  it('休息够了 → break_ready', () => {
    const stamps = [{ startedAtMs: T0, endedAtMs: T0 + 90 * 60000, activeSeconds: 90 * 60 }];
    const r = dayRhythm(stamps, T0 + 115 * 60000, CFG90); // 25 分钟后
    expect(r.phase).toBe('break_ready');
    expect(r.restRemainingSec).toBe(0);
    expect(r.projectedResumeMs).toBeNull();
  });

  it('换科目不打断节奏：两个会话的专注累计', () => {
    const stamps = [
      { startedAtMs: T0, endedAtMs: T0 + 50 * 60000, activeSeconds: 50 * 60 },
      { startedAtMs: T0 + 52 * 60000, endedAtMs: T0 + 92 * 60000, activeSeconds: 40 * 60 },
    ];
    const r = dayRhythm(stamps, T0 + 95 * 60000, CFG90);
    expect(r.focusAccumSec).toBe(90 * 60); // 50+40 累计达标
    expect(r.roundsDone).toBe(1);
    expect(r.phase).toBe('resting');
  });

  it('足够长的休息（≥2×长休息）开启新专注块', () => {
    const stamps = [
      { startedAtMs: T0, endedAtMs: T0 + 90 * 60000, activeSeconds: 90 * 60 },
      // 休息 65 分钟（≥60=2×30）→ 新块
      { startedAtMs: T0 + 155 * 60000, endedAtMs: T0 + 185 * 60000, activeSeconds: 30 * 60 },
    ];
    const r = dayRhythm(stamps, T0 + 190 * 60000, CFG90);
    expect(r.focusAccumSec).toBe(30 * 60); // 只算新块
    expect(r.roundsDone).toBe(0);
  });

  it('轮间正常休息（短/长休）不切分节奏', () => {
    const stamps = [
      { startedAtMs: T0, endedAtMs: T0 + 90 * 60000, activeSeconds: 90 * 60 },
      // 休息 25 分钟 → 仍在节奏内，累计 120 分 = 超过 1 轮
      { startedAtMs: T0 + 115 * 60000, endedAtMs: T0 + 145 * 60000, activeSeconds: 30 * 60 },
    ];
    const r = dayRhythm(stamps, T0 + 150 * 60000, CFG90);
    expect(r.focusAccumSec).toBe(120 * 60); // 90+30 累计
    expect(r.roundsDone).toBe(1);
  });
});

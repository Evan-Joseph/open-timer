import { describe, expect, it } from 'vitest';
import { QUIET_PERIODS, isQuietMinute, quietPeriodSegments, timelineRange } from './timeline-policy.js';

describe('静默时段', () => {
  it('以结构化规则分别描述午饭、午睡、晚饭、晚间收尾与跨午夜夜间', () => {
    expect(QUIET_PERIODS).toEqual([
      { id: 'lunch', label: '午饭', startMinute: 11 * 60 + 20, endMinute: 12 * 60 + 25 },
      { id: 'nap', label: '午睡', startMinute: 12 * 60 + 25, endMinute: 13 * 60 + 40 },
      { id: 'dinner', label: '晚饭', startMinute: 17 * 60 + 15, endMinute: 18 * 60 + 25 },
      { id: 'evening', label: '晚间收尾', startMinute: 21 * 60 + 45, endMinute: 22 * 60 + 30 },
      { id: 'night', label: '夜间', startMinute: 22 * 60 + 30, endMinute: 8 * 60 },
    ]);
  });

  it('覆盖午饭、午睡、晚饭、晚间收尾与跨午夜睡眠，边界外立即恢复提醒', () => {
    // 上午专注到 11:20
    expect(isQuietMinute(11 * 60 + 19)).toBe(false);
    expect(isQuietMinute(11 * 60 + 20)).toBe(true);
    // 午饭与午睡连续拼接
    expect(isQuietMinute(12 * 60 + 24)).toBe(true);
    expect(isQuietMinute(12 * 60 + 25)).toBe(true);
    expect(isQuietMinute(13 * 60 + 39)).toBe(true);
    expect(isQuietMinute(13 * 60 + 40)).toBe(false); // 下午开工
    // 下午专注到 17:15
    expect(isQuietMinute(17 * 60 + 14)).toBe(false);
    expect(isQuietMinute(17 * 60 + 15)).toBe(true);
    expect(isQuietMinute(18 * 60 + 24)).toBe(true);
    expect(isQuietMinute(18 * 60 + 25)).toBe(false); // 晚自习开工
    // 晚间专注到 21:45
    expect(isQuietMinute(21 * 60 + 44)).toBe(false);
    expect(isQuietMinute(21 * 60 + 45)).toBe(true); // 晚间收尾与浴室关门缓冲
    // 22:30 起跨午夜至 08:00 为夜间静默
    expect(isQuietMinute(22 * 60 + 30)).toBe(true);
    expect(isQuietMinute(23 * 60 + 59)).toBe(true);
    expect(isQuietMinute(0)).toBe(true);
    expect(isQuietMinute(3 * 60)).toBe(true);
    expect(isQuietMinute(7 * 60 + 59)).toBe(true);
    expect(isQuietMinute(8 * 60)).toBe(false); // 次日开工
  });
});

describe('时间轴尺度', () => {
  it('全天固定为 00:00–24:00，暴露完整一天', () => {
    expect(timelineRange('full-day', 12 * 60)).toEqual({ startMinute: 0, endMinute: 24 * 60 });
  });

  it('默认尺度以锚点为中心附近给出稳定的 4 小时窗口', () => {
    expect(timelineRange('default', 13 * 60)).toEqual({ startMinute: 10 * 60 + 36, endMinute: 14 * 60 + 36 });
  });

  it('全天窗口把跨午夜夜间拆成两段，按渲染范围裁剪', () => {
    expect(quietPeriodSegments({ startMinute: 0, endMinute: 24 * 60 })).toEqual([
      { id: 'lunch', label: '午饭', startMinute: 11 * 60 + 20, endMinute: 12 * 60 + 25 },
      { id: 'nap', label: '午睡', startMinute: 12 * 60 + 25, endMinute: 13 * 60 + 40 },
      { id: 'dinner', label: '晚饭', startMinute: 17 * 60 + 15, endMinute: 18 * 60 + 25 },
      { id: 'evening', label: '晚间收尾', startMinute: 21 * 60 + 45, endMinute: 22 * 60 + 30 },
      { id: 'night', label: '夜间', startMinute: 22 * 60 + 30, endMinute: 24 * 60 },
      { id: 'night', label: '夜间', startMinute: 0, endMinute: 8 * 60 },
    ]);
  });
});

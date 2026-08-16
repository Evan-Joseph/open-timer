import { describe, expect, it } from 'vitest';
import { isQuietMinute, timelineRange } from './timeline-policy.js';

describe('静默时段', () => {
  it('覆盖午饭午睡、晚饭与跨午夜睡眠，边界外立即恢复提醒', () => {
    expect(isQuietMinute(10 * 60 + 59)).toBe(false);
    expect(isQuietMinute(11 * 60)).toBe(true);
    expect(isQuietMinute(13 * 60 + 29)).toBe(true);
    expect(isQuietMinute(13 * 60 + 30)).toBe(false);
    expect(isQuietMinute(17 * 60)).toBe(true);
    expect(isQuietMinute(18 * 60)).toBe(false);
    expect(isQuietMinute(22 * 60 + 30)).toBe(true);
    expect(isQuietMinute(7 * 60 + 59)).toBe(true);
    expect(isQuietMinute(8 * 60)).toBe(false);
  });
});

describe('时间轴尺度', () => {
  it('全天固定为 08:00–22:30', () => {
    expect(timelineRange('full-day', [], 12 * 60)).toEqual({ startMinute: 8 * 60, endMinute: 22 * 60 + 30 });
  });

  it('有效全天在首末片段前后保留 30 分钟空白并裁剪到学习窗口', () => {
    expect(timelineRange('effective-day', [{ startMinute: 9 * 60, endMinute: 12 * 60 }], 12 * 60)).toEqual({
      startMinute: 8 * 60 + 30,
      endMinute: 12 * 60 + 30,
    });
    expect(timelineRange('effective-day', [{ startMinute: 7 * 60, endMinute: 23 * 60 }], 12 * 60)).toEqual({
      startMinute: 8 * 60,
      endMinute: 22 * 60 + 30,
    });
  });

  it('默认尺度以锚点为中心附近给出稳定的 4 小时窗口；无片段有效全天回退全天', () => {
    expect(timelineRange('default', [], 13 * 60)).toEqual({ startMinute: 10 * 60 + 36, endMinute: 14 * 60 + 36 });
    expect(timelineRange('effective-day', [], 13 * 60)).toEqual({ startMinute: 8 * 60, endMinute: 22 * 60 + 30 });
  });
});

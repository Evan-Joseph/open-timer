import { describe, expect, it } from 'vitest';
import {
  shanghaiDayRangeUtc,
  utcMsToShanghaiDate,
  isValidShanghaiDate,
  SHANGHAI_OFFSET_MS,
} from '../src/shanghai.js';

describe('北京时间日切（固定 UTC+8，无 DST）', () => {
  it('北京 2026-08-09 的 UTC 窗口是 08-08T16:00Z → 08-09T16:00Z', () => {
    const { startMs, endMs } = shanghaiDayRangeUtc('2026-08-09');
    expect(new Date(startMs).toISOString()).toBe('2026-08-08T16:00:00.000Z');
    expect(new Date(endMs).toISOString()).toBe('2026-08-09T16:00:00.000Z');
    expect(endMs - startMs).toBe(86_400_000);
  });

  it('跨年/跨月窗口正确', () => {
    const { startMs } = shanghaiDayRangeUtc('2026-01-01');
    expect(new Date(startMs).toISOString()).toBe('2025-12-31T16:00:00.000Z');
  });

  it('北京 00:00 整点属于新的一天', () => {
    // 2026-08-09 00:00 +08:00 = 2026-08-08T16:00:00Z
    const boundary = Date.UTC(2026, 7, 8, 16, 0, 0);
    expect(utcMsToShanghaiDate(boundary)).toBe('2026-08-09');
    expect(utcMsToShanghaiDate(boundary - 1)).toBe('2026-08-08');
  });

  it('UTC 午夜在北京是上午 8 点', () => {
    expect(utcMsToShanghaiDate(Date.UTC(2026, 7, 9, 0, 0, 0))).toBe('2026-08-09');
  });

  it('偏移恒定 8 小时（无夏令时断言）', () => {
    for (const month of [0, 3, 6, 10]) {
      const d = `2026-${String(month + 1).padStart(2, '0')}-15`;
      const { startMs } = shanghaiDayRangeUtc(d);
      const [y, m, dd] = d.split('-').map(Number);
      expect(Date.UTC(y, m - 1, dd) - startMs).toBe(SHANGHAI_OFFSET_MS);
    }
  });

  it('日期格式校验', () => {
    expect(isValidShanghaiDate('2026-08-09')).toBe(true);
    expect(isValidShanghaiDate('2026-8-9')).toBe(false);
    expect(isValidShanghaiDate('2026-13-01')).toBe(false);
    expect(isValidShanghaiDate('2026-02-30')).toBe(false);
    expect(isValidShanghaiDate('2024-02-29')).toBe(true); // 闰年
    expect(isValidShanghaiDate('2026-02-29')).toBe(false);
    expect(isValidShanghaiDate('not-a-date')).toBe(false);
  });

  it('非法日期抛错', () => {
    expect(() => shanghaiDayRangeUtc('2026-02-30')).toThrow();
  });
});

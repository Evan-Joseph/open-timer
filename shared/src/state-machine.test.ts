import { describe, expect, it } from 'vitest';
import {
  canTransition,
  nextStatus,
  computeActiveSeconds,
  StateMachineError,
  isCountedSegment,
  DEFAULT_MIN_COUNTED_SEGMENT_MS,
} from '../src/state-machine.js';

describe('状态机转移表', () => {
  it('idle → created → running', () => {
    expect(canTransition(null, 'created')).toBe(true);
    expect(nextStatus(null, 'created')).toBe('running');
  });

  it('running 可 pause / stop，不可 resume / void / created', () => {
    expect(canTransition('running', 'paused')).toBe(true);
    expect(canTransition('running', 'stopped')).toBe(true);
    expect(canTransition('running', 'resumed')).toBe(false);
    expect(canTransition('running', 'voided')).toBe(false);
    expect(canTransition('running', 'created')).toBe(false);
  });

  it('paused 可 resume / stop，不可 pause', () => {
    expect(canTransition('paused', 'resumed')).toBe(true);
    expect(canTransition('paused', 'stopped')).toBe(true);
    expect(canTransition('paused', 'paused')).toBe(false);
  });

  it('stopped 可 void / resume（误触继续），不可 stop / created', () => {
    expect(canTransition('stopped', 'voided')).toBe(true);
    expect(canTransition('stopped', 'resumed')).toBe(true);
    expect(nextStatus('stopped', 'resumed')).toBe('running');
    expect(canTransition('stopped', 'stopped')).toBe(false);
    expect(canTransition('stopped', 'created')).toBe(false);
  });

  it('voided 是终态', () => {
    for (const a of ['created', 'paused', 'resumed', 'stopped', 'voided'] as const) {
      expect(canTransition('voided', a)).toBe(false);
    }
  });

  it('非法转移抛 StateMachineError', () => {
    expect(() => nextStatus(null, 'paused')).toThrow(StateMachineError);
    expect(() => nextStatus('voided', 'resumed')).toThrow(StateMachineError);
  });

  it('有活动会话时不可 created', () => {
    expect(canTransition('running', 'created')).toBe(false);
    expect(canTransition('paused', 'created')).toBe(false);
  });
});

describe('净时长计算', () => {
  it('多段求和并向下取整', () => {
    const secs = computeActiveSeconds([
      { startedAtMs: 1000, endedAtMs: 61_000 }, // 60s
      { startedAtMs: 120_000, endedAtMs: 150_500 }, // 30.5s → 30
    ]);
    expect(secs).toBe(90);
  });

  it('开放段用 atMs 封顶', () => {
    const secs = computeActiveSeconds([{ startedAtMs: 1000, endedAtMs: null }], 31_000);
    expect(secs).toBe(30);
  });

  it('负段钳制为 0', () => {
    const secs = computeActiveSeconds([{ startedAtMs: 5000, endedAtMs: 1000 }]);
    expect(secs).toBe(0);
  });

  it('空段列表为 0', () => {
    expect(computeActiveSeconds([])).toBe(0);
  });
});

describe('误触片段过滤', () => {
  it('默认阈值为 10 秒', () => {
    expect(DEFAULT_MIN_COUNTED_SEGMENT_MS).toBe(10_000);
  });

  it('开放段始终计入（仍在计时，不可预判为误触）', () => {
    expect(isCountedSegment({ startedAtMs: 1000, endedAtMs: null }, 10_000)).toBe(true);
  });

  it('短于阈值的已关闭段不计入', () => {
    expect(isCountedSegment({ startedAtMs: 0, endedAtMs: 9_999 }, 10_000)).toBe(false);
    expect(isCountedSegment({ startedAtMs: 0, endedAtMs: 1_000 }, 10_000)).toBe(false);
  });

  it('达到阈值的已关闭段计入（含恰好等于）', () => {
    expect(isCountedSegment({ startedAtMs: 0, endedAtMs: 10_000 }, 10_000)).toBe(true);
    expect(isCountedSegment({ startedAtMs: 0, endedAtMs: 60_000 }, 10_000)).toBe(true);
  });

  it('阈值 0 时全部计入（测试环境禁用过滤）', () => {
    expect(isCountedSegment({ startedAtMs: 0, endedAtMs: 500 }, 0)).toBe(true);
  });
});

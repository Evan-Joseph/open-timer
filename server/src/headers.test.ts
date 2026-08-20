import { describe, expect, it } from 'vitest';
import { clientIp } from '../src/headers.js';

describe('clientIp', () => {
  it('优先采用 CF-Connecting-IP（边缘写入，不可伪造）', () => {
    const headers: Record<string, string> = {
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.1, 10.0.0.1',
    };
    expect(clientIp((name) => headers[name])).toBe('203.0.113.9');
  });

  it('无 CF 头时降级取 x-forwarded-for 首段', () => {
    const headers: Record<string, string> = { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' };
    expect(clientIp((name) => headers[name])).toBe('198.51.100.1');
  });

  it('全部缺失返回 anon', () => {
    expect(clientIp(() => undefined)).toBe('anon');
  });

  it('空值视为缺失', () => {
    const headers: Record<string, string> = { 'cf-connecting-ip': '   ', 'x-forwarded-for': ' , ' };
    expect(clientIp((name) => headers[name])).toBe('anon');
  });
});

/** 极简固定窗口限流（进程内）。单用户场景足够；云上可用 Durable Object/KV 替换。 */

interface Bucket {
  count: number;
  windowStartMs: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private windowMs: number,
    private maxHits: number,
  ) {}

  allow(key: string, nowMs: number): boolean {
    let b = this.buckets.get(key);
    if (!b || nowMs - b.windowStartMs >= this.windowMs) {
      b = { count: 0, windowStartMs: nowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= this.maxHits;
  }

  /** 测试用 */
  reset(): void {
    this.buckets.clear();
  }
}

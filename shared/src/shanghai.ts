/**
 * 北京时间（Asia/Shanghai）日切纯函数。
 *
 * Asia/Shanghai 自 1991 年起无夏令时，固定 UTC+8。为避免时区数据库与
 * 运行环境差异，日切使用固定偏移的纯算术：确定性、可测试、跨运行时一致。
 * 显示层使用 Intl.DateTimeFormat(timeZone:'Asia/Shanghai')。
 */

export const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
export const DAY_MS = 86_400_000;
export const TIMEZONE = 'Asia/Shanghai';

/** 校验 YYYY-MM-DD 格式并是真实日历日期（且不早于 1992-01-01）。 */
export function isValidShanghaiDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // 固定 +8 无夏令时的假设仅对 1992-01-01 之后成立：中国夏令时 1986–1991，
  // 1991-09-15 最后一次结束。为简单起见整年 1991 拒绝，避免静默按 +8 错误换算
  // （本项目只涉及当下/未来日期，此拒绝无实际影响）。
  if (y < 1992) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 某北京日期的 UTC 窗口 [startMs, endMs)。 */
export function shanghaiDayRangeUtc(date: string): { startMs: number; endMs: number } {
  if (!isValidShanghaiDate(date)) throw new Error(`invalid date: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

/** UTC epoch ms → 北京日期 YYYY-MM-DD。 */
export function utcMsToShanghaiDate(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 当前北京日期（由传入的 UTC now 决定，方便注入测试）。 */
export function shanghaiToday(nowUtcMs: number): string {
  return utcMsToShanghaiDate(nowUtcMs);
}

/** UTC epoch ms → ISO 8601（带 Z）。 */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** ISO → epoch ms；非法返回 null。 */
export function fromIso(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 神奇海螺的设备本地缓存。
 *
 * 服务端 D1 负责跨浏览器/跨 Worker 的共享结果与生成协调；这里仅保存当前设备最近
 * 成功展示过的建议，减少每次打开时的网络往返。离开 owner 态立即清除，避免共享设备残留。
 */

import type { ConchAskResponseApi, ConchWindow } from './api.js';

const CACHE_KEY = 'clock-conch-cache-v5';
const CACHE_TTL_FALLBACK_MS = 30 * 60 * 1000;

interface CacheEntry {
  ts: number;
  data: ConchAskResponseApi;
}

type CacheMap = Partial<Record<ConchWindow, CacheEntry>>;

function readCacheMap(): CacheMap {
  try {
    return (JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') ?? {}) as CacheMap;
  } catch {
    return {};
  }
}

/** 正常按 completed-timeline revision + 模型命中；只有 revision 暂不可得时才回退短 TTL。 */
export function readConchCache(
  window: ConchWindow,
  currentConchRevision: number | null,
  expectedModel: string | null,
): ConchAskResponseApi | null {
  const entry = readCacheMap()[window];
  if (!entry) return null;
  const validUntilMs = Date.parse(entry.data.cache_valid_until);
  // completed-timeline revision 不变时，7/30 天窗口仍会连续滚动；到服务端给出的最早输入变化边界必须重新校验。
  if (!Number.isFinite(validUntilMs) || Date.now() >= validUntilMs) return null;
  if (currentConchRevision !== null) {
    return entry.data.conch_revision === currentConchRevision && (expectedModel === null || entry.data.model === expectedModel)
      ? entry.data
      : null;
  }
  return Date.now() - entry.ts < CACHE_TTL_FALLBACK_MS ? entry.data : null;
}

/** 读取当前 map 后只替换指定窗口，避免 all / 30d / 7d 彼此覆盖。 */
export function writeConchCache(window: ConchWindow, data: ConchAskResponseApi): void {
  try {
    const map = readCacheMap();
    map[window] = { ts: Date.now(), data };
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    /* 隐私模式等场景降级为无本地缓存 */
  }
}

/** owner 登出或 cookie 失效后不保留建议内容。 */
export function clearConchCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* localStorage 不可用时无需额外处理 */
  }
}

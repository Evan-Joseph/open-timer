/** 环境变量与配置边界：所有环境差异集中在此文件。 */

import { join } from 'node:path';

export interface AppConfig {
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** HTTP 监听端口 */
  port: number;
  /** cookie 安全域相关 */
  baseUrl: string;
  /** 是否公网模式（影响 Secure cookie / HSTS） */
  isProduction: boolean;
  /** owner 会话有效期 */
  sessionTtlMs: number;
  /** 误触过滤：短于该毫秒数的已关闭片段不计入（默认 10s；CLOCK_MIN_SEGMENT_SECONDS 覆盖，0=禁用） */
  minSegmentMs: number;
  version: string;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.CLOCK_DATA_DIR ?? join(process.cwd(), 'data');
  return {
    dbPath: process.env.CLOCK_DB_PATH ?? join(dataDir, 'clock.sqlite'),
    port: Number(process.env.CLOCK_PORT ?? 4517),
    baseUrl: process.env.CLOCK_BASE_URL ?? 'http://127.0.0.1:4517',
    isProduction: process.env.NODE_ENV === 'production',
    sessionTtlMs: 7 * 86_400_000,
    minSegmentMs: Number(process.env.CLOCK_MIN_SEGMENT_SECONDS ?? 10) * 1000,
    version: '0.1.0',
  };
}

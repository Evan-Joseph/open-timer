/** Environment configuration. Legacy AI environment parsing lives in conch-config.ts. */

import { join } from 'node:path';
import { loadConchConfig, type ConchConfig } from './conch-config.js';

export { loadConchConfig };
export type { ConchConfig };

export interface AppConfig {
  /** SQLite 数据库文件路径 */
  dbPath: string;
  /** HTTP 监听端口 */
  port: number;
  /** cookie 安全域相关 */
  baseUrl: string;
  /** 是否公网模式（影响 Secure cookie / HSTS） */
  isProduction: boolean;
  /** Secure cookies require HTTPS; local Docker HTTP explicitly opts out. */
  cookieSecure?: boolean;
  /** owner 会话有效期 */
  sessionTtlMs: number;
  /** 误触过滤：短于该毫秒数的已关闭片段不计入（默认 10s；CLOCK_MIN_SEGMENT_SECONDS 覆盖，0=禁用） */
  minSegmentMs: number;
  /** Legacy environment AI configuration; null when not configured. */
  conch: ConchConfig | null;
  /** Required to persist owner-entered AI keys. Never exposed to the browser. */
  aiEncryptionKey?: string | null;
  /** Production instances are claimed only by this deployment secret, never by a first visitor. */
  initialOwnerPin?: string | null;
  version: string;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.CLOCK_DATA_DIR ?? join(process.cwd(), 'data');
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    dbPath: process.env.CLOCK_DB_PATH ?? join(dataDir, 'clock.sqlite'),
    port: Number(process.env.CLOCK_PORT ?? 4517),
    baseUrl: process.env.CLOCK_BASE_URL ?? 'http://127.0.0.1:4517',
    isProduction,
    cookieSecure: process.env.CLOCK_COOKIE_SECURE === undefined ? isProduction : process.env.CLOCK_COOKIE_SECURE === 'true',
    sessionTtlMs: 7 * 86_400_000,
    minSegmentMs: Number(process.env.CLOCK_MIN_SEGMENT_SECONDS ?? 10) * 1000,
    conch: loadConchConfig(process.env),
    aiEncryptionKey: process.env.AI_CONFIG_ENCRYPTION_KEY?.trim() || null,
    initialOwnerPin: /^\d{6}$/.test(process.env.CLOCK_INITIAL_OWNER_PIN ?? '') ? process.env.CLOCK_INITIAL_OWNER_PIN! : null,
    version: '0.1.0',
  };
}

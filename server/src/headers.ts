/**
 * 统一安全响应头：API 与静态资源共用同一套，覆盖所有响应（含 404/500）。
 *
 * CSP 与 Vite 产物对齐：无内联脚本（防闪白脚本已外置为 /theme-init.js），
 * 样式允许 unsafe-inline（React 行内 style 属性需要），其余资源一律同源。
 * frame-ancestors 'none' 与 X-Frame-Options: DENY 双保险（旧浏览器兜底）。
 */

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface SecurityHeaderOptions {
  /** 生产环境追加 HSTS（本地 http 127.0.0.1 除外） */
  isProduction: boolean;
}

/**
 * 把安全头写入响应。setter 抽象同时服务 Hono（c.header）与
 * Worker 静态资源（Headers.set），保证两个入口的头集合完全一致。
 */
export function applySecurityHeaders(
  setHeader: (name: string, value: string) => void,
  options: SecurityHeaderOptions,
): void {
  setHeader('X-Content-Type-Options', 'nosniff');
  setHeader('X-Frame-Options', 'DENY');
  setHeader('Referrer-Policy', 'no-referrer');
  setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  if (options.isProduction) {
    setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

/**
 * 限流/审计用的客户端 IP：Cloudflare 边缘写入的 CF-Connecting-IP 不可被客户端伪造，
 * 优先采用；x-forwarded-for 可被任意伪造，只作为非边缘环境（本机直连）的降级，
 * 不得作为可信身份依据。参考 Cloudflare HTTP 请求头文档与 XFF 伪造的公开案例。
 */
export function clientIp(headerGet: (name: string) => string | undefined): string {
  const cf = headerGet('cf-connecting-ip');
  if (cf && cf.trim()) return cf.trim();
  const xff = headerGet('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'anon';
}

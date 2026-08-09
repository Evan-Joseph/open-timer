/** 鉴权：owner cookie 会话 + 总控只读 API token（sha256 存储）。 */

import { createHash, randomBytes } from 'node:crypto';
import type { Context, Next } from 'hono';
import type { Storage } from './repo/storage.js';

export const OWNER_COOKIE = 'clock_session';

export function sha256hex(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export type AuthKind = 'owner' | 'api_read';

export interface AuthInfo {
  kind: AuthKind;
  actor: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthInfo;
  }
}

/** 解析 owner cookie（session token sha256）。 */
export function getOwnerAuth(c: Context, storage: Storage): AuthInfo | null {
  const raw = getCookie(c, OWNER_COOKIE);
  if (!raw) return null;
  const s = storage.getOwnerSession(sha256hex(raw));
  if (!s) return null;
  return { kind: 'owner', actor: 'owner' };
}

/** 解析 X-API-Key（总控只读）。 */
export function getApiAuth(c: Context, storage: Storage): AuthInfo | null {
  const key = c.req.header('x-api-key');
  if (!key) return null;
  const cred = storage.credentialByTokenSha(sha256hex(key));
  if (!cred || cred.revokedAtMs !== null) return null;
  return { kind: 'api_read', actor: `api:${cred.name}` };
}

export function requireOwner(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = getOwnerAuth(c, storage);
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', auth);
    await next();
  };
}

/** 任一有效凭据（owner 或只读 token）可读。 */
export function requireAnyRead(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = getOwnerAuth(c, storage) ?? getApiAuth(c, storage);
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', auth);
    await next();
  };
}

export function requireApiRead(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = getApiAuth(c, storage);
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', auth);
    await next();
  };
}

function getCookie(c: Context, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function serializeCookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSec}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 鉴权：owner cookie 会话 + 总控只读 API token（sha256 存储）。全部 Web Crypto，跨运行时。 */

import type { Context, Next } from 'hono';
import type { Storage } from './repo/storage.js';

export const OWNER_COOKIE = 'clock_session';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export async function sha256hex(v: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return toHex(new Uint8Array(digest));
}

export function generateToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${prefix}_${b64url}`;
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
export async function getOwnerAuth(c: Context, storage: Storage): Promise<AuthInfo | null> {
  const raw = getCookie(c, OWNER_COOKIE);
  if (!raw) return null;
  const s = await storage.getOwnerSession(await sha256hex(raw));
  if (!s) return null;
  return { kind: 'owner', actor: 'owner' };
}

/** 解析 X-API-Key（总控只读）。 */
export async function getApiAuth(c: Context, storage: Storage): Promise<AuthInfo | null> {
  const key = c.req.header('x-api-key');
  if (!key) return null;
  const cred = await storage.credentialByTokenSha(await sha256hex(key));
  if (!cred || cred.revokedAtMs !== null) return null;
  return { kind: 'api_read', actor: `api:${cred.name}` };
}

export function requireOwner(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = await getOwnerAuth(c, storage);
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', auth);
    await next();
  };
}

/** 任一有效凭据（owner 或只读 token）可读。 */
export function requireAnyRead(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = (await getOwnerAuth(c, storage)) ?? (await getApiAuth(c, storage));
    if (!auth) return c.json({ error: 'UNAUTHORIZED' }, 401);
    c.set('auth', auth);
    await next();
  };
}

export function requireApiRead(storage: Storage) {
  return async (c: Context, next: Next) => {
    const auth = await getApiAuth(c, storage);
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

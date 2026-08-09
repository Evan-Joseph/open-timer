/** 密码哈希：PBKDF2-SHA256（Web Crypto，Node 与 Workers 通用）。 */

const ITERATIONS = 100_000; // Cloudflare Workers WebCrypto PBKDF2 上限为 100k
const KEY_LENGTH = 32;

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations: ITERATIONS },
    keyMaterial,
    KEY_LENGTH * 8,
  );
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'pbkdf2') return false;
    const iterations = Number(iterStr);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const salt = fromB64(saltB64);
    const expected = fromB64(hashB64);
    const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
      keyMaterial,
      expected.length * 8,
    );
    const actual = new Uint8Array(bits);
    if (actual.length !== expected.length) return false;
    // 常量时间比较
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

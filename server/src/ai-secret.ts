/** AES-GCM protection for persisted assistant credentials.
 * The deployment-provided master key is intentionally required before a key can
 * be saved. Ciphertext is safe to back up; plaintext never reaches an API
 * response, log, or browser bundle.
 */

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function unbase64(value: string): Uint8Array {
  const text = atob(value);
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** Copy into an owned ArrayBuffer so it satisfies Web Crypto's strict BufferSource type. */
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

async function keyFrom(masterKey: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(masterKey));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptAiSecret(plainText: string, masterKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(masterKey), encoder.encode(plainText)));
  return `${base64(iv)}.${base64(cipher)}`;
}

export async function decryptAiSecret(payload: string, masterKey: string): Promise<string> {
  const [ivText, cipherText, extra] = payload.split('.');
  if (!ivText || !cipherText || extra) throw new Error('INVALID_ENCRYPTED_AI_SECRET');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(unbase64(ivText)) },
    await keyFrom(masterKey),
    ownedBuffer(unbase64(cipherText)),
  );
  return new TextDecoder().decode(plain);
}

import { describe, expect, it } from 'vitest';
import { decryptAiSecret, encryptAiSecret } from './ai-secret.js';

describe('AI secret encryption', () => {
  it('round-trips a secret without keeping plaintext in ciphertext', async () => {
    const plain = 'provider-key-should-not-leak';
    const encrypted = await encryptAiSecret(plain, 'master-key-a');
    expect(encrypted).not.toContain(plain);
    await expect(decryptAiSecret(encrypted, 'master-key-a')).resolves.toBe(plain);
  });

  it('rejects a wrong master key and tampered ciphertext', async () => {
    const encrypted = await encryptAiSecret('provider-key', 'master-key-a');
    await expect(decryptAiSecret(encrypted, 'master-key-b')).rejects.toThrow();
    await expect(decryptAiSecret(`${encrypted}x`, 'master-key-a')).rejects.toThrow();
  });
});

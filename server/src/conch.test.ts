import { describe, expect, it } from 'vitest';
import { createConchLlmClient } from './conch-client.js';

describe('AI client secrecy', () => {
  it('does not expose provider response details on upstream failures', async () => {
    const client = createConchLlmClient(
      { apiBase: 'https://example.test/v1', apiKey: 'not-logged', model: 'test', thinkingBudget: 0 },
      { fetchImpl: async () => new Response('provider secret', { status: 401 }) },
    );
    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toThrow('llm upstream status 401');
  });
});

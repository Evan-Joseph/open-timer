import { describe, expect, it } from 'vitest';
import { createConchLlmClient } from './conch-client.js';

const CONFIG = {
  apiBase: 'https://api.siliconflow.cn/v1',
  apiKey: 'test-key',
  model: 'deepseek-ai/DeepSeek-V4-Pro',
  thinkingBudget: 768,
};

describe('SiliconFlow Conch client', () => {
  it('使用官方 JSON Mode 与顶层 thinking_budget 请求形状', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"subjects":[]}' } }] }), { status: 200 });
    }) as typeof fetch;
    const client = createConchLlmClient(CONFIG, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).resolves.toEqual({ content: '{"subjects":[]}' });
    expect(sentBody).toMatchObject({
      model: 'deepseek-ai/DeepSeek-V4-Pro',
      temperature: 0.4,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      thinking_budget: 768,
    });
    expect(sentBody).not.toHaveProperty('thinking');
  });

  it('把上游 401 保留为不泄漏正文的认证错误', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'hidden' }), { status: 401 })) as typeof fetch;
    const client = createConchLlmClient({ ...CONFIG, thinkingBudget: 0 }, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toMatchObject({
      kind: 'auth',
      upstreamStatus: 401,
    });
  });

  it('把上游 402 区分为推理额度不足', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'hidden' }), { status: 402 })) as typeof fetch;
    const client = createConchLlmClient({ ...CONFIG, thinkingBudget: 0 }, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toMatchObject({
      kind: 'quota',
      upstreamStatus: 402,
    });
  });
});

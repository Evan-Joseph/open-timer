import { describe, expect, it } from 'vitest';
import { createConchLlmClient } from './conch-client.js';

const DEEPSEEK_CONFIG = {
  apiBase: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-v4-pro',
  thinkingBudget: 768,
};

describe('Conch LLM client', () => {
  it('DeepSeek 官方端点使用 JSON Output 与官方思考参数', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"subjects":[]}' } }] }), { status: 200 });
    }) as typeof fetch;
    const client = createConchLlmClient(DEEPSEEK_CONFIG, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).resolves.toEqual({ content: '{"subjects":[]}' });
    expect(sentBody).toMatchObject({
      model: 'deepseek-v4-pro',
      max_tokens: 4096,
      response_format: { type: 'json_object' },
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(sentBody).not.toHaveProperty('temperature');
    expect(sentBody).not.toHaveProperty('thinking_budget');
  });

  it('把上游 401 保留为不泄漏正文的认证错误', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'hidden' }), { status: 401 })) as typeof fetch;
    const client = createConchLlmClient({ ...DEEPSEEK_CONFIG, thinkingBudget: 0 }, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toMatchObject({
      kind: 'auth',
      upstreamStatus: 401,
    });
  });

  it('把上游 402 区分为推理额度不足', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'hidden' }), { status: 402 })) as typeof fetch;
    const client = createConchLlmClient({ ...DEEPSEEK_CONFIG, thinkingBudget: 0 }, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toMatchObject({
      kind: 'quota',
      upstreamStatus: 402,
    });
  });

  it('其他 OpenAI 兼容端点保留既有 temperature 与 thinking_budget 形状', async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"subjects":[]}' } }] }), { status: 200 });
    }) as typeof fetch;
    const client = createConchLlmClient({
      apiBase: 'https://gateway.example/v1', apiKey: 'test-key', model: 'example-model', thinkingBudget: 768,
    }, { fetchImpl });

    await client.ask({ system: 'system', user: 'user' });
    expect(sentBody).toMatchObject({ temperature: 0.4, thinking_budget: 768 });
    expect(sentBody).not.toHaveProperty('thinking');
    expect(sentBody).not.toHaveProperty('reasoning_effort');
  });

  it('DeepSeek JSON Output 首次为空时用同一请求重试一次', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const content = calls === 1 ? '' : '{"subjects":[]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    const client = createConchLlmClient(DEEPSEEK_CONFIG, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).resolves.toEqual({ content: '{"subjects":[]}' });
    expect(calls).toBe(2);
  });

  it('DeepSeek 连续空 content 时归类为结构化输出失败', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 });
    }) as typeof fetch;
    const client = createConchLlmClient(DEEPSEEK_CONFIG, { fetchImpl });

    await expect(client.ask({ system: 'system', user: 'user' })).rejects.toMatchObject({ kind: 'invalid' });
    expect(calls).toBe(2);
  });
});

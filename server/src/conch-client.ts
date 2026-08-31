/**
 * 神奇海螺 LLM 客户端：OpenAI 兼容 /chat/completions 的最小 fetch 封装。
 * 密钥只在本模块内作为请求头出现，不进日志、不下发客户端。
 */

import type { ConchConfig } from './config.js';

export interface ConchLlmResult {
  content: string;
}

export type ConchLlmErrorKind = 'timeout' | 'auth' | 'upstream';

export class ConchLlmError extends Error {
  constructor(
    public kind: ConchLlmErrorKind,
    message: string,
    /** 仅用于服务端诊断日志；不向客户端透传上游响应体。 */
    public upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ConchLlmError';
  }
}

export interface ConchLlmClient {
  ask(params: { system: string; user: string }): Promise<ConchLlmResult>;
}

export function createConchLlmClient(
  cfg: ConchConfig,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): ConchLlmClient {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  return {
    async ask({ system, user }) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.4,
        max_tokens: 2048,
        // SiliconFlow JSON Mode：让结构化解析获得稳定 JSON，而非依赖模型偶然遵守 prompt。
        response_format: { type: 'json_object' },
      };
      // SiliconFlow 的推理预算是顶层 thinking_budget，不是嵌套 thinking 对象。
      if (cfg.thinkingBudget > 0) body.thinking_budget = cfg.thinkingBudget;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${cfg.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          // 不透传上游细节（可能含密钥回显/栈信息）
          throw new ConchLlmError(res.status === 401 ? 'auth' : 'upstream', `llm upstream status ${res.status}`, res.status);
        }
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          throw new ConchLlmError('upstream', 'llm empty content');
        }
        return { content };
      } catch (err) {
        if (err instanceof ConchLlmError) throw err;
        if ((err as Error)?.name === 'AbortError') throw new ConchLlmError('timeout', 'llm timeout');
        throw new ConchLlmError('upstream', 'llm network error');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

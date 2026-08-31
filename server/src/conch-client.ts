/**
 * 神奇海螺 LLM 客户端：OpenAI 兼容 /chat/completions 的最小 fetch 封装。
 * 密钥只在本模块内作为请求头出现，不进日志、不下发客户端。
 */

import type { ConchConfig } from './config.js';

export interface ConchLlmResult {
  content: string;
}

export type ConchLlmErrorKind = 'timeout' | 'auth' | 'quota' | 'invalid' | 'upstream';

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
  // DeepSeek 官方端点与 SiliconFlow 等兼容网关的 reasoning 参数不同。
  // 仅按精确官方 hostname 走官方协议；其余端点保留原有兼容请求形状。
  const isOfficialDeepSeek = (() => {
    try {
      return new URL(cfg.apiBase).hostname.toLowerCase() === 'api.deepseek.com';
    } catch {
      return false;
    }
  })();
  const maxTokens = isOfficialDeepSeek ? 4096 : 2048;

  return {
    async ask({ system, user }) {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        // OpenAI 兼容 JSON Output：让结构化解析获得稳定 JSON，而非依赖模型偶然遵守 prompt。
        response_format: { type: 'json_object' },
      };
      if (isOfficialDeepSeek) {
        // DeepSeek 官方文档：思考模式下 temperature 不生效；使用其官方开关和强度字段。
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = 'high';
      } else {
        body.temperature = 0.4;
        // 兼容既有 SiliconFlow 等端点的顶层预算字段。
        if (cfg.thinkingBudget > 0) body.thinking_budget = cfg.thinkingBudget;
      }

      // DeepSeek JSON Output 官方说明偶发空 content；保留同一高质量模型与输入重试一次。
      // 其他兼容端点维持单次调用，避免改变其既有配额与失败语义。
      const attempts = isOfficialDeepSeek ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
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
            const kind = res.status === 401 ? 'auth' : res.status === 402 ? 'quota' : 'upstream';
            throw new ConchLlmError(kind, `llm upstream status ${res.status}`, res.status);
          }
          const data = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = data.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.length > 0) return { content };
          if (attempt + 1 === attempts) {
            // HTTP 200 的模型输出问题明确归为 422，不伪装成上游网络故障。
            throw new ConchLlmError('invalid', 'llm empty content');
          }
        } catch (err) {
          if (err instanceof ConchLlmError) throw err;
          if ((err as Error)?.name === 'AbortError') throw new ConchLlmError('timeout', 'llm timeout');
          throw new ConchLlmError('upstream', 'llm network error');
        } finally {
          clearTimeout(timer);
        }
      }
      throw new ConchLlmError('invalid', 'llm empty content');
    },
  };
}

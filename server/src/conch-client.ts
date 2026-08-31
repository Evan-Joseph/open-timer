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
    /** 上游 POST 已发出的次数。当前契约始终至多一次，保留字段供安全日志关联。 */
    public attempt = 1,
  ) {
    super(message);
    this.name = 'ConchLlmError';
  }
}

export interface ConchLlmClient {
  ask(params: { system: string; user: string }): Promise<ConchLlmResult>;
}

/** 单次海螺请求的总上游等待上限。交互页在超时后应尽快恢复可重试状态。 */
export const CONCH_LLM_TIMEOUT_MS = 45_000;

export function createConchLlmClient(
  cfg: ConchConfig,
  opts?: { timeoutMs?: number; fetchImpl?: typeof fetch },
): ConchLlmClient {
  const timeoutMs = opts?.timeoutMs ?? CONCH_LLM_TIMEOUT_MS;
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
  // 官方 V4-Flash 与 V4-Pro 共用 JSON/思考协议；Flash 用 low effort 降低交互延迟，
  // Pro 保留 high 作为高质量基线。输出字段均有长度上限，2048 已足够容纳 7 科结果。
  const isDeepSeekFlash = isOfficialDeepSeek && cfg.model.trim().toLowerCase() === 'deepseek-v4-flash';
  const maxTokens = isOfficialDeepSeek ? (isDeepSeekFlash ? 2048 : 4096) : 2048;

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
        body.reasoning_effort = isDeepSeekFlash ? 'low' : 'high';
      } else {
        body.temperature = 0.4;
        // 兼容既有 SiliconFlow 等端点的顶层预算字段。
        if (cfg.thinkingBudget > 0) body.thinking_budget = cfg.thinkingBudget;
      }

      // 请求没有可供上游去重的幂等键。HTTP 200 空内容、网络中断与本地 abort 都无法
      // 证明上游没有开始推理，因此统一只发一次 POST，由用户显式「再问一次」重试。
      const deadlineMs = Date.now() + timeoutMs;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) throw new ConchLlmError('timeout', 'llm timeout');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
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
        if (typeof content === 'string' && content.trim().length > 0) return { content };
        // HTTP 200 的模型输出问题明确归为 422，不伪装成上游网络故障。
        throw new ConchLlmError('invalid', 'llm empty content');
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

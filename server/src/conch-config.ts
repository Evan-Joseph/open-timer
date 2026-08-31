/**
 * 神奇海螺 LLM 配置解析（纯函数，无 node API 依赖——可安全进 Workers bundle）。
 * 密钥只存在于服务端（wrangler secret / 本地 env），不下发客户端。
 */

export interface ConchConfig {
  apiBase: string;
  apiKey: string;
  model: string;
  /** 思考 token 预算；0 = 不传该参数（模型默认思考） */
  thinkingBudget: number;
}

export function loadConchConfig(env: Record<string, string | undefined>): ConchConfig | null {
  const apiBase = env.CONCH_API_BASE?.trim();
  // 控制台误把完整 Authorization 值粘进 secret 时，去掉协议前缀；服务端始终只负责拼一次 Bearer。
  const apiKey = env.CONCH_API_KEY?.trim().replace(/^Bearer\s+/i, '');
  const model = env.CONCH_MODEL?.trim();
  if (!apiBase || !apiKey || !model) return null;
  const budget = Number(env.CONCH_THINKING_BUDGET ?? 0);
  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    apiKey,
    model,
    thinkingBudget: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0,
  };
}

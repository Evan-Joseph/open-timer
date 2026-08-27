/**
 * Legacy deployment-variable parser for the AI assistant (pure, Workers-safe).
 * CONCH_* names remain supported for backward-compatible environment setup.
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
  const apiBase = env.CONCH_API_BASE;
  const apiKey = env.CONCH_API_KEY;
  const model = env.CONCH_MODEL;
  if (!apiBase || !apiKey || !model) return null;
  const budget = Number(env.CONCH_THINKING_BUDGET ?? 0);
  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    apiKey,
    model,
    thinkingBudget: Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0,
  };
}

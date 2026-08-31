-- 神奇海螺的跨 Worker 缓存与协调状态。
-- 结果按“已完成时间线 revision + 模型 + 查询窗口”隔离；不缓存进行中的计时事实。
CREATE TABLE IF NOT EXISTS conch_response_cache (
  conch_revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('all', '30d', '7d')),
  payload_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (conch_revision, model, window)
);

-- 同一语义键只允许一个 Worker 调模型。租约自然过期，Worker 异常退出后可恢复。
CREATE TABLE IF NOT EXISTS conch_generation_lease (
  conch_revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  window TEXT NOT NULL CHECK (window IN ('all', '30d', '7d')),
  lease_token TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (conch_revision, model, window)
);

-- 只对实际会触发上游推理的请求计数，固定小时窗口可跨 Worker 实例保持一致。
CREATE TABLE IF NOT EXISTS conch_rate_window (
  window_start_ms INTEGER PRIMARY KEY,
  hit_count INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

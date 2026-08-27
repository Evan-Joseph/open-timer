-- sessionsOverlapping 索引：D1 按行读计费，原查询无可用索引导致全表扫描，
-- 历史会话约 250 条即撞穿免费档 500 万行读/天。加 (ended_at_ms) 索引，
-- 查询改写为「索引 range（ended_at_ms > 窗口起点）∪ 活动会话（部分索引，≤1 行）」。
CREATE INDEX IF NOT EXISTS session_ended ON session(ended_at_ms);

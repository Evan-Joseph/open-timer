-- 神奇海螺的“已完成时间线”专用 revision。
-- 与 audit revision 分离：开始/暂停/继续不会推进它；仅影响 LLM 输入的已完成
-- 专注事实（完成、备注、修正、撤回、重开）才推进，用于长期缓存失效判断。
CREATE TABLE IF NOT EXISTS conch_timeline_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO conch_timeline_state (id, revision) VALUES (1, 0);

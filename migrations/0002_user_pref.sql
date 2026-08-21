-- 用户 UI 偏好（多端同步）：单行 JSON 存储。
-- 键集合由客户端约定（theme/animations/finishSound/ambientKind/timelineScale/timelineMode/historyOpen），
-- 服务端只做整体存取与 updated_at 记录（last-write-wins）；ambientVolume 属设备本地，不同步。
CREATE TABLE IF NOT EXISTS user_pref (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  prefs_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

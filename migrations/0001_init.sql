-- 11408 沉浸时钟 · migration 0001
-- 纯 SQL，仅使用 SQLite 与 D1 的交集语法。所有时间为 UTC epoch ms（INTEGER）。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subject (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aggregate_group TEXT NOT NULL,
  color_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_credential (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS owner_session (
  token_sha TEXT PRIMARY KEY,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subject(id),
  status TEXT NOT NULL CHECK (status IN ('running','paused','stopped','voided')),
  intent_note TEXT,
  end_note TEXT,
  end_reason TEXT CHECK (end_reason IN ('manual','subject_switch','void')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

-- 同一用户同一时间最多一个活动会话（running 或 paused）
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session
  ON session(user_id) WHERE status IN ('running','paused');

CREATE INDEX IF NOT EXISTS session_started ON session(started_at_ms);

CREATE TABLE IF NOT EXISTS active_segment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS seg_session ON active_segment(session_id);

-- 每个会话最多一个开放段
CREATE UNIQUE INDEX IF NOT EXISTS one_open_segment
  ON active_segment(session_id) WHERE ended_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS session_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id),
  kind TEXT NOT NULL CHECK (kind IN ('created','paused','resumed','stopped','voided')),
  idempotency_key TEXT NOT NULL UNIQUE,
  server_time_ms INTEGER NOT NULL,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS manual_adjustment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES session(id),
  kind TEXT NOT NULL CHECK (kind IN ('retime','void','note')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  reason TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_credential (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'read_only',
  token_sha256 TEXT NOT NULL UNIQUE,
  revoked_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT,
  server_time_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_record (
  key TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

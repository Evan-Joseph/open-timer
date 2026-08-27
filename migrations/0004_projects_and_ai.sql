-- Projects are database-backed.  Archive instead of deleting so historic sessions remain valid.
ALTER TABLE subject ADD COLUMN archived_at_ms INTEGER;
CREATE INDEX IF NOT EXISTS subject_active_order ON subject(archived_at_ms, sort_order);

-- The API key is AES-GCM ciphertext; plaintext is never persisted or returned by the API.
CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL,
  api_base TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

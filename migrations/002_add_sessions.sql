CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  expired    INTEGER NOT NULL,
  sess       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions (expired);

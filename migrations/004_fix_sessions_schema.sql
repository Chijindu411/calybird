-- Fix sessions table: drop the old schema (wrong column 'expired' INTEGER)
-- and recreate it matching what better-sqlite3-session-store expects.
-- Sessions are ephemeral — dropping them causes no data loss worth preserving.
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  sid    TEXT NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TEXT NOT NULL
);

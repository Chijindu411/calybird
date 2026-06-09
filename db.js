import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = new Database("calybird.db");

// Keep the reminders table created directly — it predates the migration system.
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    date        TEXT    NOT NULL,
    time        TEXT    NOT NULL,
    completed   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);

// Migration tracking table.
db.exec(`
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   TEXT NOT NULL PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`);

const applied = new Set(
  db.prepare("SELECT filename FROM _migrations").all().map((r) => r.filename)
);

const migrationsDir = join(__dirname, "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  db.exec(readFileSync(join(migrationsDir, file), "utf8"));
  db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run(file);
  console.log(`Applied migration: ${file}`);
}

export default db;

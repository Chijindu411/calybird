import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "calybird.db"), { readonly: true });

// ── 1. Table names ──────────────────────────────────────────────────────────
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log("TABLES");
console.log("======");
for (const name of tables) {
  console.log(" •", name);
}
console.log();

// ── 2. Schema for every table ───────────────────────────────────────────────
for (const table of tables) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const nameWidth = Math.max(...cols.map((c) => c.name.length));
  const typeWidth = Math.max(...cols.map((c) => c.type.length));

  console.log(`SCHEMA: ${table}`);
  console.log("-".repeat(nameWidth + typeWidth + 20));
  for (const col of cols) {
    const flags = [];
    if (col.pk)                      flags.push("PK");
    if (col.notnull)                 flags.push("NOT NULL");
    if (col.dflt_value !== null)     flags.push(`DEFAULT ${col.dflt_value}`);
    console.log(
      `  ${col.name.padEnd(nameWidth)}  ${col.type.padEnd(typeWidth)}` +
      (flags.length ? `  ${flags.join(" | ")}` : "")
    );
  }
  console.log();
}

// ── 3. Sessions rows ────────────────────────────────────────────────────────
if (!tables.includes("sessions")) {
  console.log("sessions table does not exist yet.");
  db.close();
  process.exit(0);
}

const rows = db.prepare("SELECT * FROM sessions").all();
console.log(`SESSIONS (${rows.length} row${rows.length === 1 ? "" : "s"})`);
console.log("=".repeat(40));

if (rows.length === 0) {
  console.log("  (no rows — store is empty)");
} else {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // better-sqlite3-session-store stores `expired` as milliseconds since epoch
    const expiresAt = new Date(row.expired).toISOString();
    const isExpired = row.expired < Date.now();

    let sess;
    try {
      sess = JSON.parse(row.sess);
    } catch {
      sess = row.sess;
    }

    console.log(`\n  Row ${i + 1}:`);
    console.log(`    sid:     ${row.sid}`);
    console.log(`    expired: ${row.expired}  →  ${expiresAt}${isExpired ? "  *** EXPIRED ***" : ""}`);
    console.log(`    sess:    ${JSON.stringify(sess, null, 2).replace(/\n/g, "\n             ")}`);
  }
}
console.log();

db.close();

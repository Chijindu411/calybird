import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import bcrypt from "bcrypt";
import db from "./db.js";

const SALT_ROUNDS = 12;

const app = express();
app.use(express.json());
app.use(express.static("public"));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildDateTable(localDateISO) {
  const [y, m, d] = localDateISO.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  const DAY = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const fmt = (d) => [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  const add = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const dow = base.getDay();
  const tomorrow = add(base, 1);
  const dayAfter  = add(base, 2);
  const lines = [
    `- today (${DAY[dow]}): ${fmt(base)}`,
    `- tomorrow (${DAY[tomorrow.getDay()]}): ${fmt(tomorrow)}`,
    `- day after tomorrow (${DAY[dayAfter.getDay()]}): ${fmt(dayAfter)}`,
    ...DAY.map((name, i) => {
      const offset = (i - dow + 7) % 7 || 7; // "next X" when today IS X → 7 days, not 0
      return `- next ${name}: ${fmt(add(base, offset))}`;
    }),
  ];
  return { todayISO: fmt(base), table: lines.join("\n") };
}

app.post("/ask", async (req, res) => {
  const { message, localDate } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message field is required and must be a string" });
  }

  if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return res.status(400).json({ error: "localDate field is required (YYYY-MM-DD)" });
  }

  const { todayISO, table } = buildDateTable(localDate);

  const systemPrompt = `Today's date is ${todayISO}.

You are a reminder parser. Extract the reminder details from the user's message and respond ONLY with a JSON object in this exact format:
{"title":"...","date":"YYYY-MM-DD","time":"HH:MM"}

Reference date table (pre-calculated — use these values directly, do not calculate dates yourself):
${table}

Rules:
- "title": A short, clear label for the reminder.
- "date": The date in YYYY-MM-DD format. For relative phrases ("tomorrow", "next Tuesday", etc.) look them up in the reference table above. For "in N days", add N to today's date in the table. For a specific calendar date ("June 15"), use that date in the current or nearest future year.
- "time": The time in 24-hour HH:MM format. If no time is mentioned, default to "09:00".

Respond with ONLY the JSON object — no explanation, no markdown, no extra text.`;

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 256,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: message }],
  });

  const raw = response.content.find((block) => block.type === "text")?.text ?? "";

  // Slice out the first {...} block in case Claude adds surrounding prose or markdown fences.
  const match = raw.match(/\{[\s\S]*\}/);
  let reminder;
  try {
    reminder = JSON.parse(match ? match[0] : raw);
  } catch {
    return res.status(422).json({ error: "Could not parse reminder", raw });
  }

  const result = db.prepare(
    "INSERT INTO reminders (title, date, time) VALUES (?, ?, ?)"
  ).run(reminder.title, reminder.date, reminder.time);

  const saved = db.prepare("SELECT * FROM reminders WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(saved);
});

// POST /reminders — create a reminder
app.post("/reminders", (req, res) => {
  const { title, date, time } = req.body;

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required and must be a string" });
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
  }
  if (!time || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "time is required (HH:MM)" });
  }

  const stmt = db.prepare(
    "INSERT INTO reminders (title, date, time) VALUES (?, ?, ?)"
  );
  const result = stmt.run(title, date, time);
  const created = db.prepare("SELECT * FROM reminders WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(created);
});

// GET /reminders — list all reminders sorted by date then time
app.get("/reminders", (req, res) => {
  const reminders = db.prepare(
    "SELECT * FROM reminders ORDER BY date ASC, time ASC"
  ).all();
  res.json(reminders);
});

// PATCH /reminders/:id/complete — mark a reminder as complete
app.patch("/reminders/:id/complete", (req, res) => {
  const { id } = req.params;
  const result = db.prepare(
    "UPDATE reminders SET completed = 1 WHERE id = ?"
  ).run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Reminder not found" });
  }
  res.json(db.prepare("SELECT * FROM reminders WHERE id = ?").get(id));
});

// DELETE /reminders/:id — delete a reminder
app.delete("/reminders/:id", (req, res) => {
  const { id } = req.params;
  const result = db.prepare("DELETE FROM reminders WHERE id = ?").run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Reminder not found" });
  }
  res.status(204).send();
});

// POST /signup — create a new user account
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = db.prepare(
    "INSERT INTO users (email, password_hash) VALUES (?, ?)"
  ).run(email, password_hash);

  const user = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?")
    .get(result.lastInsertRowid);
  res.status(201).json(user);
});

// POST /login — verify credentials
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  // Use the same error message whether the email is unknown or the password is wrong,
  // to avoid leaking which emails are registered.
  if (!user) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  res.json({ id: user.id, email: user.email });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Calybird listening on port ${PORT}`));

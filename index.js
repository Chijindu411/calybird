import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import bcrypt from "bcrypt";
import session from "express-session";
import SqliteStoreFactory from "better-sqlite3-session-store";
import { addSeconds, format } from "date-fns";
import webpush from "web-push";
import db from "./db.js";

const SALT_ROUNDS = 12;
const SqliteStore = SqliteStoreFactory(session);

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(session({
  store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// All /reminders, /ask, and /push routes require a valid session.
app.use("/reminders", requireAuth);
app.use("/ask", requireAuth);
app.use("/push", requireAuth);

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

app.post("/ask", async (req, res, next) => {
  const { message, localDate } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message field is required and must be a string" });
  }

  if (!localDate || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    return res.status(400).json({ error: "localDate field is required (YYYY-MM-DD)" });
  }

  try {
    const { todayISO, table } = buildDateTable(localDate);

    const systemPrompt = `Today's date is ${todayISO}.

You are a reminder parser. Extract the reminder details from the user's message and respond ONLY with a JSON object using ONE of these two shapes:

Shape 1 — "absolute": for reminders tied to a specific calendar date and time of day.
{"title":"...","kind":"absolute","date":"YYYY-MM-DD","time":"HH:MM"}

Shape 2 — "relative": for reminders expressed as a duration from right now.
{"title":"...","kind":"relative","offset_seconds":<non-negative integer>}

Reference date table (pre-calculated — use these values directly, do not calculate dates yourself):
${table}

Rules:
- "title": A short, clear label for the reminder.

- Use "absolute" when the user mentions a day, weekday, or calendar date — e.g. "tomorrow", "next Tuesday", "on June 15th", "Friday at noon". Look up relative day phrases in the reference table above instead of calculating them yourself. For a calendar date with no year given, use the current or nearest future year. "date" is YYYY-MM-DD; "time" is 24-hour HH:MM, defaulting to "09:00" if no time is mentioned.
  Examples:
    "call the dentist tomorrow at 3pm" -> {"title":"Call the dentist","kind":"absolute","date":"<tomorrow from table>","time":"15:00"}
    "pay rent on the 1st" -> {"title":"Pay rent","kind":"absolute","date":"<1st of current/next month>","time":"09:00"}
    "team meeting next Tuesday at 10" -> {"title":"Team meeting","kind":"absolute","date":"<next Tuesday from table>","time":"10:00"}

- Use "relative" when the user specifies a duration from now rather than a date — e.g. "in 5 minutes", "in 2 hours", "in 30 seconds", "right now", "in half an hour". Convert the duration to a non-negative integer number of seconds. Do not compute a date or time of day yourself — the backend handles that.
  Examples:
    "check the oven in 20 minutes" -> {"title":"Check the oven","kind":"relative","offset_seconds":1200}
    "remind me in 2 hours to take a break" -> {"title":"Take a break","kind":"relative","offset_seconds":7200}
    "remind me right now to drink water" -> {"title":"Drink water","kind":"relative","offset_seconds":0}
    "in half an hour, water the plants" -> {"title":"Water the plants","kind":"relative","offset_seconds":1800}
    "in 30 seconds tell me the timer is up" -> {"title":"Timer is up","kind":"relative","offset_seconds":30}

- Include only the fields belonging to the chosen shape. Never include "date" or "time" alongside "offset_seconds", and never include "offset_seconds" alongside "date"/"time".

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

    let date, time;

    if (reminder.kind === "absolute") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reminder.date) || !/^\d{2}:\d{2}$/.test(reminder.time)) {
        return res.status(422).json({ error: "Could not parse reminder", raw });
      }
      date = reminder.date;
      time = reminder.time;
    } else if (reminder.kind === "relative") {
      if (!Number.isInteger(reminder.offset_seconds) || reminder.offset_seconds < 0) {
        return res.status(422).json({ error: "Could not parse reminder", raw });
      }
      // addSeconds + format both operate in the server's local timezone,
      // unlike toISOString() which converts to UTC and can shift the date.
      const target = addSeconds(new Date(), reminder.offset_seconds);
      date = format(target, "yyyy-MM-dd");
      time = format(target, "HH:mm");
    } else {
      return res.status(422).json({ error: "Could not parse reminder", raw });
    }

    const result = db.prepare(
      "INSERT INTO reminders (title, date, time, user_id) VALUES (?, ?, ?, ?)"
    ).run(reminder.title, date, time, req.session.userId);

    const saved = db.prepare("SELECT * FROM reminders WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
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
    "INSERT INTO reminders (title, date, time, user_id) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(title, date, time, req.session.userId);
  const created = db.prepare("SELECT * FROM reminders WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json(created);
});

// GET /reminders — list all reminders sorted by date then time
app.get("/reminders", (req, res) => {
  const reminders = db.prepare(
    "SELECT * FROM reminders WHERE user_id = ? ORDER BY date ASC, time ASC"
  ).all(req.session.userId);
  res.json(reminders);
});

// PATCH /reminders/:id/complete — mark a reminder as complete
app.patch("/reminders/:id/complete", (req, res) => {
  const { id } = req.params;
  const result = db.prepare(
    "UPDATE reminders SET completed = 1 WHERE id = ? AND user_id = ?"
  ).run(id, req.session.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Reminder not found" });
  }
  res.json(db.prepare("SELECT * FROM reminders WHERE id = ? AND user_id = ?").get(id, req.session.userId));
});

// DELETE /reminders/:id — delete a reminder
app.delete("/reminders/:id", (req, res) => {
  const { id } = req.params;
  const result = db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(id, req.session.userId);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Reminder not found" });
  }
  res.status(204).send();
});

// POST /signup — create a new user account
app.post("/signup", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  try {
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
  } catch (err) {
    next(err);
  }
});

// POST /login — verify credentials
app.post("/login", async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
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

    req.session.userId = user.id;
    res.json({ id: user.id, email: user.email });
  } catch (err) {
    next(err);
  }
});

// POST /logout — destroy the session
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Could not log out" });
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out" });
  });
});

// GET /me — return the logged-in user, or 401 if no valid session
app.get("/me", (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json(user);
});

// GET /push/vapid-public-key — the public key the frontend needs to subscribe
app.get("/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /push/subscribe — store a push subscription for the logged-in user
app.post("/push/subscribe", (req, res) => {
  const { subscription } = req.body;

  if (
    !subscription ||
    typeof subscription.endpoint !== "string" ||
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string"
  ) {
    return res.status(400).json({ error: "A valid push subscription is required" });
  }

  db.prepare(
    "INSERT OR IGNORE INTO push_subscriptions (user_id, subscription) VALUES (?, ?)"
  ).run(req.session.userId, JSON.stringify(subscription));

  res.status(201).json({ message: "Subscribed" });
});

// 404 — no route matched
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler — catches sync throws forwarded by Express and next(err) calls
// The four-parameter signature is required for Express to treat this as an error handler.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Calybird listening on port ${PORT}`));

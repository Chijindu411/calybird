import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import db from "./db.js";

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

  res.json(reminder);
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Calybird listening on port ${PORT}`));

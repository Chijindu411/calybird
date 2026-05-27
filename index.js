import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post("/ask", async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message field is required and must be a string" });
  }

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: [
      {
        type: "text",
        text: "You are a helpful assistant.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: message }],
  });

  const reply = response.content.find((block) => block.type === "text")?.text ?? "";
  res.json({ reply });
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Calybird listening on port ${PORT}`));

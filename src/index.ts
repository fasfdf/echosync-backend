/**
 * EchoSync demo backend — temporary cloud validation layer.
 * Single hardcoded profile ("Mia"), no auth. The production app will run
 * on-device (SwiftUI + Core ML); don't over-build this.
 */
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { pool, initDb } from "./db";
import { messageOptionsSchema, eventSchema } from "./validation";
import { generateMessageOptions } from "./messageOptions";

const app = express();

// CORS: only the frontend origin (Lovable app) is allowed.
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: CORS_ORIGIN }));

app.use(express.json({ limit: "50kb" }));

// --- GET /api/health ------------------------------------------------------
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

// --- POST /api/message-options --------------------------------------------
app.post("/api/message-options", async (req: Request, res: Response) => {
  const parsed = messageOptionsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
  }
  const { selectedWords, forceFail } = parsed.data;
  const result = await generateMessageOptions(selectedWords, forceFail === true);
  res.json(result);
});

// --- POST /api/events -------------------------------------------------------
app.post("/api/events", async (req: Request, res: Response) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`),
    });
  }
  const e = parsed.data;
  const { rows } = await pool.query(
    `INSERT INTO communication_events
       (selected_words, selected_message, selected_tone, source, message_started_at, spoken_at)
     VALUES ($1::jsonb, $2, $3, $4, $5::timestamptz, $6::timestamptz)
     RETURNING *`,
    [
      JSON.stringify(e.selected_words),
      e.selected_message,
      e.selected_tone,
      e.source,
      e.message_started_at,
      e.spoken_at,
    ]
  );
  res.status(201).json(rows[0]);
});

// --- GET /api/events --------------------------------------------------------
app.get("/api/events", async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT * FROM communication_events ORDER BY created_at DESC, id DESC`
  );
  res.json(rows);
});

// --- GET /api/events/summary -----------------------------------------------
app.get("/api/events/summary", async (_req: Request, res: Response) => {
  const [countsResult, medianResult, topWordsResult] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE source = 'ai')::int AS ai_count
       FROM communication_events`
    ),
    pool.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (spoken_at - message_started_at))
              ) AS median_seconds
       FROM communication_events`
    ),
    pool.query(
      `SELECT lower(word.value) AS word, count(*)::int AS uses
       FROM communication_events,
            jsonb_array_elements_text(selected_words) AS word(value)
       GROUP BY lower(word.value)
       ORDER BY uses DESC, word ASC
       LIMIT 3`
    ),
  ]);

  const { total, ai_count } = countsResult.rows[0];
  const medianRaw = medianResult.rows[0].median_seconds;

  res.json({
    total,
    ai_choice_rate: total > 0 ? Math.round((ai_count / total) * 1000) / 10 : 0,
    median_response_seconds:
      medianRaw === null ? null : Math.round(Number(medianRaw) * 10) / 10,
    top_words: topWordsResult.rows.map((r: { word: string }) => r.word),
  });
});

// --- 404 + error handling ---------------------------------------------------
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Malformed JSON bodies land here from express.json()
  if (err instanceof SyntaxError && "body" in (err as object)) {
    return res.status(400).json({ error: "Malformed JSON body" });
  }
  console.error("Unhandled error:", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: "Internal server error" });
});

const PORT = Number(process.env.PORT) || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`EchoSync backend listening on port ${PORT} (CORS origin: ${CORS_ORIGIN})`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err instanceof Error ? err.message : err);
    process.exit(1);
  });

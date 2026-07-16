# EchoSync Backend (demo)

REST API for the EchoSync AAC communication demo. Single hardcoded demo profile ("Mia"), no auth.

> **Scope note:** this is a temporary cloud validation layer. The production EchoSync app will be a native SwiftUI iPad app running the model on-device via Core ML, with no server round-trip. Don't over-invest here.

**Stack:** Node.js 20+, Express 5, TypeScript, PostgreSQL, Groq (`llama-3.3-70b-versatile`).

## Environment variables

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq API key. Never logged or returned in any response. |
| `CORS_ORIGIN` | The one allowed frontend origin. Placeholder: `http://localhost:5173` — **update to the Lovable app's domain once the frontend is live.** |
| `DATABASE_URL` | Postgres connection string. Append `?sslmode=require` for managed/external Postgres. |
| `PORT` | Optional, defaults to `3000`. Render sets this automatically. |

## Run locally

Requires Node 20+ and a Postgres you can reach. Two options:

**Option A — your own Postgres:** create a database and point `DATABASE_URL` at it.

**Option B — embedded Postgres (no install needed):**

```bash
npm install
node scripts/local-pg.mjs &   # user-space Postgres on port 5433, data in /tmp/echosync-pg
```

Then:

```bash
cp .env.example .env          # fill in GROQ_API_KEY
export $(grep -v '^#' .env | xargs)
npm run dev                   # or: npm run build && npm start
```

The table is created automatically at startup (`CREATE TABLE IF NOT EXISTS`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check → `{ "status": "ok" }` |
| POST | `/api/message-options` | Generate 3 sentence options from selected words |
| POST | `/api/events` | Record one spoken message (called only after Speak) |
| GET | `/api/events` | All events, newest first |
| GET | `/api/events/summary` | Caregiver stats: total, ai_choice_rate (%), median_response_seconds, top_words |

### POST /api/message-options

```bash
curl -X POST $BASE/api/message-options \
  -H 'Content-Type: application/json' \
  -d '{"selectedWords":["mommy","park","swing"]}'
# → { "options": [ { "text": "...", "confidence": "high" }, x3 ], "source": "ai" }
```

On any Groq failure (network, HTTP error, invalid/malformed JSON, missing key) the endpoint returns three deterministic options built only from `selectedWords`, with `"source": "fallback"`. It never 500s because AI generation failed.

**Testing the fallback with `forceFail`** (debug-only flag — the frontend never sends it):

```bash
curl -X POST $BASE/api/message-options \
  -H 'Content-Type: application/json' \
  -d '{"selectedWords":["juice","cold"],"forceFail":true}'
# → { "options": [...3 deterministic options...], "source": "fallback" }
```

### POST /api/events

```bash
curl -X POST $BASE/api/events -H 'Content-Type: application/json' -d '{
  "selected_words": ["mommy","park","swing"],
  "selected_message": "I want to go to the park with mommy.",
  "selected_tone": "excited",
  "source": "ai",
  "message_started_at": "2026-07-16T10:00:00Z",
  "spoken_at": "2026-07-16T10:00:06Z"
}'
```

`selected_tone` must be one of `neutral | excited | asking | upset`; `source` one of `ai | literal | fallback`. All fields required; malformed input → `400` with details.

## Deployment (Render)

`render.yaml` is a Render Blueprint defining the web service + free Postgres. Steps:

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. Render creates the service and database and wires `DATABASE_URL`.
3. Set `GROQ_API_KEY` in the service's Environment tab (it is deliberately not in the blueprint).
4. Update `CORS_ORIGIN` to the Lovable app's domain when it's live.

**Deployed URL:** _(fill in after deploy — e.g. `https://echosync-backend.onrender.com`)_

Note: Render's free tier spins down after ~15 min idle; the first request after that takes ~30–60 s. Fine for a demo.

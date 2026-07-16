import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

export const pool = new Pool({
  connectionString,
  // Render's managed Postgres requires SSL from external hosts; internal and
  // local connections don't. Enable SSL only when the URL asks for it.
  ssl: /sslmode=require/.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
});

/**
 * Minimal bootstrap "migration" — deliberately simple. This backend is a
 * temporary validation layer for the EchoSync demo, so we just ensure the
 * one table exists at startup rather than pulling in a migration framework.
 */
export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS communication_events (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at         timestamptz NOT NULL DEFAULT now(),
      selected_words     jsonb NOT NULL,
      selected_message   text NOT NULL,
      selected_tone      text NOT NULL CHECK (selected_tone IN ('neutral','excited','asking','upset')),
      source             text NOT NULL CHECK (source IN ('ai','literal','fallback')),
      message_started_at timestamptz NOT NULL,
      spoken_at          timestamptz NOT NULL
    );
  `);
}

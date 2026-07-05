// Apply the live-chat schema (chat_conversations + chat_messages) to the live
// Supabase DB. ADDITIVE ONLY — never db:push (prod schema drift).
// Usage: npx tsx --env-file=.env script/apply-live-chat-schema.ts
import { readFileSync } from "fs";
import pg from "pg";

const sql = readFileSync("migrations/2026-07-05_live_chat.sql", "utf8");

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    const check = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN ('chat_conversations','chat_messages') ORDER BY table_name`,
    );
    console.log("Tables present:", check.rows.map((r) => r.table_name).join(", "));
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => { console.log("✓ live-chat schema applied"); process.exit(0); })
  .catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });

// Additive migration: Content Calendar / Media Production System
// (content_items + content_sessions + content_tasks) for the USG workspace.
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-content-calendar-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-06_content_calendar.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const items = await pool.query("SELECT count(*)::int AS n FROM content_items");
  const sessions = await pool.query("SELECT count(*)::int AS n FROM content_sessions");
  const tasks = await pool.query("SELECT count(*)::int AS n FROM content_tasks");
  console.log(`✅ Content Calendar applied. content_items=${items.rows[0].n}, content_sessions=${sessions.rows[0].n}, content_tasks=${tasks.rows[0].n}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

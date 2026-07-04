// Additive migration: Proposal Tracker (proposals + proposal_categories +
// proposal_events) with a seeded starter category set for United Sports Group.
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-proposals-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-05_proposals.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const props = await pool.query("SELECT count(*)::int AS n FROM proposals");
  const cats = await pool.query("SELECT count(*)::int AS n FROM proposal_categories");
  const events = await pool.query("SELECT count(*)::int AS n FROM proposal_events");
  console.log(`✅ Proposals applied. proposals=${props.rows[0].n}, categories=${cats.rows[0].n}, events=${events.rows[0].n}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

// Additive migration: Sponsor Traffic (sponsors + sponsor_link_events).
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-sponsor-traffic-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-12_sponsor_traffic.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const sponsorsCount = await pool.query("SELECT count(*)::int AS n FROM sponsors");
  const eventsCount = await pool.query("SELECT count(*)::int AS n FROM sponsor_link_events");
  console.log(`✅ Sponsor Traffic schema applied. sponsors=${sponsorsCount.rows[0].n}, sponsor_link_events=${eventsCount.rows[0].n}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

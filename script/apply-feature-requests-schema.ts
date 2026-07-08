// Additive migration: staff Feedback board (feature_requests table).
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-feature-requests-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-09_feature_requests.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const n = await pool.query("SELECT count(*)::int AS n FROM feature_requests");
  const cols = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'feature_requests' ORDER BY ordinal_position",
  );
  console.log(`✅ Feedback board applied. feature_requests rows=${n.rows[0].n}, columns=${cols.rows.map((r) => r.column_name).join(", ")}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

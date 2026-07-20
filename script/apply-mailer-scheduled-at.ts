// Additive migration: email_campaigns.scheduled_at (+ partial index) for
// scheduled mailer sends. Idempotent — safe to re-run. Additive only (no drops)
// per the prod-DB-drift rule. Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-mailer-scheduled-at.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-20_mailer-scheduled-at.sql"), "utf8");

(async () => {
  await pool.query(SQL);

  const { rows } = await pool.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'email_campaigns' AND column_name = 'scheduled_at'",
  );
  if (rows.length === 0) throw new Error("scheduled_at not found after migration");
  console.log(`  ✓ email_campaigns.scheduled_at — ${rows[0].data_type}`);

  const { rows: idx } = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'email_campaigns' AND indexname = 'idx_email_campaigns_scheduled'",
  );
  console.log(`  ✓ index: ${idx.map((r) => r.indexname).join(", ") || "(missing!)"}`);

  console.log("✅ Mailer scheduled_at migration applied.");
  await pool.end();
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

// Additive migration: Global Search — enable pg_trgm + GIN trigram indexes for
// fuzzy, typo-tolerant search across ClubOS. Idempotent, additive only (an
// extension + IF NOT EXISTS indexes — no table/column/row changes).
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-global-search-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-05_global_search.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const ext = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
  const idx = await pool.query("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname LIKE 'trgm_%'");
  console.log(`✅ Global search applied. pg_trgm=${ext.rowCount ? "enabled" : "MISSING"}, trigram_indexes=${idx.rows[0].n}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

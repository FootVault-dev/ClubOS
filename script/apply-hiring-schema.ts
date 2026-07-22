// Additive migration: the Hiring module (hiring_jobs + hiring_applications).
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift
// rule. Run BEFORE deploying: the running app never sees these tables until the
// deploy lands, and the deploy would 500 if the tables weren't there first.
//
// Usage: npx tsx --env-file=.env script/apply-hiring-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-10_hiring.sql"), "utf8");

const TABLES = ["hiring_jobs", "hiring_applications"];

(async () => {
  await pool.query(SQL);

  for (const table of TABLES) {
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
      [table],
    );
    if (rows.length === 0) throw new Error(`${table} not found after migration`);
    const { rows: count } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    console.log(`  ✓ ${table} — ${rows.length} columns, ${count[0].n} rows`);
  }

  // The unique indexes are the load-bearing bit: brand+slug makes the public
  // lookup unambiguous, job+email stops a double-submit becoming two applicants.
  const { rows: idx } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = ANY($1) ORDER BY indexname`,
    [TABLES],
  );
  console.log(`  ✓ indexes: ${idx.map((r) => r.indexname).join(", ")}`);

  console.log("✅ Hiring schema applied.");
  await pool.end();
})().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

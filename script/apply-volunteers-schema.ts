// One-off migration for the Volunteers module (reusable across workspaces).
// Purely additive — CREATE TABLE / INDEX IF NOT EXISTS only, wrapped in a single
// transaction so any failure rolls everything back. Safe against the drifted
// prod DB (never alters existing columns).
//
// Usage: npx tsx --env-file=.env script/apply-volunteers-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-06_volunteers.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying Volunteers migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");
    for (const t of ["volunteers", "volunteer_task_types", "volunteer_assignments"]) {
      const check = await client.query(`SELECT to_regclass('public.${t}') AS t`);
      if (!check.rows[0]?.t) throw new Error(`${t} table not found after migration`);
      console.log(`  ✓ ${t}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});

// Additive migration: Work Management Phase 2 — event Playbooks (task_templates
// + task_template_items) with backward planning, plus 3 seeded starter
// playbooks for United Sports Group.
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-work-playbooks-schema.ts

import { Pool } from "pg";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(__dirname, "..", "migrations", "2026-07-05_work_management_playbooks.sql"), "utf8");

(async () => {
  await pool.query(SQL);
  const tpl = await pool.query("SELECT count(*)::int AS n FROM task_templates");
  const items = await pool.query("SELECT count(*)::int AS n FROM task_template_items");
  console.log(`✅ Playbooks applied. task_templates=${tpl.rows[0].n}, task_template_items=${items.rows[0].n}`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

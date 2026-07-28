// Applies migrations/2026-07-28_warehouse_form_layout.sql — the item form
// becomes data (D26). Dry-run by default; --apply commits.
//
//   npx tsx --env-file=.env script/apply-warehouse-form.ts
//   npx tsx --env-file=.env script/apply-warehouse-form.ts --apply
//
// The assertions that matter: the two new columns exist, category became
// nullable (a core-field placement has no category), the core/mode uniqueness
// holds, the category+key index became PARTIAL (it only applies to custom
// fields now), and NOTHING existing changed — this runs against a live
// warehouse.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-28_warehouse_form_layout.sql"), "utf8");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const one = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows[0];

try {
  await pool.query("BEGIN");
  const before = await one(`SELECT
    (SELECT count(*)::int FROM wh_field_templates) templates,
    (SELECT count(*)::int FROM wh_item_fields) values_,
    (SELECT count(*)::int FROM wh_items) items`);
  console.log("live before:", JSON.stringify(before), "\n");

  await pool.query(sql);
  let bad = 0;
  const check = (ok: boolean, label: string) => { if (!ok) bad++; console.log(`${ok ? "  ok " : " MISS"}  ${label}`); };

  for (const col of ["core_field", "tracking_mode"]) {
    const r = await one(`SELECT 1 FROM information_schema.columns
      WHERE table_name='wh_field_templates' AND column_name=$1`, [col]);
    check(!!r, `column wh_field_templates.${col}`);
  }

  const cat = await one(`SELECT is_nullable FROM information_schema.columns
    WHERE table_name='wh_field_templates' AND column_name='category'`);
  check(cat?.is_nullable === "YES", "category is now nullable (core placements have none)");

  for (const idx of ["wh_field_templates_core_mode_unique", "wh_field_templates_mode_sort_idx"]) {
    const r = await one(`SELECT 1 FROM pg_indexes WHERE indexname=$1`, [idx]);
    check(!!r, `index ${idx}`);
  }

  const partial = await one(`SELECT indexdef FROM pg_indexes WHERE indexname='wh_field_templates_category_key_unique'`);
  check(!!partial && /WHERE/i.test(partial.indexdef), "category+key unique is PARTIAL (custom fields only)");

  const after = await one(`SELECT
    (SELECT count(*)::int FROM wh_field_templates) templates,
    (SELECT count(*)::int FROM wh_item_fields) values_,
    (SELECT count(*)::int FROM wh_items) items`);
  const additive = JSON.stringify(before) === JSON.stringify(after);
  check(additive, `additive — ${JSON.stringify(after)}`);

  const stray = await one(`SELECT count(*)::int n FROM wh_field_templates WHERE core_field IS NOT NULL`);
  check(Number(stray.n) === 0, "no layout rows written (the default form still applies)");

  if (bad > 0) { console.error(`\n${bad} check(s) failed — DO NOT DEPLOY.`); await pool.query("ROLLBACK"); process.exit(1); }

  if (APPLY) { await pool.query("COMMIT"); console.log("\n✅ --apply passed — migration COMMITTED."); }
  else { await pool.query("ROLLBACK"); console.log("\n✅ Dry run passed — rolled back, nothing written."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}

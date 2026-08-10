// Apply the warehouse models migration (D32-D35). ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-warehouse-models.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-warehouse-models.ts
//
// `--dry-run` runs the whole migration and every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this proves
// the SQL parses, the shop_products and wh_items foreign keys resolve, and the
// partial indexes build — while changing nothing. There is no local Postgres to
// rehearse against, and a typo found during the real run is a typo found with
// the deploy already half-done.
//
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-10_warehouse_models.sql"), "utf8");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
let failures = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok " : " FAIL"}  ${label}`);
};

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");

  // Snapshot BEFORE. The whole claim of this migration is that it changes
  // nothing about the existing rows; that is worth proving, not asserting.
  const before = await pool.query(`
    SELECT (SELECT count(*) FROM wh_items)     AS items,
           (SELECT count(*) FROM wh_stock)     AS stock,
           (SELECT count(*) FROM wh_movements) AS movements`);

  await pool.query(sql);
  // Verification runs INSIDE the transaction, so a dry run checks the objects
  // it just built before throwing them away.

  const reg = await pool.query("SELECT to_regclass('wh_models') AS t");
  check(reg.rows[0].t !== null, "table wh_models");

  for (const col of ["vendor", "title", "vendor_model", "sku", "notes", "image_url", "shop_product_id", "active"]) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'wh_models' AND column_name = $1", [col]);
    check(r.rows.length > 0, `wh_models.${col}`);
  }
  for (const col of ["model_id", "rack_code"]) {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'wh_items' AND column_name = $1", [col]);
    check(r.rows.length > 0, `wh_items.${col}`);
  }
  for (const idx of [
    "wh_models_shop_product_unique",
    "wh_models_vendor_title_idx",
    "wh_models_active_idx",
    "wh_items_model_idx",
    "wh_items_rack_code_idx",
  ]) {
    const r = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    check(r.rows.length > 0, `index ${idx}`);
  }

  // D32/D33 — the load-bearing invariants, proven rather than trusted.

  // model_id must be NULLABLE. If it came out NOT NULL, every existing item
  // row would be invalid and the module would break on the next write.
  const nullable = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'wh_items' AND column_name = 'model_id'`);
  check(nullable.rows[0]?.is_nullable === "YES", "wh_items.model_id is nullable (D33)");

  // ON DELETE SET NULL, not CASCADE. A CASCADE here would mean deleting a
  // model deletes every variant under it — and with them their ledger.
  const fk = await pool.query(`
    SELECT confdeltype FROM pg_constraint
     WHERE conrelid = 'wh_items'::regclass
       AND contype = 'f'
       AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'wh_items'::regclass AND attname = 'model_id')]::smallint[]`);
  check(fk.rows[0]?.confdeltype === "n", "wh_items.model_id is ON DELETE SET NULL, not CASCADE (D33)");

  // The shop-product uniqueness must be PARTIAL. A plain unique index would
  // allow exactly ONE hand-typed model in the whole catalogue (they all carry
  // a NULL shop_product_id) — which would look like a bug in the app.
  const partial = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'wh_models_shop_product_unique'");
  check(/ WHERE /i.test(partial.rows[0]?.indexdef ?? ""), "wh_models_shop_product_unique is partial (D32)");

  // RLS on, per the standing rule for every new table.
  const rls = await pool.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'wh_models'");
  check(rls.rows[0]?.relrowsecurity === true, "wh_models has RLS enabled");

  // Nothing existing moved.
  const after = await pool.query(`
    SELECT (SELECT count(*) FROM wh_items)     AS items,
           (SELECT count(*) FROM wh_stock)     AS stock,
           (SELECT count(*) FROM wh_movements) AS movements`);
  const same = ["items", "stock", "movements"].every((k) => before.rows[0][k] === after.rows[0][k]);
  check(same, `existing rows untouched (items ${before.rows[0].items}, stock ${before.rows[0].stock}, movements ${before.rows[0].movements})`);

  // Every existing item must still be readable with the new column in place.
  const readback = await pool.query(
    "SELECT count(*) AS n FROM wh_items WHERE model_id IS NULL AND rack_code IS NULL");
  check(readback.rows[0].n === after.rows[0].items,
    `all ${after.rows[0].items} items valid with model_id/rack_code unset`);

  if (failures) {
    console.log(`\n${failures} check(s) FAILED — rolling back.\n`);
    await pool.query("ROLLBACK");
    process.exit(1);
  }

  if (DRY_RUN) {
    await pool.query("ROLLBACK");
    console.log("\nAll checks passed. ROLLED BACK — nothing was changed.\n");
  } else {
    await pool.query("COMMIT");
    console.log("\nAll checks passed. COMMITTED.\n");
    console.log("Next: npx tsx --env-file=.env script/backfill-warehouse-models.ts --dry-run\n");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back.\n", e);
  process.exit(1);
} finally {
  await pool.end();
}

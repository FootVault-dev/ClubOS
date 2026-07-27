// Applies migrations/2026-07-27_warehouse_v2.sql — asset tracking, custom
// fields, richer locations (D18–D25).
//
// Dry-run by default — BEGIN, run the migration, verify every new table,
// column, index (asserting partial ones actually carry a WHERE clause) and
// CHECK, prove the additive promise against the LIVE data, then ROLLBACK so
// nothing is written. Pass --apply to COMMIT for real.
//
//   npx tsx --env-file=.env script/apply-warehouse-v2.ts            (dry-run)
//   npx tsx --env-file=.env script/apply-warehouse-v2.ts --apply    (commits)
//
// The additive assertions are the point: this migration runs against a warehouse
// that is already live with ~2,900 mapped items and a real ledger. It must not
// change a single existing row. Both are checked before/after, in-transaction.

import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-27_warehouse_v2.sql"), "utf8");

const EXPECTED_TABLES = ["wh_item_instances", "wh_field_templates", "wh_item_fields"];

const EXPECTED_COLUMNS: Array<{ table: string; column: string; notNull: boolean; def: string | null }> = [
  { table: "wh_items", column: "tracking_mode", notNull: true, def: "'stock'::text" },
  { table: "wh_locations", column: "parent_location_id", notNull: false, def: null },
  { table: "wh_movements", column: "instance_id", notNull: false, def: null },
];

const EXPECTED_INDEXES: Array<{ name: string; partial: boolean }> = [
  { name: "wh_items_tracking_mode_idx", partial: false },
  { name: "wh_locations_parent_idx", partial: false },
  { name: "wh_item_instances_asset_tag_unique", partial: true },
  { name: "wh_item_instances_item_serial_unique", partial: true },
  { name: "wh_item_instances_item_condition_idx", partial: false },
  { name: "wh_item_instances_location_idx", partial: false },
  { name: "wh_item_instances_warranty_idx", partial: true },
  { name: "wh_movements_instance_idx", partial: true },
  { name: "wh_field_templates_category_key_unique", partial: false },
  { name: "wh_field_templates_category_sort_idx", partial: false },
  { name: "wh_item_fields_item_key_unique", partial: true },
  { name: "wh_item_fields_instance_key_unique", partial: true },
  { name: "wh_item_fields_key_date_idx", partial: true },
  { name: "wh_item_fields_key_number_idx", partial: true },
];

// FKs that MUST be RESTRICT, not CASCADE — deleting an item definition or an
// instance must never silently erase the history of a real physical object.
const EXPECTED_RESTRICT_FKS = [
  { table: "wh_item_instances", column: "item_id" },
  { table: "wh_item_instances", column: "location_id" },
  { table: "wh_movements", column: "instance_id" },
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (this script only ever runs against a real DB, by a human, later).");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const count = async (q: string): Promise<number> => Number((await pool.query(q)).rows[0].n);

try {
  await pool.query("BEGIN");

  // ── Before: the live shape we promise not to disturb ──────────────────────
  const beforeItems = await count("SELECT count(*)::int AS n FROM wh_items");
  const beforeMovements = await count("SELECT count(*)::int AS n FROM wh_movements");
  const beforeStock = await count("SELECT count(*)::int AS n FROM wh_stock");
  const beforeLedgerSum = (await pool.query("SELECT coalesce(sum(delta),0)::text AS s FROM wh_movements")).rows[0].s;
  console.log(
    `live before: ${beforeItems} items · ${beforeMovements} movements · ${beforeStock} stock rows · ledger sum ${beforeLedgerSum}\n`,
  );

  await pool.query(sql);

  let missing = 0;

  for (const table of EXPECTED_TABLES) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [`public.${table}`]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${table}`);
  }

  for (const { table, column, notNull, def } of EXPECTED_COLUMNS) {
    const r = await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column],
    );
    if (r.rows.length === 0) {
      missing++;
      console.log(` MISS  column ${table}.${column}`);
      continue;
    }
    const isNotNull = r.rows[0].is_nullable === "NO";
    const actualDef: string | null = r.rows[0].column_default;
    if (isNotNull !== notNull) {
      missing++;
      console.log(` MISS  column ${table}.${column} — expected ${notNull ? "NOT NULL" : "nullable"}, got the opposite`);
      continue;
    }
    // A NOT NULL column added to a populated table is only safe WITH a default.
    if (notNull && def && actualDef !== def) {
      missing++;
      console.log(` MISS  column ${table}.${column} — expected default ${def}, got ${actualDef}`);
      continue;
    }
    console.log(`  ok   column ${table}.${column}${def ? ` (default ${def})` : ""}`);
  }

  for (const { name, partial } of EXPECTED_INDEXES) {
    const r = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = $1", [name]);
    if (r.rows.length === 0) {
      missing++;
      console.log(` MISS  index ${name}`);
      continue;
    }
    const indexdef: string = r.rows[0].indexdef;
    const hasWhere = /\bWHERE\b/i.test(indexdef);
    if (partial !== hasWhere) {
      missing++;
      console.log(` MISS  index ${name} (expected ${partial ? "a partial index WITH" : "a plain index with NO"} WHERE, got: ${indexdef})`);
      continue;
    }
    console.log(`  ok   index ${name}${partial ? " (partial, verified WHERE present)" : ""}`);
  }

  // The structural CHECK — exactly one owner per custom-field value (D22).
  const chk = await pool.query("SELECT 1 FROM pg_constraint WHERE conname = $1", ["wh_item_fields_one_owner_chk"]);
  const chkOk = chk.rows.length > 0;
  if (!chkOk) missing++;
  console.log(`${chkOk ? "  ok " : " MISS"}  constraint wh_item_fields_one_owner_chk`);

  for (const { table, column } of EXPECTED_RESTRICT_FKS) {
    const r = await pool.query(
      `SELECT c.confdeltype FROM pg_constraint c
         JOIN pg_class t   ON t.oid = c.conrelid
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE c.contype='f' AND t.relname=$1 AND a.attname=$2`,
      [table, column],
    );
    // 'r' = RESTRICT, 'a' = NO ACTION (also refuses the delete), 'c' = CASCADE.
    const ok = r.rows.length > 0 && (r.rows[0].confdeltype === "r" || r.rows[0].confdeltype === "a");
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  FK ${table}.${column} refuses deletes (confdeltype=${r.rows[0]?.confdeltype ?? "none"})`);
  }

  // ── After: prove it was additive ──────────────────────────────────────────
  const afterItems = await count("SELECT count(*)::int AS n FROM wh_items");
  const afterMovements = await count("SELECT count(*)::int AS n FROM wh_movements");
  const afterStock = await count("SELECT count(*)::int AS n FROM wh_stock");
  const afterLedgerSum = (await pool.query("SELECT coalesce(sum(delta),0)::text AS s FROM wh_movements")).rows[0].s;
  const strayMode = await count("SELECT count(*)::int AS n FROM wh_items WHERE tracking_mode <> 'stock'");

  const additive =
    afterItems === beforeItems &&
    afterMovements === beforeMovements &&
    afterStock === beforeStock &&
    afterLedgerSum === beforeLedgerSum &&
    strayMode === 0;

  if (!additive) missing++;
  console.log(
    `${additive ? "  ok " : " MISS"}  additive — ${afterItems} items · ${afterMovements} movements · ` +
      `${afterStock} stock rows · ledger sum ${afterLedgerSum} · ${strayMode} item(s) off default tracking_mode`,
  );

  if (missing > 0) {
    console.error(`\n${missing} check(s) failed after migration — DO NOT DEPLOY.`);
    await pool.query("ROLLBACK");
    process.exit(1);
  }

  console.log(
    `\nAll ${EXPECTED_TABLES.length} tables + ${EXPECTED_COLUMNS.length} columns + ` +
      `${EXPECTED_INDEXES.length} indexes + 1 CHECK + ${EXPECTED_RESTRICT_FKS.length} restrict-FKs present, and nothing existing changed.`,
  );

  if (APPLY) {
    await pool.query("COMMIT");
    console.log("✅ --apply passed — migration COMMITTED.");
  } else {
    await pool.query("ROLLBACK");
    console.log("✅ Dry run passed — rolled back, nothing written. Re-run with --apply to commit for real.");
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}

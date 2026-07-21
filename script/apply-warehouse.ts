// Apply the Warehouse (WMS) migration. ADDITIVE ONLY.
//
// Dry-run by default — BEGIN, run the migration, verify every table + every
// index (asserting partial ones actually carry a WHERE clause), then ROLLBACK
// so nothing is written. Pass --apply to COMMIT for real.
//
//   npx tsx --env-file=.env script/apply-warehouse.ts            (dry-run, rolls back)
//   npx tsx --env-file=.env script/apply-warehouse.ts --apply    (commits)
//
// 🔴 There is no DATABASE_URL in this worktree/loop environment — this script
// is WRITTEN here but only ever RUN by a human later, against the real
// Supabase prod DB, BEFORE the ClubOS Fly deploy that carries this lineage.
// (Prod already has shop_variants/organizations/users/contacts from earlier
// migrations, so every FK here is satisfiable regardless of deployed code.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const APPLY = process.argv.includes("--apply");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-07-13_warehouse.sql"), "utf8");

// Every table this migration creates — §4.1 / PLAN.md T2.
const EXPECTED_TABLES = [
  "wh_locations",
  "wh_items",
  "wh_barcode_aliases",
  "wh_movements",
  "wh_stock",
  "wh_reservations",
  "wh_purchase_orders",
  "wh_po_lines",
  "wh_requisitions",
  "wh_requisition_lines",
  "wh_loans",
  "wh_loan_lines",
  "wh_counts",
  "wh_count_lines",
  "wh_shopify_events",
  "wh_sync_state",
];

// Every UNIQUE / partial-unique index this migration creates. `partial: true`
// asserts the index's own definition contains a WHERE clause (a plain
// CREATE INDEX with no WHERE would silently defeat the "only one ACTIVE
// reservation" / "only one mapped Shopify variant" invariants it exists for).
const EXPECTED_INDEXES: Array<{ name: string; partial: boolean }> = [
  { name: "wh_locations_code_unique", partial: false },
  { name: "wh_items_sku_unique", partial: false },
  { name: "wh_items_shop_variant_unique", partial: true },
  { name: "wh_items_shopify_mapping_unique", partial: true },
  { name: "wh_barcode_aliases_code_unique", partial: false },
  { name: "wh_movements_idempotency_key_unique", partial: true },
  { name: "wh_stock_item_location_unique", partial: false },
  { name: "wh_reservations_active_ref_item_unique", partial: true },
  { name: "wh_count_lines_count_item_location_unique", partial: false },
  { name: "wh_shopify_events_webhook_id_unique", partial: false },
  { name: "wh_sync_state_item_store_unique", partial: false },
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (this script only ever runs against a real DB, by a human, later).");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  await pool.query("BEGIN");
  await pool.query(sql);

  let missing = 0;

  for (const table of EXPECTED_TABLES) {
    const r = await pool.query("SELECT to_regclass($1) AS t", [`public.${table}`]);
    const ok = r.rows[0].t !== null;
    if (!ok) missing++;
    console.log(`${ok ? "  ok " : " MISS"}  table ${table}`);
  }

  for (const { name, partial } of EXPECTED_INDEXES) {
    const r = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = $1", [name]);
    const ok = r.rows.length > 0;
    if (!ok) {
      missing++;
      console.log(` MISS  index ${name}`);
      continue;
    }
    const indexdef: string = r.rows[0].indexdef;
    const hasWhere = /\bWHERE\b/i.test(indexdef);
    if (partial && !hasWhere) {
      missing++;
      console.log(` MISS  index ${name} (expected a partial index with WHERE, got: ${indexdef})`);
      continue;
    }
    if (!partial && hasWhere) {
      missing++;
      console.log(` MISS  index ${name} (expected a plain index with no WHERE, got: ${indexdef})`);
      continue;
    }
    console.log(`  ok   index ${name}${partial ? " (partial, verified WHERE present)" : ""}`);
  }

  // The one true CHECK constraint in this migration (delta <> 0 — see
  // AGENTS.md: CHECKs only for true invariants, never for enum-ish columns).
  const chk = await pool.query(
    "SELECT 1 FROM pg_constraint WHERE conname = $1",
    ["wh_movements_delta_nonzero_chk"],
  );
  const chkOk = chk.rows.length > 0;
  if (!chkOk) missing++;
  console.log(`${chkOk ? "  ok " : " MISS"}  constraint wh_movements_delta_nonzero_chk`);

  if (missing > 0) {
    console.error(`\n${missing} object(s) missing after migration — DO NOT DEPLOY.`);
    await pool.query("ROLLBACK");
    process.exit(1);
  }

  console.log(`\nAll ${EXPECTED_TABLES.length} tables + ${EXPECTED_INDEXES.length} indexes + 1 CHECK constraint present.`);

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

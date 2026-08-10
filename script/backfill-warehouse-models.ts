// D34 — group the existing warehouse catalogue under real models.
//
//   Rehearse:  npx tsx --env-file=.env script/backfill-warehouse-models.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/backfill-warehouse-models.ts
//
// Dry-run by default in spirit: --dry-run rolls the whole pass back after
// printing exactly what it would write, so Dima can read the model list before
// a single row lands.
//
// THIS IS A JOIN, NOT A HEURISTIC. 4,726 of the 4,727 wh_items map one-to-one
// to a shop_variants row, and those variants already sit under 117 real
// shop_products. The model relationship exists as reviewed data — the counting
// screen's current habit of guessing it from common word prefixes in item
// names is what this replaces.
//
// IDEMPOTENT, and deliberately conservative on re-runs:
//   * a model is created once per shop_product (partial unique index)
//   * an item is only ever pointed at a model if its model_id is NULL, so a
//     regrouping Dima does by hand is never silently undone by re-running this
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

/**
 * The seeded product titles carry the manufacturer's article number welded to
 * the end of the description — "Football Shirt 7351TX1092", "Football Kit
 * K15Z210". Dima's spec is explicit that title and vendorModel are separate
 * fields, so split them.
 *
 * Strict on purpose: last whitespace-separated token, 5+ characters, uppercase
 * alphanumeric, and at least three digits. "CIC Hoodie" keeps its whole title
 * (no token qualifies), and a size like "2XL" can never be mistaken for an
 * article number. Anything that does not clearly match is left alone with
 * vendor_model NULL — a blank field is recoverable, a wrong one is not.
 */
function splitModelCode(title: string): { title: string; vendorModel: string | null } {
  const parts = title.trim().split(/\s+/);
  if (parts.length < 2) return { title: title.trim(), vendorModel: null };
  const last = parts[parts.length - 1];
  const digits = (last.match(/\d/g) ?? []).length;
  const looksLikeCode = /^[A-Z0-9][A-Z0-9-]{4,}$/.test(last) && digits >= 3;
  if (!looksLikeCode) return { title: title.trim(), vendorModel: null };
  return { title: parts.slice(0, -1).join(" ").trim(), vendorModel: last };
}

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await pool.query("BEGIN");

  // Every shop product that actually has warehouse items behind it.
  const products = await pool.query<{ id: number; title: string; items: string }>(`
    SELECT p.id, p.title, count(DISTINCT i.id)::text AS items
      FROM shop_products p
      JOIN shop_variants v ON v.product_id = p.id
      JOIN wh_items i      ON i.shop_variant_id = v.id
     GROUP BY p.id, p.title
     ORDER BY count(DISTINCT i.id) DESC`);

  console.log(`${products.rows.length} shop products carry warehouse items.\n`);

  let created = 0;
  let existed = 0;
  const preview: { title: string; code: string; variants: string }[] = [];

  for (const p of products.rows) {
    const { title, vendorModel } = splitModelCode(p.title);
    // vendor is left NULL on purpose — the catalogue mixes KELME kit with
    // CIC-branded merch, and organization_id says who SELLS a product, not who
    // MADE it. Never invent a manufacturer.
    const ins = await pool.query(
      `INSERT INTO wh_models (title, vendor_model, shop_product_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (shop_product_id) WHERE shop_product_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [title, vendorModel, p.id],
    );
    if (ins.rows.length) created++;
    else existed++;
    if (preview.length < 15) preview.push({ title, code: vendorModel ?? "—", variants: p.items });
  }

  console.log("Models (first 15):");
  console.table(preview);
  console.log(`created ${created} · already present ${existed}\n`);

  // Point each item at its model — only where it has none, so a hand-made
  // regrouping survives a re-run.
  const linked = await pool.query(`
    UPDATE wh_items i
       SET model_id = m.id, updated_at = now()
      FROM shop_variants v
      JOIN wh_models m ON m.shop_product_id = v.product_id
     WHERE i.shop_variant_id = v.id
       AND i.model_id IS NULL`);
  console.log(`linked ${linked.rowCount} items to a model\n`);

  // ── Verification, inside the transaction ──────────────────────────────────
  let failures = 0;
  const check = (ok: boolean, label: string) => { if (!ok) failures++; console.log(`${ok ? "  ok " : " FAIL"}  ${label}`); };

  const totals = await pool.query(`
    SELECT (SELECT count(*) FROM wh_items)                       AS items,
           (SELECT count(*) FROM wh_items WHERE model_id IS NOT NULL) AS grouped,
           (SELECT count(*) FROM wh_models)                      AS models,
           (SELECT count(*) FROM wh_stock)                       AS stock,
           (SELECT count(*) FROM wh_movements)                   AS movements`);
  const t = totals.rows[0];
  console.log("");
  check(Number(t.models) === products.rows.length, `one model per product (${t.models} of ${products.rows.length})`);
  check(Number(t.grouped) === 4726 || Number(t.grouped) === Number(t.items) - 1,
    `${t.grouped} of ${t.items} items grouped (the unmapped one is the 'test item' row)`);
  check(Number(t.stock) === 0 && Number(t.movements) === 0, "no stock or ledger rows created");

  // No model may end up with zero variants — that would mean the link step
  // missed a product the create step made a row for.
  const orphanModels = await pool.query(
    `SELECT count(*) AS n FROM wh_models m
      WHERE NOT EXISTS (SELECT 1 FROM wh_items i WHERE i.model_id = m.id)`);
  check(Number(orphanModels.rows[0].n) === 0, "no model left with zero variants");

  // Every grouped item's model must trace back to the SAME shop product its
  // variant belongs to. This is the one thing that would make the grouping a
  // lie, and it is cheap to prove.
  const mismatched = await pool.query(`
    SELECT count(*) AS n
      FROM wh_items i
      JOIN wh_models m       ON m.id = i.model_id
      JOIN shop_variants v   ON v.id = i.shop_variant_id
     WHERE m.shop_product_id IS DISTINCT FROM v.product_id`);
  check(Number(mismatched.rows[0].n) === 0, "every item sits under its own product's model");

  // Show a real expanded model, the way the counting screen will.
  const sample = await pool.query(`
    SELECT m.title AS model, m.vendor_model AS code, i.sku, i.name
      FROM wh_models m JOIN wh_items i ON i.model_id = m.id
     WHERE m.id = (SELECT model_id FROM wh_items WHERE model_id IS NOT NULL
                    GROUP BY model_id ORDER BY count(*) DESC LIMIT 1)
     ORDER BY i.sku LIMIT 6`);
  console.log("\nSample — one model expanded to its variants:");
  console.table(sample.rows);

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
  }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  console.error("\nFAILED — rolled back.\n", e);
  process.exit(1);
} finally {
  await pool.end();
}

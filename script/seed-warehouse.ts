// Seed the warehouse catalogue (D4/D8/D11). Two independent jobs, both
// idempotent — safe to re-run:
//
//   1. Locations — the 4 virtual locations (SUPPLIER/CUSTOMER/SCRAP/
//      PRODUCTION) + the 4 named zones (RECEIVING/PACK/DISPATCH/QUARANTINE).
//      NO physical bins are seeded — Daniel lays those out for real once the
//      warehouse is walked (T20's scan-station preview is for that).
//   2. Items — maps every existing MFL (org 3) + CIC (org 5) `shop_variants`
//      row into a `wh_items` row (kind 'merch', channel-mapped via
//      `shop_variant_id`), so the two brands already on our own commerce
//      engine start life in the WMS catalogue rather than as a second import
//      later. SIU/CUFC (Shopify-mapped) are NOT seeded here — T12's sync
//      layer resolves those live off Shopify's own catalogue, and inventing
//      wh_items rows for them ahead of that would just be duplicate data with
//      no shopify_variant_id yet to back it.
//
// Deliberately NOT seeded, ever, by this script:
//   - wh_stock / any quantity — opening stock comes from Daniel's first real
//     count (the counts flow, T11/T16c), never invented here.
//   - default_location_id — no bin exists yet to default an item to.
//   - CIC gift-card variants — a gift card has no physical stock to warehouse
//     (D4 is "everything STOCKED"); mapping one into wh_items would produce a
//     nonsensical "low stock" alert on a thing that can't run out.
//   - variants under an archived product — nothing to manage once a product
//     is discontinued.
//
//   npx tsx --env-file=.env script/seed-warehouse.ts            (dry run)
//   npx tsx --env-file=.env script/seed-warehouse.ts --apply    (writes)
//
// Run AFTER migrations/2026-07-13_warehouse.sql has been applied
// (script/apply-warehouse.ts --apply).
//
// 🔴 There is no DATABASE_URL in this worktree/loop environment — this script
// is WRITTEN here but only ever RUN by a human later, against the real
// Supabase prod DB.
import { Pool } from "pg";
import {
  VIRTUAL_LOCATION_CODES,
  NAMED_ZONES,
  deriveLocationZone,
  normaliseSku,
  type BrandOwner,
} from "../shared/warehouse";

const APPLY = process.argv.includes("--apply");

type StoreConfig = {
  orgId: number;
  brand: BrandOwner;
  excludeProductTypes: string[]; // shop_products.type values that aren't physical stock
};

// MFL org 3 / CIC org 5 — same IDs script/seed-shop-mfl.ts and
// script/seed-shop-cic.ts already hardcode (no `organizations` lookup table
// keyed any other way for these two).
const STORES: StoreConfig[] = [
  { orgId: 3, brand: "mfl", excludeProductTypes: [] },
  { orgId: 5, brand: "cic", excludeProductTypes: ["giftcard"] },
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set (this script only ever runs against a real DB, by a human, later).");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Builds a `sku`unique among everything already seen this run (`used`,
 *  pre-loaded with every SKU already in `wh_items`) by appending -2, -3… and
 *  re-truncating to stay inside `normaliseSku`'s 20-char cap. Only ever
 *  invoked on the rare accidental collision after normalisation/truncation —
 *  not the normal path. */
function uniqueSku(base: string, used: Set<string>): string {
  let candidate = normaliseSku(base);
  let n = 2;
  while (used.has(candidate)) {
    const suffix = `-${n}`;
    candidate = normaliseSku(base.slice(0, Math.max(1, 20 - suffix.length)) + suffix);
    n++;
  }
  used.add(candidate);
  return candidate;
}

/** SKU scheme is D7's BRAND-CAT-STYLE-COLOUR-SIZE. When the variant already
 *  carries a supplier/native SKU (e.g. KELME's `${article}-${colourCode}-
 *  ${size}`, seeded by script/import-kelme-products.ts) that's the most
 *  specific, least-invented identifier available — reuse it as the STYLE
 *  segment, just brand-prefixed so it's globally unique and scheme-shaped.
 *  Otherwise generate the full scheme from the product/colour/size fields
 *  actually on file — nothing here is invented, every segment traces to a
 *  real column. */
function buildBaseSku(
  brand: BrandOwner,
  variantSku: string | null,
  fields: { productType: string; productSlug: string; colourName: string; size: string },
): string {
  if (variantSku && variantSku.trim()) {
    return `${brand}-${variantSku}`;
  }
  const style = fields.productSlug.replace(new RegExp(`^${brand}-`, "i"), "") || fields.productType;
  return `${brand}-${fields.productType}-${style}-${fields.colourName}-${fields.size}`;
}

/** 🔴 The four NAMED_ZONES (RECEIVING/PACK/DISPATCH/QUARANTINE) are NOT seeded
 *  by default any more. They are a generic 3PL layout, and on 2026-07-29 Daniel
 *  deliberately removed them from United Sports Centre in favour of the areas
 *  that actually exist there (Warehouse / Big Shed / Office / Print Shop — see
 *  script/seed-warehouse-usc-locations.ts). Re-running this seed must not
 *  resurrect four zones a human chose to delete.
 *
 *  Pass --with-generic-zones to create them anyway — the one case that needs it
 *  is QUARANTINE, which receiving damaged PO stock looks up by that exact code.
 *
 *  The VIRTUAL locations are different and always seeded: SUPPLIER / CUSTOMER /
 *  SCRAP / PRODUCTION are structural (D8), so that every movement can say where
 *  goods came from or went to. */
const WITH_GENERIC_ZONES = process.argv.includes("--with-generic-zones");

async function seedLocations() {
  console.log("── Locations ──");
  let created = 0;
  let existing = 0;
  for (const code of VIRTUAL_LOCATION_CODES) {
    (await upsertLocation(code, "virtual")) ? created++ : existing++;
  }
  if (WITH_GENERIC_ZONES) {
    for (const code of NAMED_ZONES) {
      (await upsertLocation(code, "zone")) ? created++ : existing++;
    }
  } else {
    console.log(`  · skipping the generic zones (${NAMED_ZONES.join(", ")}) — pass --with-generic-zones to create them`);
  }
  console.log(`${created} to create, ${existing} already present.\n`);
}

/** Returns true if this location was (or, dry-run, would be) newly created. */
async function upsertLocation(code: string, kind: "virtual" | "zone"): Promise<boolean> {
  const found = await pool.query("SELECT id FROM wh_locations WHERE code = $1", [code]);
  if (found.rows.length > 0) {
    console.log(`  = ${code.padEnd(12)} exists (id ${found.rows[0].id})`);
    return false;
  }
  const zone = deriveLocationZone(code, kind);
  console.log(`  + ${code.padEnd(12)} kind=${kind}${zone ? ` zone=${zone}` : ""}`);
  if (APPLY) {
    await pool.query("INSERT INTO wh_locations (code, zone, kind, active) VALUES ($1,$2,$3,true)", [code, zone, kind]);
  }
  return true;
}

type VariantRow = {
  variant_id: number;
  variant_sku: string | null;
  size: string;
  colour_name: string;
  product_title: string;
  product_slug: string;
  product_type: string;
};

async function seedItemsForStore(store: StoreConfig, usedSkus: Set<string>) {
  console.log(`── Items — ${store.brand.toUpperCase()} (org ${store.orgId}) ──`);

  const { rows } = await pool.query<VariantRow>(
    `SELECT v.id AS variant_id, v.sku AS variant_sku, v.size,
            c.name AS colour_name,
            p.title AS product_title, p.slug AS product_slug, p.type AS product_type
     FROM shop_variants v
     JOIN shop_product_colours c ON c.id = v.colour_id
     JOIN shop_products p ON p.id = c.product_id
     WHERE p.organization_id = $1
       AND p.status <> 'archived'
     ORDER BY p.sort_order, c.sort_order, v.id`,
    [store.orgId],
  );

  let created = 0;
  let existing = 0;
  let excluded = 0;

  for (const row of rows) {
    if (store.excludeProductTypes.includes(row.product_type)) {
      excluded++;
      continue;
    }

    const already = await pool.query("SELECT id, sku FROM wh_items WHERE shop_variant_id = $1", [row.variant_id]);
    if (already.rows.length > 0) {
      console.log(`  = variant ${row.variant_id} exists as wh_items ${already.rows[0].sku} (id ${already.rows[0].id})`);
      existing++;
      continue;
    }

    const base = buildBaseSku(store.brand, row.variant_sku, {
      productType: row.product_type,
      productSlug: row.product_slug,
      colourName: row.colour_name,
      size: row.size,
    });
    const sku = uniqueSku(base, usedSkus);
    const name = `${row.product_title} — ${row.colour_name}, ${row.size}`;

    console.log(`  + ${sku.padEnd(20)} ${name}`);
    created++;

    if (!APPLY) continue;

    await pool.query(
      `INSERT INTO wh_items (sku, name, kind, brand_owner, category, unit, active, shop_variant_id)
       VALUES ($1,$2,'merch',$3,$4,'ea',true,$5)`,
      [sku, name, store.brand, row.product_type, row.variant_id],
    );
  }

  console.log(`${created} to create, ${existing} already mapped, ${excluded} excluded (not physical stock).\n`);
}

try {
  if (!APPLY) console.log("DRY RUN — nothing will be written. Re-run with --apply to commit.\n");

  await seedLocations();

  const skuRows = await pool.query("SELECT sku FROM wh_items");
  const usedSkus = new Set<string>(skuRows.rows.map((r: { sku: string }) => r.sku));

  for (const store of STORES) {
    await seedItemsForStore(store, usedSkus);
  }

  console.log("─".repeat(70));
  console.log(
    APPLY
      ? "Seeded. No bins, no quantities — walk the warehouse and run the first real count to open stock."
      : "Dry run complete. Re-run with --apply to commit.",
  );
} finally {
  await pool.end();
}

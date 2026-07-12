// Seed the MFL Store (org 3) with its two launch shipping options.
// Idempotent — skips any option whose label already exists for the org.
//
// ⚠️ NZ Courier price is a $9.99 PLACEHOLDER — Daniel to confirm the real
//    rate before the store goes live.
//
// Run AFTER migrations/2026-07-06_mfl_shop.sql has been applied:
//   npx tsx --env-file=.env script/seed-shop-mfl.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const MFL_ORG_ID = 3;

const OPTIONS = [
  {
    label: "Pickup — United Sports Centre, 466 Yaldhurst Rd",
    description: "Free pickup from reception. We'll email you when it's ready.",
    priceCents: 0,
    requiresAddress: false,
    sortOrder: 0,
  },
  {
    label: "NZ Courier",
    description: "Tracked courier anywhere in New Zealand.",
    priceCents: 999, // ⚠️ placeholder — confirm real courier rate with Daniel
    requiresAddress: true,
    sortOrder: 1,
  },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const opt of OPTIONS) {
      const { rows } = await pool.query(
        `SELECT id FROM shop_shipping_options WHERE organization_id = $1 AND label = $2`,
        [MFL_ORG_ID, opt.label],
      );
      if (rows.length > 0) {
        console.log(`✓ Already exists (id ${rows[0].id}): ${opt.label}`);
        continue;
      }
      const { rows: created } = await pool.query(
        `INSERT INTO shop_shipping_options (organization_id, label, description, price_cents, requires_address, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         RETURNING id`,
        [MFL_ORG_ID, opt.label, opt.description, opt.priceCents, opt.requiresAddress, opt.sortOrder],
      );
      console.log(`+ Created (id ${created[0].id}): ${opt.label} — $${(opt.priceCents / 100).toFixed(2)}`);
    }
    console.log("Done. Reminder: NZ Courier price is a placeholder — confirm with Daniel.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

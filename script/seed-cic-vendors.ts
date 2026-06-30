// Seed the CIC Vendors roster from Daniel's July 2026 plan.
// Idempotent: vendors are upserted by (org, name); bookings rely on the
// unique (vendor_id, booking_date) index and ON CONFLICT DO NOTHING.
// Safe to re-run. Run AFTER apply-cic-vendors-schema.ts.
//
// Usage: npx tsx --env-file=.env script/seed-cic-vendors.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ORG_SLUG = "christchurch-international-cup";

// name -> { category, isOurs?, contractStatus?, contactEmail? }
const VENDORS: Record<string, { category: string; isOurs?: boolean; contractStatus?: string; contactEmail?: string | null }> = {
  "CIC Food Truck (Crush)": { category: "meal", isOurs: true },
  "Empire Chicken": { category: "meal" },
  "Bangkok Wok": { category: "meal" },
  "Wildfire Pizza": { category: "meal" },
  "Flamin Tomahawks": { category: "meal" },
  "Bacon Bros": { category: "meal" },
  "Rollicious": { category: "meal" },
  "Frankie's Coffee Cart": { category: "coffee", contractStatus: "pending", contactEmail: null }, // email pending her reply
};

// External meal-truck assignments per day (Truck 1 / 2 / 3 from the roster).
const MEAL_SCHEDULE: Record<string, string[]> = {
  "2026-07-05": ["Empire Chicken"],
  "2026-07-06": ["Bangkok Wok"],
  "2026-07-07": ["Wildfire Pizza"],
  "2026-07-08": ["Bangkok Wok"],
  "2026-07-09": ["Flamin Tomahawks"],
  "2026-07-10": ["Empire Chicken"],
  "2026-07-11": ["Empire Chicken", "Bacon Bros", "Flamin Tomahawks"],
  "2026-07-12": ["Bangkok Wok", "Wildfire Pizza", "Flamin Tomahawks"],
  "2026-07-13": ["Empire Chicken", "Bacon Bros", "Rollicious"],
  "2026-07-14": ["Empire Chicken", "Bangkok Wok"],
  "2026-07-15": ["Empire Chicken", "Wildfire Pizza"],
  "2026-07-16": ["Empire Chicken", "Rollicious"],
};

const ALL_DAYS = Object.keys(MEAL_SCHEDULE);
const FRANKIE_DAYS = ["2026-07-11", "2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"];

async function main() {
  const client = await pool.connect();
  try {
    const org = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [ORG_SLUG]);
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error(`Org '${ORG_SLUG}' not found`);
    console.log(`CIC org id = ${orgId}`);

    // Upsert vendors, capture ids.
    const vendorId: Record<string, number> = {};
    for (const [name, def] of Object.entries(VENDORS)) {
      const found = await client.query(`SELECT id FROM cic_vendors WHERE organization_id = $1 AND name = $2`, [orgId, name]);
      if (found.rows[0]) {
        vendorId[name] = found.rows[0].id;
      } else {
        const ins = await client.query(
          `INSERT INTO cic_vendors (organization_id, name, category, is_ours, contact_email, contract_status)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [orgId, name, def.category, def.isOurs ?? false, def.contactEmail ?? null, def.contractStatus ?? "none"],
        );
        vendorId[name] = ins.rows[0].id;
        console.log(`  + vendor ${name}`);
      }
    }

    // Build bookings: ours every day; external meal per schedule; Frankie 11-16.
    const bookings: { name: string; date: string; slot: number | null }[] = [];
    for (const day of ALL_DAYS) {
      bookings.push({ name: "CIC Food Truck (Crush)", date: day, slot: null });
      MEAL_SCHEDULE[day].forEach((n, i) => bookings.push({ name: n, date: day, slot: i + 1 }));
    }
    for (const day of FRANKIE_DAYS) bookings.push({ name: "Frankie's Coffee Cart", date: day, slot: null });

    let added = 0;
    for (const b of bookings) {
      const r = await client.query(
        `INSERT INTO cic_vendor_bookings (organization_id, vendor_id, booking_date, slot)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (vendor_id, booking_date) DO NOTHING RETURNING id`,
        [orgId, vendorId[b.name], b.date, b.slot],
      );
      if (r.rows[0]) added++;
    }

    console.log(`✅ Seed complete. Vendors: ${Object.keys(VENDORS).length}. Bookings added: ${added} (of ${bookings.length} planned; rest already present).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});

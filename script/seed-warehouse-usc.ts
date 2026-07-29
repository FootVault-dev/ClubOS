// The warehouse's first real location — United Sports Centre Warehouse
// (Daniel, 2026-07-29). Idempotent: re-running never creates a second row and
// never overwrites an edit made in the Locations tab.
//
//   npx tsx --env-file=.env script/seed-warehouse-usc.ts            (dry run)
//   npx tsx --env-file=.env script/seed-warehouse-usc.ts --apply    (writes)
//
// Run AFTER script/apply-warehouse-location-name.ts --apply.
//
//   code = 'USC-WAREHOUSE'  — the identity. Uppercase, no spaces, because this
//                             is what a bin label encodes and a scanner reads
//                             back (shared/warehouse.ts isValidLocationCode).
//   name = 'United Sports Centre Warehouse'  — what staff see in every picker.
//   kind = 'zone'           — a named physical area that holds stock. NOT
//                             'bin' (it is the whole building, not a shelf)
//                             and NOT 'virtual' (virtual locations are
//                             excluded from counting — the stock take filters
//                             them out, so a virtual USC could never be
//                             counted, which is the entire point of it).
//
// 🔴 No quantities. Opening stock comes from the first real physical count,
// never from a seed script — same rule as script/seed-warehouse.ts.

import { Pool } from "pg";
import { deriveLocationZone, isValidLocationCode, normaliseLocationName } from "../shared/warehouse";

const APPLY = process.argv.includes("--apply");

const CODE = "USC-WAREHOUSE";
const NAME = "United Sports Centre Warehouse";
const KIND = "zone" as const;

if (!isValidLocationCode(CODE)) throw new Error(`${CODE} is not a valid location code`);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const one = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows[0];

try {
  await pool.query("BEGIN");

  const hasName = await one(
    `SELECT 1 FROM information_schema.columns WHERE table_name='wh_locations' AND column_name='name'`,
  );
  if (!hasName) throw new Error("wh_locations.name is missing — run script/apply-warehouse-location-name.ts --apply first.");

  const existing = await one(`SELECT id, code, name, kind, active FROM wh_locations WHERE code = $1`, [CODE]);

  if (existing) {
    // Already there. Fill in the name ONLY if it is still blank — if somebody
    // has renamed it in the Locations tab, that is the truth, not this file.
    if (existing.name) {
      console.log(`Already present and named: #${existing.id} ${existing.code} — "${existing.name}". Nothing to do.`);
    } else {
      await pool.query(`UPDATE wh_locations SET name = $1 WHERE id = $2`, [normaliseLocationName(NAME), existing.id]);
      console.log(`Named the existing #${existing.id} ${existing.code} → "${NAME}".`);
    }
  } else {
    const created = await one(
      `INSERT INTO wh_locations (code, name, zone, kind, active) VALUES ($1,$2,$3,$4,true) RETURNING id, code, name, zone, kind`,
      [CODE, normaliseLocationName(NAME), deriveLocationZone(CODE, KIND), KIND],
    );
    console.log(`Created #${created.id}: ${created.code} — "${created.name}" (${created.kind}, zone ${created.zone}).`);
  }

  const all = (await pool.query(
    `SELECT code, name, kind, active FROM wh_locations ORDER BY kind, code`,
  )).rows;
  console.log(`\nAll ${all.length} locations:`);
  for (const l of all) {
    console.log(`  ${l.active ? " " : "·"} ${(l.name ?? l.code).padEnd(34)} ${l.code.padEnd(16)} ${l.kind}`);
  }
  const countable = all.filter((l: any) => l.kind !== "virtual" && l.active);
  console.log(`\n${countable.length} countable in the stock take: ${countable.map((l: any) => l.name ?? l.code).join(", ")}`);

  if (APPLY) { await pool.query("COMMIT"); console.log("\n✅ COMMITTED."); }
  else { await pool.query("ROLLBACK"); console.log("\n✅ Dry run — rolled back, nothing written."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}

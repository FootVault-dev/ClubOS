// The real areas at United Sports Centre (Daniel, 2026-07-29).
//
// The warehouse shipped with four GENERIC 3PL zones — RECEIVING, PACK,
// DISPATCH, QUARANTINE — which are a suggested layout, not this building.
// Daniel replaced them with the places that actually exist:
//
//   USC-WAREHOUSE   United Sports Centre Warehouse   (already seeded)
//   USC-BIGSHED     Big Shed
//   USC-OFFICE      Office
//   USC-PRINTSHOP   Print Shop
//
// Idempotent and dry-run by default:
//   npx tsx --env-file=.env script/seed-warehouse-usc-locations.ts
//   npx tsx --env-file=.env script/seed-warehouse-usc-locations.ts --apply
//
// 🔴 IT REFUSES TO DELETE A LOCATION ANYTHING POINTS AT. Every table that can
// reference a location is checked first — stock, movements, reservations, an
// item's default location, count lines, asset instances, a child location. A
// zone with history is reported and LEFT ALONE, never removed, because the
// ledger has to keep being able to say where something was. Today all four are
// untouched seeds (0 movements in the whole warehouse), which is the only
// reason removing them is a clean operation rather than a data loss.
//
// ⚠️ QUARANTINE is the one with a job in code: receiving a PO line with damaged
// stock looks up a location whose code is exactly 'QUARANTINE' and parks it
// there. With no such row that receive is refused with a clear message ("No
// QUARANTINE location is set up yet — create one before receiving damaged
// stock") rather than silently mixing damaged stock into sellable — so removing
// it is safe, it just means damaged-goods receiving needs the zone re-created
// first. `isSellableLocation` also keys on that exact code; with no row, nothing
// is quarantined and nothing is wrongly excluded.

import { Pool } from "pg";
import { deriveLocationZone, isValidLocationCode, normaliseLocationName } from "../shared/warehouse";

const APPLY = process.argv.includes("--apply");

/** The places that actually exist at United Sports Centre. */
const ADD: { code: string; name: string; kind: "zone" }[] = [
  { code: "USC-BIGSHED", name: "Big Shed", kind: "zone" },
  { code: "USC-OFFICE", name: "Office", kind: "zone" },
  { code: "USC-PRINTSHOP", name: "Print Shop", kind: "zone" },
];

/** The generic 3PL zones that don't describe this building. */
const REMOVE = ["RECEIVING", "PACK", "DISPATCH", "QUARANTINE"];

/** Every column in the schema that can point at a location. */
const REFERENCES: [table: string, column: string][] = [
  ["wh_stock", "location_id"],
  ["wh_movements", "from_location_id"],
  ["wh_movements", "to_location_id"],
  ["wh_reservations", "location_id"],
  ["wh_items", "default_location_id"],
  ["wh_counts", "location_id"],
  ["wh_count_lines", "location_id"],
  ["wh_item_instances", "location_id"],
  ["wh_locations", "parent_location_id"],
];

for (const a of ADD) {
  if (!isValidLocationCode(a.code)) throw new Error(`${a.code} is not a valid location code`);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const rows = async (q: string, p: any[] = []) => (await pool.query(q, p)).rows;
const one = async (q: string, p: any[] = []) => (await rows(q, p))[0];

try {
  await pool.query("BEGIN");

  const hasName = await one(
    `SELECT 1 FROM information_schema.columns WHERE table_name='wh_locations' AND column_name='name'`,
  );
  if (!hasName) throw new Error("wh_locations.name is missing — run script/apply-warehouse-location-name.ts --apply first.");

  // ── Add ────────────────────────────────────────────────────────────────────
  console.log("Adding the real areas:");
  for (const a of ADD) {
    const existing = await one(`SELECT id, name FROM wh_locations WHERE code = $1`, [a.code]);
    if (existing) {
      // Never clobber a rename made in the Locations tab — only fill a blank.
      if (existing.name) {
        console.log(`  = ${a.code.padEnd(15)} exists as "${existing.name}"`);
      } else {
        await pool.query(`UPDATE wh_locations SET name = $1 WHERE id = $2`, [normaliseLocationName(a.name), existing.id]);
        console.log(`  ~ ${a.code.padEnd(15)} named "${a.name}"`);
      }
    } else {
      const c = await one(
        `INSERT INTO wh_locations (code, name, zone, kind, active) VALUES ($1,$2,$3,$4,true) RETURNING id`,
        [a.code, normaliseLocationName(a.name), deriveLocationZone(a.code, a.kind), a.kind],
      );
      console.log(`  + ${a.code.padEnd(15)} "${a.name}" (#${c.id})`);
    }
  }

  // ── Remove, but only what nothing points at ────────────────────────────────
  console.log("\nRemoving the generic zones:");
  let blocked = 0;
  for (const code of REMOVE) {
    const loc = await one(`SELECT id, code FROM wh_locations WHERE code = $1`, [code]);
    if (!loc) { console.log(`  · ${code.padEnd(15)} not present`); continue; }

    const held: string[] = [];
    for (const [table, column] of REFERENCES) {
      const col = await one(
        `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, column],
      );
      if (!col) continue;
      const r = await one(`SELECT count(*)::int n FROM ${table} WHERE ${column} = $1`, [loc.id]);
      if (Number(r.n) > 0) held.push(`${table}.${column}=${r.n}`);
    }

    if (held.length) {
      blocked++;
      console.log(`  ! ${code.padEnd(15)} KEPT — still referenced by ${held.join(", ")}`);
    } else {
      await pool.query(`DELETE FROM wh_locations WHERE id = $1`, [loc.id]);
      console.log(`  - ${code.padEnd(15)} removed (nothing referenced it)`);
    }
  }

  const all = await rows(`SELECT code, name, kind, active FROM wh_locations ORDER BY kind DESC, code`);
  console.log(`\nAll ${all.length} locations now:`);
  for (const l of all) console.log(`  ${(l.name ?? l.code).padEnd(32)} ${l.code.padEnd(16)} ${l.kind}`);
  const countable = all.filter((l: any) => l.kind !== "virtual" && l.active);
  console.log(`\n${countable.length} in the stock take: ${countable.map((l: any) => l.name ?? l.code).join(" · ")}`);
  if (blocked) console.log(`\n⚠️  ${blocked} zone(s) kept because real records point at them.`);

  if (APPLY) { await pool.query("COMMIT"); console.log("\n✅ COMMITTED."); }
  else { await pool.query("ROLLBACK"); console.log("\n✅ Dry run — rolled back, nothing written."); }
} catch (e) {
  await pool.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  await pool.end();
}

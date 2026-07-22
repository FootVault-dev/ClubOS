// Close direct online registration for CUFC's invite-only programmes
// (Daniel's directive, 2026-07-21): U9–U20 academy-pathway programmes take no
// public checkout — entry starts with a free open-training request instead.
//
//   Rehearse:  npx tsx --env-file=.env script/close-cufc-invite-only.ts
//   Apply:     npx tsx --env-file=.env script/close-cufc-invite-only.ts --apply
//
// Dry-run by DEFAULT. Flips `registration_open` to false on
// pre-academy-u9-u12 and academy-u13-u17 (org christchurch-united) — the same
// flag staff can re-enable any time in Academy → programme detail. Deliberately
// untouched: u4-u8 (still sells, with the open-training option alongside),
// technification (open to all clubs, live ad campaign), gk-programme +
// morning-programme-u13-u20 (already closed).
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const SLUGS = ["pre-academy-u9-u12", "academy-u13-u17"];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
try {
  const { rows: [org] } = await pool.query(
    "SELECT id FROM organizations WHERE slug = 'christchurch-united'",
  );
  if (!org) throw new Error("christchurch-united org not found");

  const state = async (label: string) => {
    const { rows } = await pool.query(
      `SELECT slug, is_active, registration_open FROM programs
        WHERE organization_id = $1 AND type = 'academy' ORDER BY slug`,
      [org.id],
    );
    console.log(`\n${label}:`);
    for (const r of rows) {
      console.log(`  ${r.slug.padEnd(28)} active=${r.is_active}  registration_open=${r.registration_open}`);
    }
    return rows;
  };

  await state("BEFORE (org " + org.id + ")");

  if (!APPLY) {
    console.log(`\nDRY RUN — would set registration_open = false on: ${SLUGS.join(", ")}`);
    console.log("Re-run with --apply to do it for real.\n");
  } else {
    const { rowCount } = await pool.query(
      `UPDATE programs SET registration_open = false
        WHERE organization_id = $1 AND type = 'academy' AND slug = ANY($2::text[])`,
      [org.id, SLUGS],
    );
    console.log(`\nUpdated ${rowCount} programme(s).`);
    await state("AFTER");
    console.log("\nDone. Verify: curl -s https://app.usg.co.nz/api/public/academy/programmes | check registrationOpen.\n");
  }
} finally {
  await pool.end();
}

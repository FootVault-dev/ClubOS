// Additive migration + discount seed for the MFL "stack & save" promo.
// Purely additive (ADD COLUMN IF NOT EXISTS + guarded INSERTs) — safe to re-run,
// never drops/alters existing data. Run BEFORE deploying the app build.
//   npx tsx --env-file=.env script/apply-mfl-stack-save.ts
//
// Seeds three org-3 (Mini Football Leagues) discounts, all combinesWithOrder so
// they stack additively to 40% off: STUDENT 10%, EARLYBIRD 20% (ends Sun 6 Jul
// 2026 NZ), MULTITEAM 10% (auto-applied at checkout when 2+ teams).

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MFL_ORG_ID = 3;
// Early bird ends end-of-Sunday 6 Jul 2026 NZ time. We pass the NZ wall-clock and
// convert to a UTC instant IN SQL (below), so the value stored in the
// `timestamp without time zone` column is deterministic no matter the timezone of
// whoever runs this seed (e.g. a NZ laptop vs a UTC CI box). The Fly container
// runs in UTC, so the server reads it back as the correct instant.
const EARLYBIRD_END = "2026-07-06 23:59:59"; // NZ local, end of Sunday

const DISCOUNTS = [
  { title: "Student 10%",    code: "STUDENT",   value: "10.00", method: "code",      endDate: null },
  { title: "Early Bird 20%", code: "EARLYBIRD", value: "20.00", method: "code",      endDate: EARLYBIRD_END },
  { title: "Multi-Team 10%", code: "MULTITEAM", value: "10.00", method: "automatic", endDate: null },
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Additive column for multi-team order grouping.
    await client.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS registration_group_id text`);

    // 2) Seed the three discounts (idempotent — skip if the code already exists).
    for (const d of DISCOUNTS) {
      await client.query(
        `INSERT INTO discounts
           (organization_id, title, code, type, method, value_type, value,
            applies_to, eligibility, min_purchase_type,
            combines_with_product, combines_with_order,
            start_date, end_date, status, times_used, total_discounted_cents)
         SELECT $1, $2, $3, 'amount_off_order', $4, 'percentage', $5,
                'all', 'all', 'none',
                true, true,
                now(), (($6::timestamp AT TIME ZONE 'Pacific/Auckland') AT TIME ZONE 'UTC'), 'active', 0, 0
         WHERE NOT EXISTS (
           SELECT 1 FROM discounts WHERE organization_id = $1 AND lower(code) = lower($3)
         )`,
        [MFL_ORG_ID, d.title, d.code, d.method, d.value, d.endDate],
      );
    }

    await client.query("COMMIT");

    // 3) Verify.
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name='registrations' AND column_name='registration_group_id'`,
    );
    console.log("registration_group_id column:", col.rowCount ? "OK" : "MISSING");

    const rows = await client.query(
      `SELECT code, title, value_type, value, combines_with_order, start_date, end_date, status
         FROM discounts WHERE organization_id=$1 AND code IN ('STUDENT','EARLYBIRD','MULTITEAM') ORDER BY code`,
      [MFL_ORG_ID],
    );
    console.log("Seeded discounts:");
    for (const r of rows.rows) {
      console.log(`  ${r.code.padEnd(10)} ${r.value}% combinesWithOrder=${r.combines_with_order} status=${r.status} ends=${r.end_date ? new Date(r.end_date).toISOString() : "—"}`);
    }
    if (rows.rowCount !== 3) console.warn(`⚠️  expected 3 discounts, found ${rows.rowCount}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });

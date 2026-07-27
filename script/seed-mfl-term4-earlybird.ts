// MFL Term 4 early bird — re-open the EARLYBIRD 20% discount for the Term 4 window.
//
// Discounts in ClubOS are ORG-scoped, not per-competition, so MULTITEAM / student
// codes / one-off codes already carry to Term 4 with no action. EARLYBIRD is the
// only one that needed anything: its Term 3 window ended 2026-07-05.
//
// Daniel, 27 Jul 2026: run it until Term 3 finishes (Thu 24 Sep) — turning the
// early open into a re-registration play for the 41 current Term 3 captains —
// and NO usage cap, same as last term.
//
// ⚠️ EARLYBIRD is AUTO-APPLIED (never typed) by resolveLeagueDiscounts, and
// combinesWithOrder=true, so it stacks additively with MULTITEAM 10% → 30% off
// a 2+ team order ($600 → $420). That is exactly how Term 3 behaved.
//
// Dry run (default):  npx tsx script/seed-mfl-term4-earlybird.ts
// Apply:              npx tsx script/seed-mfl-term4-earlybird.ts --apply

import "dotenv/config";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const ORG_ID = 3;
const CODE = "EARLYBIRD";

// Opens now; closes with Term 3's final night. Stored the same way Term 3's was
// (naive end-of-day), so the true cut-off is ~midday Fri 25 Sep NZ — a
// deliberate ~12h grace at the boundary, identical to last term's behaviour.
const START = "2026-07-27T00:00:00";
const END = "2026-09-24T23:59:59";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query(
      `SELECT id, code, title, value_type, value, status, start_date, end_date,
              max_total_uses, times_used, combines_with_order
         FROM discounts WHERE organization_id = $1 AND upper(code) = $2`,
      [ORG_ID, CODE],
    );
    if (before.rowCount !== 1) {
      throw new Error(`Expected exactly 1 ${CODE} row for org ${ORG_ID}, found ${before.rowCount} — aborting`);
    }
    const d = before.rows[0];
    if (d.value_type !== "percentage" || Number(d.value) !== 20) {
      throw new Error(`${CODE} is ${d.value_type} ${d.value}, expected percentage 20 — aborting`);
    }
    console.log(`Before:  ${d.title} — ${d.value}% ${d.status}`);
    console.log(`         window ${String(d.start_date).slice(0, 10)} → ${String(d.end_date).slice(0, 10)}`);
    console.log(`         cap ${d.max_total_uses ?? "none"} · used ${d.times_used} (lifetime) · stacks ${d.combines_with_order}`);

    // max_total_uses left NULL (no cap — Daniel's call). times_used is a lifetime
    // counter and is deliberately NOT reset: per-term usage is recoverable from
    // discount_usages by date, and zeroing it would corrupt total_discounted_cents.
    await client.query(
      `UPDATE discounts
          SET start_date = $1::timestamp, end_date = $2::timestamp,
              status = 'active', max_total_uses = NULL, updated_at = now()
        WHERE id = $3`,
      [START, END, d.id],
    );

    const after = await client.query(
      `SELECT status, start_date, end_date, max_total_uses FROM discounts WHERE id = $1`, [d.id]);
    const a = after.rows[0];
    console.log(`After:   ${a.status} · window ${String(a.start_date).slice(0, 10)} → ${String(a.end_date).slice(0, 10)} · cap ${a.max_total_uses ?? "none"}`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\n✓ EARLYBIRD 20% live for Term 4 until Thu 24 Sep.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n🔍 DRY RUN — rolled back. Re-run with --apply to commit.`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Failed:", e.message || e); process.exit(1); });

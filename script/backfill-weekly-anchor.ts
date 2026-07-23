// Backfill registrations.weekly_first_charge_date from Stripe — one-off.
//
// For every deposit_weekly registration with a subscription id and no stored
// anchor, retrieve the subscription (works for cancelled subs too) and persist
// its trial_end (or, when trial_end is null, billing_cycle_anchor) as the ISO
// first-charge date. Dry-run by default; --apply writes.
//   npx tsx script/backfill-weekly-anchor.ts            (report only)
//   npx tsx script/backfill-weekly-anchor.ts --apply    (write)
import "dotenv/config";
import { Pool } from "pg";
import Stripe from "stripe";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, team_name, stripe_subscription_id, registered_at
      FROM registrations
      WHERE payment_mode = 'deposit_weekly'
        AND stripe_subscription_id IS NOT NULL
        AND weekly_first_charge_date IS NULL
      ORDER BY id`);
    console.log(`${rows.length} weekly registration(s) missing an anchor${APPLY ? "" : " (dry run)"}\n`);

    let ok = 0, failed = 0;
    for (const r of rows) {
      try {
        const sub = await stripe.subscriptions.retrieve(r.stripe_subscription_id);
        const anchorSec = sub.trial_end ?? (sub as any).billing_cycle_anchor ?? null;
        if (!anchorSec) { console.log(`  #${r.id} ${r.team_name}: subscription has no trial_end/anchor — skipped`); failed++; continue; }
        const iso = new Date(anchorSec * 1000).toISOString().slice(0, 10);
        if (APPLY) {
          await client.query(`UPDATE registrations SET weekly_first_charge_date = $1 WHERE id = $2 AND weekly_first_charge_date IS NULL`, [iso, r.id]);
        }
        console.log(`  #${r.id} ${r.team_name}: first charge ${iso}${APPLY ? " ✓ written" : ""}`);
        ok++;
      } catch (e: any) {
        console.log(`  #${r.id} ${r.team_name}: FAILED — ${e.message}`);
        failed++;
      }
    }
    console.log(`\n${ok} resolved, ${failed} unresolved${APPLY ? "" : " — re-run with --apply to write"}.`);
    if (!APPLY && rows.length === 0) console.log("Nothing to do.");
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

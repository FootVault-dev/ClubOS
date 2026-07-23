// True-up weeks_paid / amount_paid for deposit_weekly registrations from
// Stripe — the same idempotent maths as advanceLeagueWeekly (sum of paid
// invoice money ÷ weekly amount, robust against $0 trial invoices).
//
// Needed once because the invoice.paid webhook read invoice.subscription on a
// post-basil API version (field moved to parent.subscription_details) and
// silently skipped every weekly advance; safe to re-run any time.
//
// Dry-run by default; --apply writes. Never cancels a subscription (that stays
// the webhook's job) — it only flags what WOULD be fully paid.
//   npx tsx script/resync-weekly-paid.ts            (report only)
//   npx tsx script/resync-weekly-paid.ts --apply    (write)
import "dotenv/config";
import { Pool } from "pg";
import Stripe from "stripe";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  if (!process.env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY not set");
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT id, team_name, stripe_subscription_id, weekly_amount_cents, weeks_total, weeks_paid, deposit_cents
      FROM registrations
      WHERE payment_mode = 'deposit_weekly' AND status = 'confirmed' AND stripe_subscription_id IS NOT NULL
      ORDER BY id`);
    console.log(`${rows.length} weekly registration(s)${APPLY ? "" : " (dry run)"}\n`);
    let changed = 0;
    for (const r of rows) {
      try {
        const invs = await stripe.invoices.list({ subscription: r.stripe_subscription_id, status: "paid", limit: 100 });
        const weeklyCents = r.weekly_amount_cents ?? 0;
        const totalPaid = invs.data.reduce((s, i) => s + (i.amount_paid || 0), 0);
        const weeksPaid = weeklyCents > 0 ? Math.round(totalPaid / weeklyCents) : invs.data.filter(i => (i.amount_paid || 0) > 0).length;
        const amountPaid = (((r.deposit_cents ?? 0) + weeksPaid * weeklyCents) / 100).toFixed(2);
        const fully = (r.weeks_total ?? 0) > 0 && weeksPaid >= (r.weeks_total ?? 0);
        const delta = weeksPaid !== r.weeks_paid;
        console.log(`  #${r.id} ${String(r.team_name).trim()}: ${r.weeks_paid} → ${weeksPaid}/${r.weeks_total} weeks paid ($${amountPaid} total)${fully ? " [FULLY PAID — webhook will flip on next event]" : ""}${delta ? (APPLY ? " ✓ written" : " (would write)") : " — already right"}`);
        if (delta && APPLY) {
          await client.query(
            `UPDATE registrations SET weeks_paid = $1, amount_paid = $2${fully ? ", balance_status = 'paid'" : ""} WHERE id = $3`,
            [weeksPaid, amountPaid, r.id]);
          changed++;
        } else if (delta) changed++;
      } catch (e: any) {
        console.log(`  #${r.id} ${String(r.team_name).trim()}: FAILED — ${e.message}`);
      }
    }
    console.log(`\n${changed} row(s) ${APPLY ? "updated" : "would change"}.`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

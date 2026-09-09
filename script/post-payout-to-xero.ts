// Post a Stripe payout into Xero, pre-split.
//
//   npx tsx --env-file=.env script/post-payout-to-xero.ts                 # plan the uncoded ones
//   npx tsx --env-file=.env script/post-payout-to-xero.ts po_1ABC --commit
//
// Dry run by default. Nothing reaches Xero without --commit.

import { planPayout, postPayout } from "../server/xero-payout-post";
import { listRecentPayouts } from "../server/xero-payout";
import { db } from "../server/db";
import { sql } from "drizzle-orm";

const money = (c: number) => (c / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const COMMIT = process.argv.includes("--commit");
const BY = process.env.USER || "daniel";

(async () => {
  const arg = process.argv[2];
  let ids: string[];
  if (arg && arg.startsWith("po_")) ids = [arg];
  else {
    // Default: whatever has not been posted yet, oldest first, so a catch-up run
    // lands in the order the bank statement shows them.
    const recent = await listRecentPayouts(12);
    const done = await db.execute(sql`SELECT stripe_payout_id FROM xero_payout_posts WHERE status='posted' AND stripe_account='club'`);
    const seen = new Set((done.rows as any[]).map(r => r.stripe_payout_id));
    ids = recent.filter(p => !seen.has(p.id)).map(p => p.id).reverse();
  }

  for (const id of ids) {
    const plan = await planPayout(id);
    console.log(`\n${"─".repeat(72)}`);
    console.log(`${plan.arrivalDate}   ${plan.currency} ${money(plan.payoutCents)}   ${plan.payoutId}`);
    if (plan.alreadyPosted) { console.log(`  already posted as ${plan.alreadyPosted.xeroBankTxnId} — skipping`); continue; }
    console.log(`${"─".repeat(72)}`);
    console.log(`  Receive Money · contact "Stripe Payments" · bank 147 · GST inclusive`);
    for (const l of plan.lines)
      console.log(`    ${l.accountCode.padEnd(9)} ${l.taxType.padEnd(8)} ${money(l.amountCents).padStart(11)}   ${l.description}`);
    console.log(`    ${"".padEnd(9)} ${"".padEnd(8)} ${"".padStart(11, "─")}`);
    console.log(`    ${"TOTAL".padEnd(9)} ${"".padEnd(8)} ${money(plan.lines.reduce((s, l) => s + l.amountCents, 0)).padStart(11)}`);

    if (plan.blockers.length) { console.log(`\n  ⛔ will not post:`); plan.blockers.forEach(b => console.log(`     - ${b}`)); continue; }
    if (!COMMIT) { console.log(`\n  ✅ ready — re-run with --commit to post`); continue; }

    const r = await postPayout(id, { by: BY });
    console.log(`\n  🟢 POSTED — ${r.url}`);
  }
  console.log();
  process.exit(0);
})().catch(e => { console.error("\nFAILED:", e?.message ?? e); process.exit(1); });

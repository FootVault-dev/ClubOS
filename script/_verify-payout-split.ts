// Read-only proof of the Stripe payout → Xero split.
//
// Walks real payouts, resolves every charge against ClubOS, and prints the split
// with the reconciliation. Touches nothing: no Xero call, no write, no Stripe
// mutation. This is what to run before believing the poster.
//
//   npx tsx --env-file=.env script/_verify-payout-split.ts [count]
//   npx tsx --env-file=.env script/_verify-payout-split.ts po_1ABC...

import { walkPayout, listRecentPayouts, PayoutNotSplittable } from "../server/xero-payout";

const money = (c: number) => (c / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  const arg = process.argv[2] ?? "5";
  const payoutIds = arg.startsWith("po_")
    ? [arg]
    : (await listRecentPayouts(Number(arg))).map(p => p.id);

  let failures = 0, totalUnresolved = 0, totalCharges = 0;

  const skipped: string[] = [];
  for (const id of payoutIds) {
    let walked;
    try { walked = await walkPayout(id); }
    catch (e) {
      if (e instanceof PayoutNotSplittable) { skipped.push(e.message); continue; }
      throw e;
    }
    const { split, items } = walked;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`${split.payoutId}   ${split.arrivalDate}   ${split.currency} ${money(split.payoutCents)}`);
    console.log("=".repeat(78));
    for (const l of split.lines) {
      const flag = l.category === "unallocated" ? " ← needs coding" : "";
      console.log(`  ${l.label.padEnd(38)} ${String(l.count).padStart(4)} × ${money(l.grossCents).padStart(11)}${flag}`);
    }
    console.log(`  ${"Stripe fees".padEnd(38)}      ${("-" + money(split.feeCents)).padStart(11)}`);
    if (split.stripeChargeCents) console.log(`  ${"Stripe account charges".padEnd(38)}      ${("-" + money(split.stripeChargeCents)).padStart(11)}`);
    if (split.reversalCents) console.log(`  ${"Returned payout (earlier, failed)".padEnd(38)}      ${money(split.reversalCents).padStart(11)}`);
    console.log(`  ${"-".repeat(60)}`);
    console.log(`  ${"Computed".padEnd(38)}      ${money(split.computedCents).padStart(11)}   ${split.balances ? "✅ equals the payout" : "❌ DOES NOT BALANCE"}`);

    if (!split.balances) failures++;
    totalUnresolved += split.unresolvedCount;
    totalCharges += items.length;

    const unknown = items.filter(i => i.category === "unallocated");
    if (unknown.length) {
      console.log(`\n  Unresolved (${unknown.length}) — each becomes one coding rule:`);
      for (const u of unknown.slice(0, 12)) {
        console.log(`    ${money(u.grossCents).padStart(9)}  ${u.type.padEnd(8)} ${u.paymentIntentId ?? "(no PI)"}  ${u.description ?? ""}`);
      }
      if (unknown.length > 12) console.log(`    … and ${unknown.length - 12} more`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${payoutIds.length} payouts · ${totalCharges} charges · ${totalUnresolved} unresolved · ${failures} not balancing`);
  if (skipped.length) { console.log(`\n${skipped.length} not splittable by Stripe (code by hand):`); skipped.forEach(s => console.log("  " + s)); }
  if (failures) { console.error("\n❌ A payout did not reconcile. Do not post."); process.exit(1); }
  console.log("✅ Every payout reconciles to the cent.");
  process.exit(0);
})().catch(e => { console.error("FATAL", e?.message ?? e); process.exit(1); });

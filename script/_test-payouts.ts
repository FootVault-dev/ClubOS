// Read-only E2E for the Payouts tab: lists real payouts on the club Stripe
// account, then explains the most recent PAID one through the exact production
// code path (explainPayout). Verifies completeness by reconciling the sum of
// every line's net against the payout amount — to the cent. Touches nothing:
// no Stripe writes, no DB writes.
//
// Run: npx tsx script/_test-payouts.ts [po_...] [--account cugc]
import "dotenv/config";
import { stripe } from "../server/stripe";
import { cugcStripe } from "../server/cugc-stripe";
import { explainPayout } from "../server/payout-routes";

const $ = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  const account = process.argv.includes("--account") && process.argv[process.argv.indexOf("--account") + 1] === "cugc" ? "cugc" as const : "club" as const;
  const client = account === "cugc" ? cugcStripe : stripe;
  const explicit = process.argv.find((a) => a.startsWith("po_"));

  const list = await client.payouts.list({ limit: 8 });
  console.log(`[${account}] latest payouts (hasMore=${list.has_more}):`);
  for (const p of list.data) {
    console.log(`  ${p.id}  ${p.status.padEnd(10)} ${$(p.amount).padStart(11)}  arrives ${new Date(p.arrival_date * 1000).toISOString().slice(0, 10)}`);
  }

  const target = explicit ? { id: explicit } : list.data.find((p) => p.status === "paid") ?? list.data[0];
  if (!target) {
    console.log("No payouts on this account — nothing to explain.");
    return;
  }

  console.log(`\n== explaining ${target.id} ==`);
  const t0 = Date.now();
  const d = await explainPayout(client, account, target.id);
  console.log(`took ${Date.now() - t0}ms · payout ${$(d.payout.amountCents)} ${d.payout.currency} arriving ${d.payout.arrivalDate} (${d.payout.status})`);
  console.log(`summary: ${d.summary.chargeCount} charges (${d.summary.resolvedCount} matched to people), ${d.summary.refundCount} refunds, ${d.summary.otherCount} other`);
  console.log(`         gross ${$(d.summary.grossCents)} · fees ${$(d.summary.feeCents)} · refunds ${$(d.summary.refundCents)}`);

  // Completeness proof: every line's net must sum to the payout, to the cent.
  const netSum = d.lines.reduce((s, l) => s + l.netCents, 0);
  const match = netSum === d.payout.amountCents;
  console.log(`reconcile: Σ line net = ${$(netSum)} vs payout ${$(d.payout.amountCents)} → ${match ? "MATCH ✅" : "MISMATCH ❌"}${d.truncated ? " (TRUNCATED >1000 lines)" : ""}`);

  console.log(`\nfirst lines:`);
  for (const l of d.lines.slice(0, 12)) {
    if (l.resolved) {
      console.log(`  [${l.kind}] ${l.when} · ${l.resolved.programme} · player=${l.resolved.player ?? "—"} · parent=${l.resolved.parent ?? "—"}${l.resolved.detail ? ` · ${l.resolved.detail}` : ""} · gross ${$(l.grossCents)} fee ${$(l.feeCents)} net ${$(l.netCents)}`);
    } else {
      console.log(`  [${l.kind}] ${l.when} · UNRESOLVED: ${l.description ?? "?"} (${l.payerName ?? l.payerEmail ?? "no payer info"}) · gross ${$(l.grossCents)}`);
    }
  }
  const unresolved = d.lines.filter((l) => l.kind === "charge" && !l.resolved);
  if (unresolved.length > 0) {
    console.log(`\nunresolved charges (${unresolved.length}):`);
    for (const u of unresolved.slice(0, 10)) console.log(`  ? ${u.description ?? "no description"} · ${u.payerName ?? ""} ${u.payerEmail ?? ""}`);
  }
  if (!match && !d.truncated) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  console.error(e);
  process.exit(1);
});

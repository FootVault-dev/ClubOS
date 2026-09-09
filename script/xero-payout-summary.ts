// What each category is actually worth, so Victor maps the ones that matter.
//
//   npx tsx --env-file=.env script/xero-payout-summary.ts [payoutCount]
//
// Read-only. Writes a CSV he can fill in and send back.

import fs from "node:fs";
import { walkPayout, listRecentPayouts, PayoutNotSplittable } from "../server/xero-payout";
import { XERO_CATEGORIES } from "@shared/xero-payout";

const money = (c: number) => (c / 100).toFixed(2);

(async () => {
  const n = Number(process.argv[2] ?? 60);
  const payouts = await listRecentPayouts(n);
  const tot = new Map<string, { gross: number; count: number }>();
  let fees = 0, payoutTotal = 0, walked = 0;
  let firstDate = "", lastDate = "";

  for (const p of payouts) {
    try {
      const { split } = await walkPayout(p.id);
      walked++;
      payoutTotal += split.payoutCents; fees += split.feeCents + split.stripeChargeCents;
      firstDate = firstDate && firstDate < split.arrivalDate ? firstDate : split.arrivalDate;
      lastDate = lastDate > split.arrivalDate ? lastDate : split.arrivalDate;
      for (const l of split.lines) {
        const e = tot.get(l.category) ?? { gross: 0, count: 0 };
        e.gross += l.grossCents; e.count += l.count; tot.set(l.category, e);
      }
    } catch (e) { if (!(e instanceof PayoutNotSplittable)) throw e; }
  }

  console.log(`\n${walked} payouts · ${firstDate} → ${lastDate}\n`);
  const rows = XERO_CATEGORIES.map(c => ({ c, t: tot.get(c.key) })).filter(x => x.t)
    .sort((a, b) => (b.t!.gross - a.t!.gross));
  console.log(`${"Category".padEnd(38)} ${"Charges".padStart(8)} ${"Gross".padStart(13)}`);
  for (const { c, t } of rows) console.log(`${c.label.padEnd(38)} ${String(t!.count).padStart(8)} ${money(t!.gross).padStart(13)}`);
  console.log(`${"Stripe fees".padEnd(38)} ${"".padStart(8)} ${("-" + money(fees)).padStart(13)}`);
  console.log(`${"".padEnd(38)} ${"".padStart(8)} ${"".padStart(13, "-")}`);
  console.log(`${"Banked".padEnd(38)} ${"".padStart(8)} ${money(payoutTotal).padStart(13)}`);

  const csv = ["category,label,charges,gross_nzd,xero_account_code,xero_tax_type,tracking_option,notes",
    ...rows.map(({ c, t }) => `${c.key},"${c.label}",${t!.count},${money(t!.gross)},,,,`)].join("\n");
  const out = `outputs/xero-payout-automation/category-map-for-victor.csv`;
  fs.mkdirSync("outputs/xero-payout-automation", { recursive: true });
  fs.writeFileSync(out, csv + "\n");
  console.log(`\nsaved ${out}`);
  process.exit(0);
})().catch(e => { console.error("FATAL", e?.message ?? e); process.exit(1); });

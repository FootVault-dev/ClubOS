// Derive the Stripe→Xero mapping from what Olga and Natalia already do by hand.
//
// Read-only. For each payout that has been hand-coded, put ClubOS's own view of
// what was sold beside the accounts they chose, and let the agreement (or the
// argument) be visible. The mapping this system posts must REPRODUCE their work.
//
//   npx tsx --env-file=.env script/_derive-payout-mapping.ts [count]

import { getXeroForOrg } from "../server/xero";
import { walkPayout, listRecentPayouts, PayoutNotSplittable } from "../server/xero-payout";

const m = (c: number) => (c / 100).toFixed(2);

(async () => {
  const payouts = await listRecentPayouts(Number(process.argv[2] ?? 30));
  const { xero, tenantId } = await getXeroForOrg(1);
  const accs = (await xero.accountingApi.getAccounts(tenantId)).body.accounts ?? [];
  const nameOf = new Map(accs.map(a => [a.code, a.name]));
  const bank = accs.find(a => a.code === "147")!;

  const live: any[] = [];
  for (let page = 1; page <= 12; page++) {
    const r = await xero.accountingApi.getBankTransactions(tenantId, undefined, `BankAccount.AccountID==Guid("${bank.accountID}")`, "Date DESC", page);
    const t = r.body.bankTransactions ?? []; live.push(...t); if (t.length < 100) break;
  }
  const coded = live.filter(x => /stripe/i.test(x.contact?.name ?? "") && String(x.status) === "AUTHORISED");

  // programme (or category) → account code → cents of agreement
  const ev: Record<string, Record<string, number>> = {};
  const note = (what: string, code: string, cents: number) => {
    ev[what] = ev[what] ?? {}; ev[what][code] = (ev[what][code] ?? 0) + Math.abs(cents);
  };

  let n = 0;
  for (const p of payouts) {
    let walked;
    try { walked = await walkPayout(p.id); } catch (e) { if (e instanceof PayoutNotSplittable) continue; throw e; }
    // 🔴 The SDK hands back a Date, so String(t.date) is "Mon Sep 07 2026 …" and
    // slicing it yields "Mon Sep 07" — which matches nothing and silently reports
    // zero comparisons rather than failing. Convert, never slice.
    const iso = (d: any) => new Date(d).toISOString().slice(0, 10);
    const hit = coded.find(t => Math.round(Number(t.total) * 100) === p.amountCents && iso(t.date) === p.arrivalDate);
    if (!hit) continue;
    n++;

    // What ClubOS says was sold, grouped by the PROGRAMME name (finer than the
    // eight categories — which is the granularity they actually code at).
    const byWhat: Record<string, number> = {};
    for (const it of walked.items) {
      const what = it.resolved?.description ?? (it.category === "unallocated" ? "(uncoded)" : it.category);
      byWhat[what] = (byWhat[what] ?? 0) + it.grossCents;
    }
    const theirs = (hit.lineItems ?? []).map((l: any) => ({ code: l.accountCode as string, cents: Math.round(Number(l.lineAmount) * 100) }));

    console.log(`${p.arrivalDate}  $${m(p.amountCents)}`);
    for (const [w, c] of Object.entries(byWhat).sort((a, b) => b[1] - a[1])) console.log(`    sold  ${m(c).padStart(10)}  ${w}`);
    for (const t of theirs) console.log(`    coded ${m(t.cents).padStart(10)}  ${t.code} ${nameOf.get(t.code) ?? ""}`);

    // Where exactly one thing was sold and exactly one income account used, the
    // pairing is unambiguous and is real evidence rather than a guess.
    const income = theirs.filter(t => t.code !== "484/01" && t.cents > 0);
    const sold = Object.entries(byWhat).filter(([, c]) => c > 0);
    if (sold.length === 1 && income.length === 1) { note(sold[0][0], income[0].code, income[0].cents); console.log(`    → EVIDENCE: "${sold[0][0]}" = ${income[0].code}`); }
    else {
      // Otherwise match on amount: a line whose value equals exactly one sold thing.
      for (const t of income) {
        const exact = sold.filter(([, c]) => c === t.cents);
        if (exact.length === 1) { note(exact[0][0], t.code, t.cents); console.log(`    → EVIDENCE (amount): "${exact[0][0]}" = ${t.code}`); }
      }
    }
    console.log();
  }

  console.log("=".repeat(76));
  console.log(`${n} payouts compared against their hand coding\n`);
  console.log("MAPPING, EVIDENCED BY THEIR OWN WORK\n");
  for (const [what, codes] of Object.entries(ev).sort((a, b) => Object.values(b[1]).reduce((x, y) => x + y, 0) - Object.values(a[1]).reduce((x, y) => x + y, 0))) {
    const ranked = Object.entries(codes).sort((a, b) => b[1] - a[1]);
    const conflict = ranked.length > 1 ? "   ⚠️ more than one account used" : "";
    console.log(`  ${what}${conflict}`);
    for (const [code, cents] of ranked) console.log(`      ${code.padEnd(9)} ${(nameOf.get(code) ?? "").padEnd(36)} $${m(cents)}`);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL", e?.message ?? e); process.exit(1); });

// Post one Stripe payout into Xero as a Receive Money, already split.
//
// 🔴 The document this builds is deliberately INDISTINGUISHABLE from the ones
// Olga and Natalia make by hand: type RECEIVE, contact "Stripe Payments", bank
// account 147, `Inclusive` line amounts, and the Stripe fee as a negative line
// on 484/01 with GST on Expenses. Their shape was read off their own most recent
// entry rather than assumed — a document that looks foreign is a document that
// gets deleted.
//
// 🔴 It is left UNRECONCILED on purpose. Xero cannot reconcile a bank line
// through the API and never will ("we do not plan to add this capability"), so
// the last step stays a human clicking OK against the bank statement line. That
// is also the safety: nothing is final until a person accepts it.

import Stripe from "stripe";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { getXeroForOrg } from "./xero";
import { walkPayout, type WalkedItem } from "./xero-payout";
import type { XeroCategoryKey } from "@shared/xero-payout";

const CONTACT_NAME = "Stripe Payments";
const BANK_CODE = "147";
const FEE_ACCOUNT = "484/01";
const FEE_TAX = "INPUT2";

export interface PostLine { accountCode: string; taxType: string; amountCents: number; description: string; }
export interface PostPlan {
  payoutId: string; arrivalDate: string; payoutCents: number; currency: string;
  lines: PostLine[];
  /** Anything that must be resolved by a human before this can post. */
  blockers: string[];
  alreadyPosted: { xeroBankTxnId: string | null; postedAt: string | null } | null;
}

/** Where does this item's money go? Programme first, then the category. */
async function loadMap(orgId: number) {
  const r = await db.execute(sql`
    SELECT category, program_id, xero_account_code, xero_tax_type, confirmed_by
      FROM xero_account_map WHERE organization_id = ${orgId}`);
  const byProgram = new Map<string, any>();
  const byCategory = new Map<string, any>();
  for (const row of r.rows as any[]) {
    if (row.program_id != null) byProgram.set(`${row.category}:${row.program_id}`, row);
    else byCategory.set(row.category, row);
  }
  return { byProgram, byCategory };
}

/**
 * Build the document without sending it. Every refusal is collected rather than
 * thrown, so one run tells a human everything they have to fix instead of one
 * thing at a time.
 */
export async function planPayout(payoutId: string, orgId = 1): Promise<PostPlan> {
  const { split, items } = await walkPayout(payoutId);
  const map = await loadMap(orgId);
  const blockers: string[] = [];

  if (!split.balances) blockers.push(`the split does not reconcile: computed $${(split.computedCents / 100).toFixed(2)} against a payout of $${(split.payoutCents / 100).toFixed(2)}`);
  if (split.reversalCents) blockers.push(`this batch contains a returned earlier payout of $${(split.reversalCents / 100).toFixed(2)} — a bank transfer, not income. Code this one by hand.`);

  // Group by the account each item resolves to, summing refunds against sales in
  // the same account exactly as a hand-coded entry does.
  const groups = new Map<string, { account: string; tax: string; cents: number; what: Set<string>; n: number }>();
  for (const it of items as WalkedItem[]) {
    const cat = it.category as XeroCategoryKey;
    const progId = (it.resolved as any)?.programId ?? null;
    const rule = (progId != null && map.byProgram.get(`${cat}:${progId}`)) || map.byCategory.get(cat);
    if (!rule?.xero_account_code) {
      const label = it.resolved?.description ?? cat;
      const msg = `nothing tells us where "${label}" goes ($${(it.grossCents / 100).toFixed(2)})`;
      if (!blockers.includes(msg)) blockers.push(msg);
      continue;
    }
    const key = `${rule.xero_account_code}|${rule.xero_tax_type}`;
    const g = groups.get(key) ?? { account: rule.xero_account_code, tax: rule.xero_tax_type, cents: 0, what: new Set<string>(), n: 0 };
    g.cents += it.grossCents; g.n++;
    if (it.resolved?.description) g.what.add(it.resolved.description);
    groups.set(key, g);
  }

  const lines: PostLine[] = [];
  for (const g of Array.from(groups.values()).sort((a, b) => b.cents - a.cents)) {
    if (g.cents === 0) continue;   // a sale fully refunded in the same payout nets to nothing
    const what = Array.from(g.what).slice(0, 2).join(", ") || "Stripe";
    lines.push({ accountCode: g.account, taxType: g.tax, amountCents: g.cents,
      description: `${what}${g.n > 1 ? ` — ${g.n} payments` : ""}`.slice(0, 200) });
  }
  const feeCents = split.feeCents + split.stripeChargeCents;
  if (feeCents) lines.push({ accountCode: FEE_ACCOUNT, taxType: FEE_TAX, amountCents: -feeCents, description: "Stripe fee" });

  // 🔴 The document must add up to the payout to the cent, or the bank line will
  // never match it and someone is left with a half-finished entry to unpick.
  const lineTotal = lines.reduce((s, l) => s + l.amountCents, 0);
  if (lines.length && lineTotal !== split.payoutCents)
    blockers.push(`the lines total $${(lineTotal / 100).toFixed(2)} but the payout is $${(split.payoutCents / 100).toFixed(2)}`);

  const prior = await db.execute(sql`
    SELECT xero_bank_txn_id, posted_at, status FROM xero_payout_posts
     WHERE stripe_payout_id = ${payoutId} AND stripe_account = 'club'`);
  const p: any = (prior.rows as any[])[0];

  // 🔴 THE GUARD THAT MATTERS MOST. Our own table only knows what WE posted. Olga
  // and Natalia have been coding these by hand all year, and a payout they have
  // already done would otherwise be posted a second time — two Receive Moneys for
  // one deposit, one of which can never reconcile, silently inflating income.
  // So ask XERO whether an entry for this exact payout already exists, every time.
  const existing = await findExistingEntry(orgId, split.arrivalDate, split.payoutCents);
  if (existing) blockers.push(`Xero already has an entry for this payout on ${split.arrivalDate} for $${(split.payoutCents / 100).toFixed(2)} (${existing}) — almost certainly coded by hand. Posting again would duplicate the deposit.`);

  return {
    payoutId, arrivalDate: split.arrivalDate, payoutCents: split.payoutCents, currency: split.currency,
    lines, blockers,
    alreadyPosted: p && p.status === "posted" ? { xeroBankTxnId: p.xero_bank_txn_id, postedAt: p.posted_at } : null,
  };
}

/**
 * Is there already a bank transaction in Xero for this payout?
 *
 * Matched on the bank account, the date and the exact amount — the same three
 * things a person uses to recognise it on the reconcile screen. Deliberately
 * does NOT require our reference, because a hand-coded entry has none.
 */
async function findExistingEntry(orgId: number, arrivalDate: string, payoutCents: number): Promise<string | null> {
  const { xero, tenantId } = await getXeroForOrg(orgId);
  const accs = (await xero.accountingApi.getAccounts(tenantId)).body.accounts ?? [];
  const bank = accs.find(a => a.code === BANK_CODE);
  if (!bank) return null;
  const res = await xero.accountingApi.getBankTransactions(
    tenantId, undefined,
    `BankAccount.AccountID==Guid("${bank.accountID}") AND Date==DateTime(${arrivalDate.slice(0,4)},${Number(arrivalDate.slice(5,7))},${Number(arrivalDate.slice(8,10))})`);
  for (const t of res.body.bankTransactions ?? []) {
    if (String(t.status) !== "AUTHORISED") continue;
    if (Math.round(Number(t.total) * 100) !== payoutCents) continue;
    return `${t.bankTransactionID} "${t.contact?.name ?? ""}"`.trim();
  }
  return null;
}

/** Send it. Refuses on any blocker, and refuses to post the same payout twice. */
export async function postPayout(payoutId: string, opts: { orgId?: number; by: string }): Promise<{ xeroId: string; url: string }> {
  const orgId = opts.orgId ?? 1;
  const plan = await planPayout(payoutId, orgId);
  if (plan.alreadyPosted) throw new Error(`${payoutId} was already posted as ${plan.alreadyPosted.xeroBankTxnId}`);
  if (plan.blockers.length) throw new Error(`refusing to post ${payoutId}:\n  - ${plan.blockers.join("\n  - ")}`);
  if (!plan.lines.length) throw new Error(`${payoutId} has no lines to post`);

  // Claim the payout BEFORE calling Xero. The unique index is what stops two
  // runs creating two documents for the same money; claiming after the call
  // would leave a real Xero document with no record of it here.
  await db.execute(sql`
    INSERT INTO xero_payout_posts (organization_id, stripe_payout_id, stripe_account, arrival_date, currency, payout_cents, split_json, status)
    VALUES (${orgId}, ${payoutId}, 'club', ${plan.arrivalDate}, ${plan.currency}, ${plan.payoutCents}, ${JSON.stringify(plan)}::jsonb, 'pending')
    ON CONFLICT (stripe_account, stripe_payout_id) DO UPDATE SET split_json = EXCLUDED.split_json, updated_at = now()
    WHERE xero_payout_posts.status <> 'posted'`);

  const { xero, tenantId } = await getXeroForOrg(orgId);
  try {
    const res = await xero.accountingApi.createBankTransactions(tenantId, {
      bankTransactions: [{
        type: "RECEIVE" as any,
        contact: { name: CONTACT_NAME },
        bankAccount: { code: BANK_CODE },
        date: plan.arrivalDate,
        lineAmountTypes: "Inclusive" as any,
        reference: `Stripe payout ${plan.payoutId}`,
        lineItems: plan.lines.map(l => ({
          description: l.description, accountCode: l.accountCode, taxType: l.taxType,
          quantity: 1, unitAmount: l.amountCents / 100,
        })),
      }],
    });
    const created = res.body.bankTransactions?.[0];
    const id = created?.bankTransactionID;
    if (!id) throw new Error("Xero accepted the call but returned no transaction id");
    await db.execute(sql`
      UPDATE xero_payout_posts SET status='posted', xero_bank_txn_id=${id}, posted_at=now(), posted_by=${opts.by}, error=NULL, updated_at=now()
       WHERE stripe_payout_id=${payoutId} AND stripe_account='club'`);
    return { xeroId: id, url: `https://go.xero.com/Bank/ViewTransaction.aspx?bankTransactionID=${id}` };
  } catch (e: any) {
    const detail = e?.response?.body ? JSON.stringify(e.response.body).slice(0, 900) : (e?.message ?? String(e));
    await db.execute(sql`
      UPDATE xero_payout_posts SET status='failed', error=${detail}, updated_at=now()
       WHERE stripe_payout_id=${payoutId} AND stripe_account='club'`);
    throw new Error(detail);
  }
}

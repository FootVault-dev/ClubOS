// MFL instalment balance collection.
//
// When a team captain registers with the "pay in two" option, we take a
// deposit now (saving their card on file) and schedule the balance for ~3
// weeks later. This cron sweeps for balances that are due and charges the
// saved card off-session.
//
// Money-safety design (Stripe is the source of truth, never double-charge):
//   - A balance can only be charged by ONE actor at a time. `claimBalance`
//     atomically flips an eligible row to `charging` (conditional UPDATE …
//     RETURNING) — only one concurrent caller wins; both the cron and the
//     manual-pay endpoint go through it.
//   - Every charge carries a per-attempt idempotency key.
//   - A row stuck in `charging` (lost/late webhook) is reconciled against
//     Stripe: if the PI actually succeeded we mark it paid, otherwise we
//     release it back to `scheduled` for a clean retry.

import { db } from "./db";
import { registrations, leagueTeams, type Registration } from "@shared/schema";
import { eq, and, or, ne, lt, lte, inArray } from "drizzle-orm";
import { storage } from "./storage";
import { createOffSessionPaymentIntent, retrievePaymentIntent, stripe } from "./stripe";
import { sendLeagueBalancePaidEmail, sendLeagueBalanceFailedEmail } from "./email";
import { sendPurchaseEvent } from "./meta-capi";

const PUBLIC_BASE_URL = process.env.MFL_PUBLIC_URL || "https://join.minifootball.co.nz";
const MAX_BALANCE_ATTEMPTS = 4;
const STALE_CHARGING_MS = 15 * 60 * 1000; // a charge in flight longer than this is reconciled

/**
 * Atomically claim a balance for charging. Flips an eligible row to `charging`
 * and stamps balanceChargeStartedAt. Returns the claimed row, or null if it
 * wasn't claimable (already paid, mid-charge by someone else, or over the
 * attempt cap when enforced). Used by BOTH the cron and the manual endpoint so
 * the two can never charge concurrently.
 */
export async function claimBalance(
  registrationId: number,
  opts: { enforceAttemptCap?: boolean } = {},
): Promise<Registration | null> {
  const staleBefore = new Date(Date.now() - STALE_CHARGING_MS);
  const conds = [
    eq(registrations.id, registrationId),
    // 'installment' = the cron-charged single balance; 'deposit_weekly' = a
    // customer choosing to pay off their remaining weekly plan in full (the
    // subscription is cancelled on success in handleLeagueBalanceSuccess).
    inArray(registrations.paymentMode, ["installment", "deposit_weekly"]),
    ne(registrations.balanceStatus, "paid"),
    or(
      inArray(registrations.balanceStatus, ["scheduled", "failed"]),
      and(eq(registrations.balanceStatus, "charging"), lt(registrations.balanceChargeStartedAt, staleBefore)),
    ),
  ];
  if (opts.enforceAttemptCap) conds.push(lt(registrations.balanceAttempts, MAX_BALANCE_ATTEMPTS));

  const claimed = await db
    .update(registrations)
    .set({ balanceStatus: "charging", balanceChargeStartedAt: new Date() })
    .where(and(...conds))
    .returning();
  return claimed[0] ?? null;
}

/** Balance instalment collected (off-session or via manual link). Idempotent. */
export async function handleLeagueBalanceSuccess(registrationId: number, balancePaymentIntentId?: string) {
  const reg = await storage.getRegistration(registrationId);
  if (!reg) return;
  if (reg.balanceStatus === "paid") return; // already done

  // deposit_weekly payoff: the customer just paid the remaining unpaid weeks in
  // one go, so cancel the weekly subscription (no more $X/week charges), mark
  // every week paid, and record the amount actually charged.
  const isWeekly = reg.paymentMode === "deposit_weekly";
  const weeklyC = reg.weeklyAmountCents ?? 0, wt = reg.weeksTotal ?? 0, wp = reg.weeksPaid ?? 0;
  const chargedCents = isWeekly ? Math.max(0, (wt - wp) * weeklyC) : (reg.balanceCents ?? 0);
  const amountPaidCents = isWeekly ? ((reg.depositCents ?? 0) + wt * weeklyC) : ((reg.depositCents ?? 0) + (reg.balanceCents ?? 0));

  await storage.updateRegistration(registrationId, {
    balanceStatus: "paid",
    amountPaid: (amountPaidCents / 100).toFixed(2),
    ...(isWeekly ? { weeksPaid: wt } : {}),
    ...(balancePaymentIntentId ? { balancePaymentIntentId } : {}),
  } as any);

  if (isWeekly && reg.stripeSubscriptionId) {
    try { await stripe.subscriptions.cancel(reg.stripeSubscriptionId); }
    catch (e) { console.error(`[MFL payoff] cancel sub ${reg.stripeSubscriptionId} failed:`, e); }
  }

  const [team] = await db.select().from(leagueTeams).where(eq(leagueTeams.registrationId, registrationId));
  if (team) await storage.updateLeagueTeam(team.id, { paymentStatus: "paid_in_full" } as any);

  const program = await storage.getProgram(reg.programId);
  const captain = await storage.getContact(reg.contactId);
  if (program && captain) {
    sendLeagueBalancePaidEmail({
      registrationId,
      programId: program.id,
      captainEmail: captain.email || "",
      captainName: captain.firstName,
      teamName: reg.teamName || "Your team",
      balancePaid: `$${(chargedCents / 100).toFixed(2)} NZD`,
    }).catch((e) => console.error("[MFL balance] paid email failed:", e));

    sendPurchaseEvent({
      registrationId,
      campId: program.id,
      totalCents: chargedCents,
      currency: reg.currency || "NZD",
      email: captain.email || "",
      phone: captain.phone || undefined,
      firstName: captain.firstName,
      lastName: captain.lastName,
      eventId: `mfl_balance_${registrationId}`,
      contentName: "MFL Term 3 Team Registration",
      contentIds: [program.slug || String(program.id)],
    }).catch((e) => console.error("[MFL balance] Purchase CAPI failed:", e));
  }
}

/** Balance charge failed — flag it and email the captain a manual-pay link. */
export async function handleLeagueBalanceFailed(registrationId: number) {
  const reg = await storage.getRegistration(registrationId);
  if (!reg) return;
  if (reg.balanceStatus === "paid") return;

  await storage.updateRegistration(registrationId, {
    balanceStatus: "failed",
    balanceAttempts: (reg.balanceAttempts ?? 0) + 1,
  });

  const program = await storage.getProgram(reg.programId);
  const captain = await storage.getContact(reg.contactId);
  if (program && captain) {
    sendLeagueBalanceFailedEmail({
      registrationId,
      programId: program.id,
      captainEmail: captain.email || "",
      captainName: captain.firstName,
      teamName: reg.teamName || "Your team",
      balanceDue: `$${((reg.balanceCents ?? 0) / 100).toFixed(2)} NZD`,
      payUrl: `${PUBLIC_BASE_URL}/league/balance/${registrationId}`,
    }).catch((e) => console.error("[MFL balance] failed email failed:", e));
  }
}

/** Charge one due balance off-session. Claims atomically first. */
async function chargeBalance(registrationId: number): Promise<void> {
  const reg = await claimBalance(registrationId, { enforceAttemptCap: true });
  if (!reg) return; // not claimable (already paid / mid-charge / over cap)

  const balanceCents = reg.balanceCents ?? 0;
  if (!reg.stripeCustomerId || !reg.stripePaymentMethodId || balanceCents <= 0) {
    console.warn(`[MFL balance] reg ${registrationId} has no saved card / no balance — marking failed`);
    await handleLeagueBalanceFailed(registrationId);
    return;
  }

  try {
    const pi = await createOffSessionPaymentIntent({
      customerId: reg.stripeCustomerId,
      paymentMethodId: reg.stripePaymentMethodId,
      amountCents: balanceCents,
      currency: reg.currency || "NZD",
      description: `MFL balance — Registration #${registrationId}`,
      metadata: {
        registrationId: String(registrationId),
        registrationType: "league_balance",
        programId: String(reg.programId),
      },
      idempotencyKey: `league-balance-${registrationId}-${reg.balanceAttempts ?? 0}`,
    });
    await storage.updateRegistration(registrationId, { balancePaymentIntentId: pi.id });

    // confirm:true charges synchronously when no SCA is needed. The webhook
    // will also fire; handleLeagueBalanceSuccess is idempotent.
    if (pi.status === "succeeded") {
      await handleLeagueBalanceSuccess(registrationId, pi.id);
    } else {
      // requires_action / processing → stays 'charging'; webhook or the
      // stale-charging reconciler resolves it.
      console.log(`[MFL balance] reg ${registrationId} PI ${pi.id} status=${pi.status} — awaiting webhook`);
    }
  } catch (e: any) {
    console.error(`[MFL balance] off-session charge failed for reg ${registrationId}:`, e?.message || e);
    await handleLeagueBalanceFailed(registrationId);
  }
}

/**
 * Reconcile rows stuck in 'charging' (lost or late webhook) against Stripe.
 * If the PI actually succeeded → mark paid; otherwise release to 'scheduled'
 * so the normal sweep retries cleanly. Never starts a new charge here.
 */
async function reconcileStaleCharging(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_CHARGING_MS);
  const stuck = await db
    .select()
    .from(registrations)
    .where(
      and(
        eq(registrations.paymentMode, "installment"),
        eq(registrations.balanceStatus, "charging"),
        lt(registrations.balanceChargeStartedAt, staleBefore),
      ),
    );
  for (const reg of stuck) {
    try {
      if (reg.balancePaymentIntentId) {
        const pi = await retrievePaymentIntent(reg.balancePaymentIntentId);
        if (pi.status === "succeeded") {
          await handleLeagueBalanceSuccess(reg.id, pi.id);
          continue;
        }
      }
      // No PI, or PI not successful → release for a clean retry. Guard so we
      // only release a row that is still the stale 'charging' we observed.
      await db
        .update(registrations)
        .set({ balanceStatus: "scheduled" })
        .where(and(eq(registrations.id, reg.id), eq(registrations.balanceStatus, "charging")));
      console.log(`[MFL balance] released stale charging reg ${reg.id} → scheduled`);
    } catch (e) {
      console.error(`[MFL balance] reconcile failed for reg ${reg.id}:`, e);
    }
  }
}

/** Find every instalment whose balance is due today (or overdue) and charge it. */
export async function sweepDueBalances(): Promise<void> {
  try {
    await reconcileStaleCharging();

    const today = new Date().toISOString().slice(0, 10);
    const due = await db
      .select()
      .from(registrations)
      .where(
        and(
          eq(registrations.paymentMode, "installment"),
          eq(registrations.balanceStatus, "scheduled"),
          lte(registrations.balanceDueDate, today),
          lt(registrations.balanceAttempts, MAX_BALANCE_ATTEMPTS),
        ),
      );
    if (due.length === 0) return;
    console.log(`[MFL balance] ${due.length} balance(s) due — charging…`);
    for (const reg of due) await chargeBalance(reg.id);
  } catch (e) {
    console.error("[MFL balance] sweep failed:", e);
  }
}

let started = false;

/** Start the recurring balance sweeper (idempotent — safe to call once on boot). */
export function startLeagueBalanceCron() {
  if (started) return;
  started = true;
  const intervalMs = parseInt(process.env.LEAGUE_BALANCE_CRON_INTERVAL_MS || "") || 30 * 60 * 1000;
  setTimeout(() => { sweepDueBalances(); }, 60 * 1000);
  setInterval(() => { sweepDueBalances(); }, intervalMs);
  console.log(`[MFL balance] cron started (every ${Math.round(intervalMs / 60000)} min)`);
}

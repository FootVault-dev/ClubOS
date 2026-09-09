// Post each day's Stripe payout into Xero, already split.
//
// 🔴 A SWEEP, not a webhook. A missed `payout.paid` delivery would leave a day
// uncoded with nothing to notice it; a sweep that re-reads recent payouts every
// hour simply picks it up next time. It is safe to run repeatedly because the
// poster refuses a payout that is already posted (a unique index) or that Xero
// already has a hand-coded entry for.
//
// 🔴 OFF unless XERO_PAYOUT_AUTOPOST=1 — the same doctrine as the Sporty and
// Xero invoice pushes. Code reaching production must not start writing to the
// club's ledger just because it was deployed.

import { listRecentPayouts, PayoutNotSplittable } from "./xero-payout";
import { planPayout, postPayout } from "./xero-payout-post";

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;   // hourly
const BOOT_DELAY_MS = 3 * 60 * 1000;        // let the app settle after a deploy
const LOOK_BACK = 8;                        // payouts, so a long weekend still catches up

async function notify(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch { /* a failed notification must never fail the sweep */ }
}

async function sweep() {
  let posted = 0;
  const blocked: string[] = [];
  try {
    const payouts = await listRecentPayouts(LOOK_BACK);
    // Oldest first, so a catch-up lands in the order the bank statement shows.
    for (const p of payouts.slice().reverse()) {
      try {
        const plan = await planPayout(p.id);
        if (plan.alreadyPosted) continue;
        // Already coded by a human, or an account nobody has agreed: both are
        // reasons to leave it alone, and only the second is worth reporting.
        if (plan.blockers.length) {
          const human = plan.blockers.some(b => b.includes("already has an entry"));
          if (!human) blocked.push(`${plan.arrivalDate} $${(plan.payoutCents / 100).toFixed(2)} — ${plan.blockers[0]}`);
          continue;
        }
        const r = await postPayout(p.id, { by: "auto" });
        posted++;
        console.log(`[xero-payout] posted ${p.id} (${p.arrivalDate}, $${(p.amountCents / 100).toFixed(2)}) → ${r.xeroId}`);
      } catch (e: any) {
        if (e instanceof PayoutNotSplittable) { blocked.push(e.message); continue; }
        blocked.push(`${p.arrivalDate} $${(p.amountCents / 100).toFixed(2)} — ${e?.message ?? e}`);
      }
    }
  } catch (e: any) {
    // 🔴 Reaching Stripe or Xero at all failed. This is the one that must be
    // shouted about: everything below it looks like "nothing to do".
    console.error("[xero-payout] sweep failed:", e?.message ?? e);
    await notify(`🔴 <b>Xero payout sweep failed</b>\n${String(e?.message ?? e).slice(0, 300)}`);
    return;
  }

  // 🔴 Silence is the failure mode here. A payout that refuses to post looks
  // exactly like a quiet day, so anything left behind is reported by name.
  if (blocked.length) {
    await notify(`⚠️ <b>Xero payout split — ${blocked.length} not posted</b>\n\n` +
      blocked.slice(0, 6).map(b => `• ${b}`).join("\n") +
      (blocked.length > 6 ? `\n• …and ${blocked.length - 6} more` : ""));
  }
  if (posted) console.log(`[xero-payout] sweep complete — ${posted} posted, ${blocked.length} left`);
}

export function startXeroPayoutCron(): void {
  if (process.env.XERO_PAYOUT_AUTOPOST !== "1") {
    console.log("[xero-payout] auto-post disabled (XERO_PAYOUT_AUTOPOST != 1) — payouts are posted by hand");
    return;
  }
  setInterval(sweep, SWEEP_INTERVAL_MS);
  setTimeout(sweep, BOOT_DELAY_MS);
  console.log("[xero-payout] auto-post enabled — hourly sweep armed");
}

# MFL Rewards Programs — Implementation Plan

**Created:** 2026-06-28 · **Author:** Daniel + Claude
**Source:** "Mini Football Leagues Rewards Programs" PDF (designed ~Jul 2025, when Daniel was MFL Coordinator Lead)
**Goal of the system (the "why"):** grow team numbers → revenue/profit; lift team retention → cut marketing spend; lift referee retention → better-quality refs, less churn/admin, better customer experience (refs are the #1 league complaint). ClubOS is now the enabler — replaces the spreadsheets Daniel + Isaac were going to track this on, and fully automates accrual + reward issuance.

---

## The three programs (from the PDF)

### 1. League Builders — referral / affiliate (drives TEAM GROWTH)
- Join → get a personal **10% discount code + invite link** to share.
- New team's **first** league signup via your code/link → **+3 Builder Points**; **each additional** league that referred person signs up to → **+1 Builder Point**.
- Tiers (cash commission **per new team** referred): Amateur 3pts/$100 · Semi-Pro 10/$120 · Pro 20/$150 · Champion 35/$200 · Legends 50/$250.
- Leaderboard.

### 2. Season Ticket Rewards — loyalty / RETENTION
- **+3 Team XP** every time your team signs up for a league.
- Tiers (reward unlocked): Amateur 3 = 10% "Frontrunner" discount · Semi-Pro 10 = 20% voucher · Pro 20 = **custom kit** · Champion 35 = 50% voucher · Legends 50 = 100% voucher.
- Future bonus XP: Goal of the Week etc.

### 3. Referee Rewards — staff RETENTION
- **+1 Ref Token** per game refereed (added biweekly); bonus tokens for courses / content / ref of the season.
- Tiers: Starter 25 = keep cards/coin/whistle · Kickoff 50 = keep ref kit · 100 Club 100 = base pay $24/game · VIP 250 = $25/game · Legends 500 = $26/game.

---

## What ClubOS already gives us (the enabler)
- **Discount codes** — `leagueDiscounts` + the code engine in `validate-discounts` / registration. Builders codes = scoped discount codes with an owner. Codes are already captured on registrations.
- **Registrations + contacts** — `registrations` (contactId, leagueDivisionId, registrationGroupId, codes), `contacts`. Accrual for Builders + Season Ticket hooks off **registration confirmed**.
- **Referee → game data** — `leagueGameReferees` (ref ↔ game) + `leagueGames`. Ref Tokens = count of refereed (completed) games. Ref identity via `users`/contacts.
- **Settlement hooks** — `handleLeagueRegistrationSuccess` / `settleSplitSession` already fire once per confirmed team — the natural accrual trigger.
- **Email (Resend) + MFL template** + the new **Mailer** for announcements.

## New data model (proposed, additive)
- `reward_members` — id, contactId/userId, organizationId, program ('builders'|'season'), points/xp, tier, builderCode, inviteToken, createdAt. (Or one row per program per member.)
- `reward_events` — id, memberId, program, type ('referral_first'|'referral_extra'|'team_xp'|'ref_token'|'bonus'), points, sourceRegistrationId/sourceGameId, note, createdAt. (Immutable ledger — points = SUM of events; idempotent per source.)
- `reward_commissions` (Builders) — id, memberId, registrationId, amountCents, tierAtEarning, status ('owed'|'paid'), paidAt.
- `reward_redemptions` (Season Ticket) — id, memberId, tier, rewardType, voucherCode (nullable), status ('issued'|'fulfilled'), createdAt. Custom kit = manual fulfilment flag.
- `ref_tokens` could reuse `reward_events` (program 'referee'); pay-rate tier optionally writes a ref pay field.
- `reward_tiers` config — program, name, threshold, rewardValue — so thresholds/rewards are tunable without code.

## Accrual automation (hooks)
- **Builders:** on registration confirmed → if it used a builder code (or invite token), award +3 (first league for that referred contact) or +1 (additional) to the code owner; create a `reward_commission` (owed) at the owner's current tier rate. Idempotent per registration.
- **Season Ticket:** on registration confirmed → +3 Team XP to the captain/contact; on crossing a tier → issue the reward (auto-generate a voucher discount code + email it; flag custom kit for manual).
- **Referee:** Ref Tokens = derived count of completed refereed games (+ manual bonus events). Tier crossing → unlock perk; pay-rate tiers optionally update the ref's per-game pay.

## Surfaces to build
- **Admin (MFL workspace, new "Rewards" tab):** Builders leaderboard + commission ledger (mark paid), Season Ticket tiers + redemptions (fulfil custom kit), Referee tiers + token adjustments (add bonus tokens). Tier config editor.
- **Member/ref-facing:** a tokened "My Rewards" page (points/tier/next reward + your builder code & invite link; refs see tokens/tier/perks). Surface the builder code in confirmation emails + via the Mailer.

---

## ✅ Phase 1 decisions — LOCKED (Daniel, 2026-06-28)
1. **Commission payout = account credit toward their own fees** (not cash). Builders accrue a credit balance redeemable against their own team/league fees. → build a credit ledger + (Phase 1b) redemption at registration checkout.
2. **Earned when the referred team's payment confirms** — the ledger marks credit earned at confirmation; automated. Admin can see balances.
3. **Enrolment = opt-in sign-up** — only people who join the program get a Builder code + invite link (not auto-all-captains). Build a join flow.
4. **The 10% builder code STACKS with early-bird** — both discounts apply (e.g. 10% builder + 20% early-bird). Builder codes must be created as stackable percentage discounts in the discount engine.
5. Commission rate = owner's tier at the time the referred team signs up (tier rate snapshotted onto the event).

## ⚠️ Still-open decisions (Phase 2/3, not blocking Phase 1)
- **Season Ticket:** XP per captain/contact vs per team name? Vouchers auto-generated one-time codes + expiry? Custom kit = manual fulfilment flag?
- **Referee:** confirm games source `leagueGameReferees` on completed games + ref identity; do pay-rate tiers feed a real ref-pay field or display-only; how are bonus tokens added?
- **Cross-cutting:** where members/refs see rewards (tokened "My Rewards" link / member portal / emails)?

**Season Ticket**
5. Track XP **per captain/contact** (survives team re-naming) or **per team name**?
6. Vouchers = **auto-generated one-time discount codes**, emailed on tier unlock? Any **expiry**?
7. "Custom kit" (Pro tier) = **manual fulfilment** flag in admin — OK?

**Referee**
8. Confirm the games-refereed source is `leagueGameReferees` on **completed** games, and how a ref is identified (a `users` ref role?).
9. Do the pay-rate tiers ($24→$26) **feed an actual ref-pay field/payroll**, or display-only for now?
10. How are **bonus tokens** (courses, ref of the season) added — admin action?

**Cross-cutting**
11. Where do members/refs **see** their rewards — a tokened public "My Rewards" link (like the split hub), the member portal, and/or in emails?

---

## Recommended phasing
- **Phase 1 — League Builders** (do first): most directly drives the #1 goal (team growth → revenue), and builds on the existing discount-code + registration-attribution infra. Deliver: builder enrolment + code/invite-link generation, referral attribution on confirmed registrations, points + tiers + leaderboard, commission ledger (owed → mark paid), member "My Builder" page, and surface the code in confirmation emails / Mailer.
- **Phase 2 — Season Ticket Rewards** (retention): XP accrual + auto-voucher issuance + tier view + custom-kit fulfilment.
- **Phase 3 — Referee Rewards** (ref retention): token accrual from games + tiers + perks + pay-rate integration + ref tier view.

Each phase is independently valuable and shippable, gated/flagged for safe rollout (same pattern as Player Pay).

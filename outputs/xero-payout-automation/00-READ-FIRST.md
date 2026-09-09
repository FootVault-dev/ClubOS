# Stripe payouts → Xero, pre-split

Built 2026-09-09. Every Stripe payout is resolved to what ClubOS actually sold, so
the accounts team sees one bank line already broken down by category instead of
opening every transaction inside it.

**Status: the read-only half is BUILT and PROVEN against live data. Nothing posts
to Xero yet, and nothing can — ClubOS has no Xero connection and no category has
an account code.** Both are deliberate gates, below.

## Proven against real money

`npx tsx --env-file=.env script/_verify-payout-split.ts 40`

| | |
|---|---|
| Payouts walked | 55 (15 Apr → 9 Sep 2026) |
| Charges resolved | 489 |
| Not balancing | **0** |
| Uncoded | 13 charges, **$5.34 total** — all $1 card tests |
| Banked across the period | $54,211.04 |

Category totals and the sheet for Victor: `category-map-for-victor.csv`.

## How it works

1. Stripe says a payout landed.
2. Every charge, refund and fee inside it is read (paged to the end).
3. Each charge's **PaymentIntent** is matched against the 13 ClubOS tables that
   store one, in a single query, with the programme joined in.
4. The category is decided in ONE function, `categoriseResolved` in
   `shared/xero-payout.ts`.
5. The split is built and checked: gross − fees − Stripe charges + returned
   payouts must equal the payout to the cent, or nothing posts.

## What live data forced, that a design on paper would have missed

- 🔴 **Charge metadata is nearly always empty.** Stripe does not copy
  PaymentIntent metadata onto the charge — 9 of 11 charges in one payout carried
  none. Resolution is by PaymentIntent against our own tables, which is
  authoritative anyway. A metadata-driven resolver would have filed most of every
  payout as unknown.
- 🔴 **The programme type strings are `academy` · `holiday_camp` · `league_team`.**
  The first draft guessed `camp` and `league`, and filed every camp and league
  entry as "academy other" — a wrong category that still balances perfectly, which
  is the failure mode worth fearing here. Checked against the database, not
  assumed.
- 🔴 **A subscription renewal is not stored on the registration.** Only the first
  payment's PaymentIntent is; every weekly MFL charge after it is a PaymentIntent
  ClubOS has never seen. The subscription's own metadata carries the
  `registrationId` we wrote, so stage two reads back our own record rather than
  inferring one. Without it every league weekly payment would be uncoded forever.
- 🔴 **A batch can hold more than one payout row.** When an earlier payout fails,
  the money returns inside a later batch as a second payout row. On
  `po_1U68BI…` ignoring it made the split read −$604.48 against a real payout of
  $1,136.51. Skipping "the payout row" by type alone loses it; only this payout's
  own row is the transfer being explained.
- 🔴 **Stripe refuses to break down an auto-debit** (money taken from the bank to
  cover a negative balance). One exists on this account. It is reported by name
  and never posted, rather than read as an empty payout.
- ⚠️ **Two registrations share one PaymentIntent** (`pi_3Tpm22…`) — logged as a
  double match. Worth a look; it is a duplicate registration, not a posting bug.

## The gates

1. 🟢 **DONE 2026-09-09 — ClubOS is connected to Xero.** `script/connect-xero.ts`,
   proven by `script/_verify-xero-connection.ts` (10/10): the chart reads back
   359 accounts, 14 bank accounts, Victor's 10 new ones, the Funding tracking
   category and 8 tax rates, all through the same `getXeroForOrg()` the poster
   will use.
   - 🔴 **This app is on Xero's GRANULAR scopes.** The broad ones are refused with
     `invalid_scope` before the user can even press Allow:
     `accounting.transactions`, `accounting.transactions.read`,
     `accounting.reports.read`, `accounting.journals.read`. Those are exactly what
     `server/xero.ts` asked for, which is why its built-in connect flow had never
     connected anything. The write scope for a Receive Money is
     **`accounting.banktransactions`**.
   - 🔴 **The refresh token lives in `org_integrations`, not `.env`.** ClubOS owns
     its own chain, so the DataOS collector's token is untouched — verified after
     the fact: the daily P&L call still works. Two chains, neither rotating the
     other's.
   - ⚠️ **Deploy prerequisite:** prod ClubOS needs `XERO_CLIENT_ID` and
     `XERO_CLIENT_SECRET` as Fly secrets or `getXeroForOrg()` cannot refresh. They
     were added to the local `.env`; the Fly side is unverified (no CLI login).
2. **Victor: fill in `category-map-for-victor.csv`** — an account code, a tax
   type and a tracking option per category. Eight categories carry real money;
   the rest are tiny or zero.
   🔴 Seeded deliberately **blank**. A guessed account code still balances, so it
   would never be noticed. The poster refuses a category nobody has confirmed.

## Files

| Path | What |
|---|---|
| `shared/xero-payout.ts` | The category decider and the split builder. No Xero codes. |
| `server/xero-payout.ts` | The walker: Stripe → resolved → split. Read-only. |
| `script/_verify-payout-split.ts` | The proof. Run it before believing anything. |
| `script/xero-payout-summary.ts` | Category totals + Victor's CSV. |
| `script/apply-xero-payout.ts` | Migration, `--dry-run` by default, 18 checks. |
| `script/seed-xero-payout-map.ts` | Seeds the categories (blank) and the rules. |
| `migrations/2026-09-09_xero_payout_posting.sql` | 3 tables. **APPLIED.** |

## The tables, and why

- `xero_account_map` — category → Xero account. **Victor edits rows, nobody
  deploys.** NULL means "nobody has said yet", never a default account.
- `xero_payout_rules` — for charges no ClubOS table owns, i.e. another app
  billing the same Stripe account. The CIC Content Marketplace was 16 of the 18
  originally unresolved charges and is now one row. Matching is a description
  **prefix** with a minimum length, so a customer cannot land in a category by
  naming their team after one.
- `xero_payout_posts` — what was posted. **One post per payout per Stripe
  account, enforced by a unique index**, which is what makes a re-run a retry
  rather than a second Receive Money in Xero for the same money. `posted` cannot
  be set without the Xero document id.

## Still to build (the posting half)

The Receive Money poster itself, a preview in the Coding Budget tab, and the
webhook branch on `payout.paid`. All of it is blocked on the two gates above, and
none of it changes the walker — which is why the walker was built and proven
first.

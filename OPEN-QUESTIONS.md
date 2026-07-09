# Open questions — accounting sub-ledger Phase 1

Recorded rather than guessed. Each names who must answer.

## From the build

1. **Bookings and print orders will not post, even once enabled.** `server/routes.ts` passes
   `programId: 0` for `sourceType: "booking"` and `"print"` (they have no `programs` row). That
   falls through to the programme-*type* tier of `resolve()`, which is correct — but **no mapping
   rules exist for `venue_booking` or `print`**, so `resolve()` throws `AcctMappingError`, the hook
   swallows it, and nothing is written. This is intended for the MFL beta and must not be mistaken
   for coverage. → *Daniel, when the beta widens.*

2. **`occurredAt` is `nzTodayIso()` (the processing date), not the Stripe event time.** A webhook
   processed after midnight NZ dates the posting to the wrong day. Low impact while dry-run; must
   be the PaymentIntent's `created` timestamp before Phase 3. → *Daniel.*

3. **Gross only — no fee/net split yet.** T6 (Stripe balance transaction) is not built, so
   `fee_cents`/`net_cents` are unpopulated. The gross/net invariant cannot be asserted until then.

4. **`shop_orders` is not hooked.** It lives on the unmerged `feat/mfl-shop` branch, so MFL and CIC
   store revenue is outside this pipeline entirely. → *Daniel: merge order.*

## Needed from humans before Phase 3 can post anything

5. **Xero account codes** for every income line. `resolve()` throws without them, by design.
   → *Victor Zoubkov.*
6. **A Stripe clearing account in Xero.** Posting gross revenue against a bank account can never
   reconcile, because Stripe settles net of its fee. → *Victor.*
7. **Ex-GST or incl-GST** on every fee, and the GST treatment per revenue type (grants, donations,
   sponsorship, facility hire, subscriptions). → *Victor.*
8. **Is owner funding a gift, a loan, or equity?** Unanswered since 2 July. Decides whether
   ~$300–600k/yr is income at all. → *Victor + Slava.*
9. **Where does First Team (43) / SIU (44) income go?** No income code exists for either.
   → *Slava + Victor.*
10. **The 116 `PLACEHOLDER` subcategories** — approve, replace, or delete. Nobody has authorised them.
    → *Slava + Victor.*
11. **Frozen budget or rolling forecast?** Ryan and Slava disagreed flatly and never resolved it.
    It decides what Phase 2 is. → *Ryan + Slava.*

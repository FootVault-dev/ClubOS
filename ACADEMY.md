# Academy registrations — the Great Reset

CUFC's academy programmes move off **Friendly Manager** onto ClubOS: parents
register and pay on our own domain, with our own embedded checkout, and the
registration appears in ClubOS the instant it's created.

**Status (2026-07-10):**
- ✅ Migration **APPLIED to prod** (18 objects verified).
- ✅ Programmes **seeded in prod** with real fees. Five sell; two are closed.
- ✅ `cufc.co.nz` shows the real prices + a Goalkeeper landing page.
- ❌ **ClubOS code NOT deployed** — Fly's builder is failing (`deadline_exceeded`
  on depot, `unauthorized` on the legacy builder). `/api/public/academy/*` is 404
  in prod. Retry: `./deploy.sh --no-cache` from `feat/proposals-tracker-search`.
- ✅ Because `VITE_USE_CLUBOS_REGISTRATION` is **off**, the live site's Register
  buttons still point at Friendly Manager. Nothing links to a dead endpoint.
- ❗ **No payment has ever been taken through this code.** Put a real card through
  a $1 option and refund it before the flag is flipped.

---

## The one thing to understand first

**A programme can only charge once a human has typed a real fee in.** That has now
been done for five of the seven, each from a source recorded in
`script/seed-cufc-academy.ts`:

| Programme | Fee (per term) | Sells? |
|---|---|---|
| FUNiño U4–U8 (`u4-u8`) | **$160** | 🟢 |
| Pre-Academy (`pre-academy-u9-u12`) | **$405** (U9–U10) · **$540** (U11–U12) | 🟢 |
| Academy (`academy-u13-u17`) | **$805** (U13–U15) · **$882** (U17) | 🟢 |
| Technification (`technification`) | **$150** | 🟢 |
| Morning Programme | **$125** | 🟢 |
| **Goalkeeper** | no trustworthy source | 🔴 waitlist |
| **High Performance** | two club pages contradict each other | 🔴 waitlist |

Goalkeeper: the only figure anywhere ("$125, 10 Sessions") sits under a
*"Technification Program – Term 1"* heading, and the live Friendly Manager form
prices Technification at $150. It is not a goalkeeper fee.
High Performance: its own page says $600/term; the Academy page prices U17 at
$882/term.

**⚠ NOT COLLECTED AT CHECKOUT:** the Affiliation Fee ($58.08–$64.16 by grade), MF
levies, and the compulsory uniform (~$260 for High Performance). The club's own
pages list these separately, marked "TBC". **If the club expects them alongside
the term fee, the checkout is under-collecting.** Raise with Ryan before the first
Academy or Pre-Academy registration lands.

**The gate still holds for anything unpriced:**

A programme sells only when **all three** are true:

1. `programs.is_active = true`
2. `programs.registration_open = true`
3. it has at least one **active** `program_options` row with `full_price_cents > 0`

The seed script creates every programme with all three **off** and prices at `$0`.
This is deliberate. The club's Membership & Payment Policy 2026 says:

> "Fees published in the official printed fee schedule held at the CUFC office
> shall prevail over all other communications, including emails, brochures, or
> verbal information."

That schedule is not in this repo, and the three sources that are disagree:

| Programme | old cufc.co.nz | new site copy | internal model |
|---|---|---|---|
| FUNiño U4–U8 | $160/term | $160/term | $160/term |
| Pre-Academy U9–U10 | **$405**/term | "from $400" | ~$400 |
| Pre-Academy U11–U12 | **$540**/term | "from $400" | $450–500 |
| Academy U13–U17 | **$805**/term (and a $882 tier) | "from $700" | $700–800 |
| Technification | $150/term | $150/term | — |
| Goalkeeper | $125 / 10 sessions | not listed | — |

Per policy, **only the GM (Ryan Edwards) may approve fees.**

---

## Go-live runbook

Do these **in order**. Step 1 before step 4 is not optional — the new columns are
in `shared/schema.ts`, so a deploy without the migration makes every
`programs` / `contacts` / `registrations` read reference columns that don't
exist, and the admin app blanks out.

```bash
cd apps/clubos

# 1. Migrate prod (additive only; verifies every column/table, exits 1 if any missing)
npx tsx --env-file=.env script/apply-academy-registrations.ts

# 2. Create the programmes as drafts — dry run first, it prints exactly what it would write
npx tsx --env-file=.env script/seed-cufc-academy.ts
npx tsx --env-file=.env script/seed-cufc-academy.ts --commit

# 3. Deploy (from the ONE canonical deploy branch, after merging this one — see D16)
./deploy.sh
curl -sI https://app.usg.co.nz/t.js   # must be application/javascript, not text/html
```

**4. Enter the real fees** — `/admin/academy` → open a programme → set each
option's price → activate the options → tick **Active** and **Registrations open**.

**5. Test one real registration end-to-end** with a real card on a $1 option,
then refund it. Do not skip this. Nothing in this build has ever spoken to Stripe.

**6. Flip the website** — set `VITE_USE_CLUBOS_REGISTRATION=1` on the
`cufc-website` Vercel project and redeploy. The Register buttons swap from
Friendly Manager to `join.cufc.co.nz/academy/<slug>`.

⚠ **Do not do step 6 until step 5 passes.** Term 3's cash flow currently runs
through Friendly Manager.

---

## The $1 end-to-end test (do this before any ad spend)

**Code: `TECHTEST1`** — fixed $149.00 off, scoped to Technification only
(`applies_to='specific'`, `camp_ids=[5]`), **max 1 use**. $150.00 − $149.00 = **$1.00**.
It cannot discount any other programme.

1. Go to **https://cufc.co.nz/programmes/technification** → *Register for Term 3*.
   (Only Technification points at ClubOS. Everything else still goes to Friendly
   Manager — `VITE_CLUBOS_REGISTRATION_SLUGS` in `apps/cufc-website/src/site.ts`.)
2. You land on `join.cufc.co.nz/academy/technification?source=cufc-website`.
3. Fill the wizard with real data. On the consents step, enter **TECHTEST1** → *Apply*.
   It should say "$149.00 off. You'll pay $1.00."
4. Pay with a real card. **$1.00 NZD, live Stripe.**

### What to check afterwards

| Where | What must be true |
|---|---|
| ClubOS → CUFC → Registrations | The registration is there, status **confirmed** |
| ClubOS → Contacts | ONE guardian, ONE player, linked — not duplicates |
| The player's contact | country of birth, nationality, ethnicity/iwi all populated (the NZF audit fields) |
| The registration row | `discount_code = TECHTEST1`, `total_cents = 100`, `policy_version = 2026-01-01` |
| Your inbox | CUFC-branded confirmation email |
| Meta Events Manager | **ViewContent** on the programme page, **Purchase** value 1.00 NZD — **exactly one**, not two (the browser pixel and the server CAPI share the id `purchase_<registrationId>`, so Meta must dedupe them) |
| Stripe | one $1.00 charge. **Refund it.** |

### Then reset the code

`TECHTEST1` is single-use. To test again:
`UPDATE discounts SET times_used = 0 WHERE code = 'TECHTEST1';`

**Delete or disable it before the first ad runs** — a live code that takes $150 to
$1 is exactly the kind of thing that leaks.

### Only then

Turn on the ads. The pixel now fires **ViewContent** on the programme page and
**Purchase** on payment, both deduped, so a campaign can optimise on real
registrations rather than clicks. Roll the next programme onto ClubOS by adding its
slug to `VITE_CLUBOS_REGISTRATION_SLUGS` — but put a card through that one first too.

---

## The Mainland Football audit

Josh McGeer (Mainland Football) confirmed the club can switch systems internally,
but the **season's database audit is due end of July** and will be submitted from
Friendly Manager this year.

NZ Football's registration system (Sporty, which replaced COMET on 1 Jan 2026)
requires fields ClubOS did not have. Friendly Manager collects them today
(verified in `outputs/cufc-tilda-archive/friendlymanager/form-6.html`). This
migration adds them, and the signup form makes them **required**:

| Field | `contacts` column |
|---|---|
| Country of birth | `country_of_birth` |
| Place of birth | `place_of_birth` |
| Nationality | `nationality` (existed) |
| Ethnic group | `ethnicity` |
| Specific ethnic group / iwi | `sub_ethnicity` |
| Additional ethnicity (optional) | `ethnicity2` / `sub_ethnicity2` |

Stored as **free text, not an enum** — Sporty's exact accepted vocabulary has not
been confirmed with NZF, and this DB has a history of enum drift. The app
validates against `shared/academy.ts` → `NZF_ETHNICITIES` (Stats NZ level-1
classification: European · Māori · Pacific Peoples · Asian · MELAA · Other).

**Before the first Sporty sync, confirm those six values are what Sporty accepts.**
If they differ, change the constant — no migration needed. That was the point.

---

## Migrating the Friendly Manager history

`contacts.friendly_manager_id` and `registrations.legacy_source` /
`legacy_external_id` exist so the FM export can be reconciled against rows created
by the new flow. Both have partial unique indexes, so a re-run of the import is
idempotent.

The importer is **not written yet** — it needs the export to know its shape.

---

## Design decisions worth not re-litigating

**Age grades are years of birth, not ages.** NZF: "For the 2026 Season: 2017 is U9
Grade." So `grade = seasonYear − birthYear`. `shared/academy.ts` parses the ISO
date string directly and never constructs a `Date` — `new Date("2017-01-01")` in
NZ reads back as **2016**, which would misgrade every child born on 1 January.

**The 5% full-year discount is a training-fee discount.** The policy excludes
Technification, Goalkeeper, holiday programmes and camps — i.e. exactly
`academy_section = 'additional'`. `quoteAcademy()` throws rather than quietly
discounting an add-on. Those programmes sell by the term only.

**Money rounds the discount, never the total**, so `subtotal − discount === total`
exactly. Fuzzed over 1,800 price points in `script/test-academy.ts`.

**Pro-rata is live.** Joining five weeks into a ten-week term buys five sessions —
`termProgress()` in `shared/academy.ts`. The old `quoteProgram()` counted weeks to
the term's end date and added one, returning six: the parent paid for a session
that had already happened. It also derived "today" from `toISOString()`, which in
New Zealand (UTC+12/13) reports **yesterday** from midday onward. Both fixed; every
NZ date now comes from `nzTodayIso()`. One function, `academyQuoteFor()`, produces
both the quoted price and the charged price, so they cannot drift apart.

Term 3 2026 runs **20 Jul → 25 Sep**, so until 20 July everyone pays the full fee.

**The full-year plan is only offered in Term 1.** The policy grants the 5% for "all
four terms paid in one single payment at the start of the season"; a parent joining
in Term 3 would otherwise have bought two terms that already finished.

**Capacity counts pending registrations, but only for 30 minutes.** A seat held
mid-checkout is not a free seat — but an abandoned checkout is. `pending` rows are
never cleaned up, so counting all of them would let every parent who opened the
form and wandered off permanently consume a place, until a programme read "full"
with nobody enrolled. When a programme is full, the page shows the waitlist form.

> **Known limitation:** the capacity check is read-then-write, not a lock. Two
> parents submitting within the same instant on the last remaining place can both
> pass it and oversell by one. Fixing it properly needs a transaction with
> `SELECT … FOR UPDATE` on the programme row, or a partial unique index. It has
> been left alone because academy capacities are soft (a place is a coaching
> decision, not a seat) and the waitlist absorbs the overflow. Revisit if a
> programme is ever genuinely hard-capped.

**One child, one contact row.** The old class flow `INSERT`ed a new player contact
on every registration, so re-enrolling next term forked the child's history. The
academy endpoint finds the existing player via the guardian's relationships
(name + DOB) and updates them instead.

**Attribution tracks the parent, never the child.** AGENTS.md hard rule 4: no
child PII in any analytics event or Meta payload. `buildConversionAttribution` is
called with the guardian's details only, and the child's name is deliberately
absent from the Stripe PaymentIntent metadata.

**Checkout lives on `join.cufc.co.nz`, not `cufc.co.nz`.** Same registrable root,
so the first-party attribution cookie survives the hop; a cross-origin checkout on
the marketing site would drop it (see AGENTS.md T8 gotcha (b)). It also reuses the
proven Stripe → webhook → refund path rather than forking a second one. The parent
never sees a Stripe-hosted page — card fields are embedded and CUFC-branded.

---

## A bug this work uncovered

`POST /api/public/class-registrations/intent` called
`storage.getContactByEmail?.()` and `storage.createContactRelationship?.()`.
**Neither method has ever existed.** The optional-chaining swallowed both calls
silently, so every enrolment through that endpoint:

- created a **duplicate guardian contact** (the lookup always returned `undefined`), and
- **never wrote a guardian→child relationship row**.

The real names are `findContactByEmail` and `createRelationship`. Fixed in the
same commit as this feature. If that endpoint has taken live registrations, the
`contacts` table has duplicate guardians and orphaned player rows worth cleaning
up before the FM import lands on top of them.

---

## What is NOT built

- The Friendly Manager historical import (needs the export).
- The Sporty registration sync (NZF has not issued an API key — see
  `outputs/sporty-api-brief/BRIEF.md`).
- Payment plans beyond term / full-year. The policy also allows an "approved
  payment plan (conditions apply)" at the GM's discretion — those stay manual.
- Sibling discounts. **None exists in club policy.** Do not invent one.
- Scholarship / hardship application flow (policy: written application to the GM).
- An admin view of the academy waitlist (`academy_waitlist` is written, not yet
  surfaced in the UI).

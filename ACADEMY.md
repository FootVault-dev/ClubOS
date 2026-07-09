# Academy registrations — the Great Reset

CUFC's academy programmes move off **Friendly Manager** onto ClubOS: parents
register and pay on our own domain, with our own embedded checkout, and the
registration appears in ClubOS the instant it's created.

**Status: BUILT on branch `feat/academy-registrations`. Migration NOT applied.
NOT deployed. Nothing can take a payment yet — by design.**

---

## The one thing to understand first

**No programme can charge anybody until a human types the 2026 fee schedule in.**

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

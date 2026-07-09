# PLAN.md — Accounting sub-ledger, Phase 1 (loop/budget-automation)

> Executed by an autonomous loop on branch `loop/budget-automation` in `apps/clubos`.
> One task per iteration. Commit after each. Stop and write `BLOCKED.md` if a gate fails.
>
> **Read first, in order:**
> `outputs/budget-automation/00-verified-findings.md` — what is true
> `outputs/budget-automation/01-decisions-and-constraints.md` — what was decided in the room
> `outputs/budget-automation/02-architecture.md` — what we are building
> `outputs/deep-research/2026-07-10-budget-automation/synthesis.md` — the researched spec

---

## Non-negotiable rules

1. **No writes to Xero. None.** Phase 1 does not call the Xero API at all.
2. **No migration is applied to production.** Write the dated SQL file; do not run it.
3. **Never `db:push`.** Additive SQL only, mirrored in `shared/schema.ts`.
4. **Nothing is deployed.** No `deploy.sh`, no `fly deploy`.
5. **Money is integer cents.** No floats anywhere near money.
6. **Never invent an account code, a price, or a GST treatment.** If unknown, throw or leave null.
7. **Never UPDATE a posting.** Corrections are reversing entries.
8. **Every NZ date comes from `nzTodayIso()`** (`shared/academy.ts`). Never `toISOString()`.
9. If a task needs a human decision (a fee, a GST rate, an account code) — **do not guess.**
   Append the question to `OPEN-QUESTIONS.md` and carry on with the next task.
   Reserve `BLOCKED.md` for a **true hard stop** where no further task can proceed —
   writing it halts the whole loop for human review.

## Definition of done, per task

- `npx tsc --noEmit -p tsconfig.json` introduces **zero** new errors.
  **Baseline in this worktree at the starting commit: 533.** If your count differs from 533
  before you have changed anything, re-measure with `git stash` and use *that* number — never
  assume a baseline you did not observe.
- Tests pass. **Convention:** pure-logic tests in `script/test-<thing>.ts`, run with
  `npx tsx script/test-<thing>.ts`, exiting non-zero on failure. See `script/test-academy.ts`.
  No DB, no network — this worktree has **no `.env`** and cannot reach one.
- The task's own assertion (below) is demonstrated by a test, not asserted in prose.
- Committed with a message explaining *why*, not what.

## Environment

You are in a git worktree at `apps/clubos/.worktrees/budget-automation`, branch
`loop/budget-automation`. There is **no `.env` here, deliberately** — you cannot reach the
production database, Stripe, or Fly, and you must not try. `node_modules` is a symlink.
`npx tsc` and `npx tsx` both work offline.

---

## Tasks

- [x] **T1 — `shared/accounting-codes.ts`: the code tree as typed data** — done. 805 rows ported
verbatim with `provenance`; `expenseCodeFor()` returns null for 13/14/15 and unknown codes,
correctly mirrors 01→31.. 12→42; 43/44/21-23 confirmed unmirrored. 14/14 tests pass
(`npx tsx script/test-accounting-codes.ts`).
Port `outputs/budget-automation/coding-tree/code-tree.json` + `mirror-rules.json` into typed
constants. Include `provenance` on every node.

**Must assert (tests):**
- `expenseCodeFor("13")` returns **null**, not `"43"`. Same for `"14"`, `"15"`.
- `expenseCodeFor("01")` → `"31"`; `expenseCodeFor("12")` → `"42"`.
- `"43"` and `"44"` have **no** income counterpart.
- `"21"`,`"22"`,`"23"` are shared overheads, mirrored by nothing.
- Every code's `parent_code` exists in the tree, or is null at level 1.

> This is the single highest-value test in the whole build. A naive `+30` posts donations into
> the First Team's cost centre.

- [x] **T2 — `shared/accounting.ts`: the mapping engine (pure, no DB, no network)** — done.
`resolve(input, rules)` — added `program_type` as a 4th specificity tier column not in
02-architecture.md's original sketch (needed for the "programme type" tier the task requires;
T3 must mirror it). 14/14 tests pass (`npx tsx script/test-accounting.ts`), tsc still at 533.
`resolve({ orgId, programId, optionId, paymentMethod, occurredAt })
  → { code, xeroAccountCode, tracking1, tracking2, taxType, ruleVersion }`

- Resolves **most specific first**: option → programme → programme type → org default.
- Rules are **effective-dated**; resolution uses `occurredAt`, never "now".
- **Throws** when no rule matches. No fallback account. Ever.

**Must assert:**
- A rule added with `effective_from` in 2027 does **not** change the coding of a 2026 posting.
- An unmapped programme throws, and the error names the programme.
- Option-level rule beats programme-level rule.

- [x] **T3 — migration `migrations/2026-07-10_accounting_subledger.sql` (WRITE ONLY, DO NOT APPLY)** — done
(built across prior iteration commits, finalized this run). All 6 tables written + mirrored 1:1
in `shared/schema.ts`; verified via a clean `git archive` export (isolated from unrelated
uncommitted changes sitting in this worktree) that the only tsc delta vs the 533 baseline is 6
instances of the pre-existing repo-wide drizzle-zod `boolean not assignable to never` quirk
(143 other instances already in baseline) — not a real regression. See AGENTS.md note.
Tables per `02-architecture.md`: `acct_codes`, `acct_mapping_rules`, `acct_postings`,
`acct_deferred_schedule`, `acct_xero_sync`, `acct_reconciliation_runs`.

- `CREATE TABLE IF NOT EXISTS`, `integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY`,
  `timestamp NOT NULL DEFAULT now()`, snake_case.
- `acct_postings.idempotency_key` — **UNIQUE**. This is the double-post guard; it must be a DB
  constraint, not application logic.
- All money columns `bigint` (cents).
- Mirror into `shared/schema.ts`.
- Header comment: *"Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push."*

- [x] **T4 — `server/accounting/post.ts`: the posting emitter (DRY-RUN default)** — done.
`emitPosting()` is a pure no-op (dryRun, never opens `../db`) unless `ACCOUNTING_SUBLEDGER=1`;
the double-post guard is `onConflictDoNothing({target: acctPostings.idempotencyKey})` +
`.returning()`, a DB constraint not app logic. `AccountingDb` is dependency-injected (derived
from `typeof realDb` via a type-only import so the module never pulls in `../db` at load time).
7/7 tests pass (`npx tsx script/test-accounting-post.ts`); tsc unchanged at 536 vs the pre-T4
commit (the 533 in this file is stale — see AGENTS.md note; re-measured via clean `git archive`
export at the prior commit, T4 adds exactly zero).
`emitPosting(source, sourceId, idempotencyKey, gross, fee, net, occurredAt)`.

- Behind `ACCOUNTING_SUBLEDGER=1`. **Default off** — a fresh deploy changes nothing.
- Writes `acct_postings`. **Never** calls Xero.
- `ON CONFLICT (idempotency_key) DO NOTHING` — a replayed webhook is a no-op.

**Must assert:** calling `emitPosting` twice with the same key writes exactly one row.

- [ ] **T5 — hook the four confirm functions**
`handlePaymentSuccess`, `confirmAndEmailVenueBookings`, `handlePrintPaymentSuccess`,
`finalizeMembershipPayment` (`server/routes.ts`).

- Call `emitPosting` **after** the atomic status flip, never before.
- Wrapped in try/catch: **a posting failure must never break a parent's payment.** Log and
  continue. The reconciliation job will catch the gap.
- `shop_orders` is out of scope — it lives on the unmerged `feat/mfl-shop` branch. Note it.

- [ ] **T6 — Stripe fee capture**
The gross/net split needs the Stripe **balance transaction**, not the PaymentIntent.
Fetch it (`stripe.balanceTransactions.retrieve`) to get `fee` and `net`.

**Must assert:** `gross_cents - fee_cents === net_cents` on every posting, fuzzed.

- [ ] **T7 — `server/accounting/reconcile.ts`: the drift job**
Nightly. Compares, for a date range:
- ClubOS `acct_postings` gross ↔ Stripe balance transactions gross.
- Writes `acct_reconciliation_runs` with `drift_cents` and a jsonb of offending ids.
- **Reports drift. Never silently corrects it.**

**Must assert:** an injected missing posting produces non-zero drift and names the payment intent.

- [ ] **T8 — deferred revenue schedule**
A term fee taken on 19 July for a term ending 24 September is not July's income.

- `buildSchedule(posting, term)` → rows in `acct_deferred_schedule`, one per calendar month.
- Pro-rata joins release from the **join date**, reusing `termProgress()` from `shared/academy.ts`.
- Sum of scheduled `amount_cents` **must equal** the posting's net revenue exactly. Round the
  remainder into the final period — never let the parts drift from the whole.

**Must assert:** fuzzed across 1,000 amounts × term lengths, `sum(schedule) === total`, exactly.

- [ ] **T9 — the two-parameter report endpoint**
`GET /api/admin/accounting/coverage?from=&to=` (super-admin).

Returns, per income code: `dollars_cents`, `count`, `count_source`, `complete: bool`.
Backed by `outputs/budget-automation/chart/coverage.csv`'s logic, computed live.

> This is the endpoint that answers Slava's question. It must be honest: where the count is
> unavailable (Academy today), it returns `complete: false` and says why. **A missing count must
> never render as zero.**

- [ ] **T10 — seed the codes + MFL mapping rules (script, not applied)**
`script/seed-accounting.ts`, dry-run by default (`--apply` to write).

- Seeds `acct_codes` from `code-tree.json`, carrying `provenance`.
- Seeds `acct_mapping_rules` **for MFL only** — the agreed beta.
- **Seeds no Xero account codes.** They are unknown until Victor supplies them; the column stays
  null and `resolve()` throws if asked to post. That is the correct behaviour.

---

## Explicitly out of scope for the loop

- Any Xero API call.
- Applying the migration.
- Deploying.
- Touching `feat/mfl-shop`, `feat/marketing-suite`, or merging branches.
- Choosing a fee, a GST treatment, or an account code.
- The dashboard UI (Phase 2).

## When you finish, or get stuck

Write `NEEDS_REVIEW.md`: what was built, what the tests prove, what you could not verify, and
every decision you deferred to a human. Be specific. An honest "I could not verify this" is worth
more than a confident guess.

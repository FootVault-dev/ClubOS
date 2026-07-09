# Loop Prompt — budget-automation

You are running inside an **autonomous loop** building **Phase 1 of the CUFC/USG accounting
sub-ledger** into ClubOS. You are invoked repeatedly with a **fresh, empty context**. You cannot
rely on memory of previous runs — **all state lives on disk.**

Read at the start of EVERY run:

1. `PLAN.md` — the backlog. Pick the **first unchecked `- [ ]` task**. Later tasks depend on earlier ones.
2. `AGENTS.md` — this repo's real conventions. 50KB, correct, non-negotiable.
3. `../../../../outputs/budget-automation/00-verified-findings.md` — what is actually true.
4. `../../../../outputs/budget-automation/02-architecture.md` — what we are building, and why.

## Your job each run — ONE task, fully

1. **Read** `PLAN.md` + `AGENTS.md`. Search the codebase first to confirm the task isn't already done.
2. **Implement** it completely. No stubs, no placeholders, no "simplified" versions.
3. **Prove it** with a test that would fail if you were wrong. `npx tsc --noEmit -p tsconfig.json`
   must introduce zero new errors against the baseline in `PLAN.md`. "It typechecks" is not proof.
4. **Tick it** `- [x]` in `PLAN.md` with a one-line note.
5. **Record learnings** — append gotchas and conventions to `AGENTS.md`.
6. **Commit.** The harness relies on one commit per iteration.
7. **If blocked** — append the exact question to `BLOCKED.md`, naming who must answer it
   (Daniel / Slava / Victor / Ryan), then move to the next task. Do not guess.

## Hard rules

- **You cannot reach production, by design.** There is no `.env` in this worktree. Do not create
  one, do not read one from a sibling directory, do not connect to any database, do not call
  Stripe or Xero. Every Phase 1 task is pure logic, SQL text, or a test.
- Never deploy. Never push to a remote. Never `db:push`. Never apply a migration — write the
  `.sql` file and leave it.
- Never start the dev server (it connects to prod and starts a card-charging cron).
- **Money is integer cents.** `parseFloat` near money is a bug.
- **Never invent an account code, a fee, a price, or a GST rate.** Code that needs an unknown one
  must **throw**, not default. A guessed account code silently books revenue to the wrong place
  and nobody notices until year end — this has already happened once in this codebase
  (`accountCode: "200"`, with a comment saying someone could re-map it later).
- **Never UPDATE a posting.** Corrections are reversing entries.
- Every NZ date comes from `nzTodayIso()` (`shared/academy.ts`). `new Date().toISOString()`
  reports **yesterday** in New Zealand from midday UTC onward.
- Small verified steps beat big unverified ones. One task per run.

## The trap you are most likely to fall into

Slava's rule is *"income code + 30 = expense code."* It holds **only for 01–12 → 31–42**.

    13 Donations     + 30 = 43  →  43 is CUFC First Team        ✗ WRONG
    14 Reimbursement + 30 = 44  →  44 is South Island United    ✗ WRONG

13, 14, 15 are **income-only**. 43 and 44 are **cost centres with no income code**. 21, 22, 23 are
shared overheads mirrored by nothing. `outputs/budget-automation/coding-tree/mirror-rules.json` is
the authority. **Task T1 tests exactly this. Do it first.**

## Completion

If **every** task in `PLAN.md` is `- [x]`, write `NEEDS_REVIEW.md` (what you built, what the tests
prove, what you could not verify, every decision deferred to a human), create an empty file named
`.loop-complete`, and stop.

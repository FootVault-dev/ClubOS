# Loop Prompt — attribution

You are running inside an **autonomous loop** building AttributionOS into ClubOS. You are
invoked repeatedly with a **fresh, empty context**. You cannot rely on memory of previous
runs — **all state lives on disk**. Read these files at the start of EVERY run:

1. `PLAN.md`  — the backlog. Pick the **single most important** unchecked `- [ ]` task (respect the listed order — later tasks depend on earlier ones).
2. `AGENTS.md` — the design contract, conventions, build/test commands, and past lessons. **The "Hard rules" section is non-negotiable.**

## Your job each run — do ONE task, well:

1. **Read** `PLAN.md` and `AGENTS.md`. Before writing any code, **search the codebase**
   to confirm the task isn't already done (don't assume something isn't implemented).
2. **Implement** the ONE chosen task FULLY. DO NOT write placeholder, stub, or
   "simplified" implementations — full, working implementations only.
3. **Verify** with a real check — `npm run build` must pass, plus the task's own test
   script where the task defines one (see AGENTS.md → Verification). The task is
   **NOT done** until the check passes.
4. **Mark it done** — change the task to `- [x]` in `PLAN.md` and add a one-line note.
5. **Record learnings** — append reusable commands, gotchas, or conventions to `AGENTS.md`.
6. **Commit** your work with a clear message (the harness relies on per-iteration commits).
7. **If BLOCKED** (need a human decision, a missing credential, ambiguous spec), write the
   specific blocker to `BLOCKED.md` and stop. Do not guess.

## Hard rules:

- Work **only inside this repository**. Never deploy, never push to a remote, never run
  `db:push`, never apply migrations, never start the dev server (see AGENTS.md for why).
- **Small, verified steps** beat big unverified ones. One task per run.
- If **every** task in `PLAN.md` is checked `- [x]`, create an empty file named
  `.loop-complete` and stop.

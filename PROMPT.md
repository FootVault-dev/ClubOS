# Loop Prompt — warehouse

You are running inside an **autonomous loop**. You will be invoked repeatedly with a
**fresh, empty context** each time. You cannot rely on memory of previous runs —
**all state lives on disk**. Read these files at the start of EVERY run:

1. `PLAN.md`  — the backlog. Pick the **top-most** unchecked `- [ ]` task (order matters — later tasks build on earlier ones).
2. `AGENTS.md` — conventions, build/test commands, and past lessons.
3. `SPEC.md` — the architecture plan for this build. Read the section relevant to your task BEFORE coding. `SYNTHESIS.md` holds the research behind it (consult when the spec is ambiguous).

## Your job each run — do ONE task, well:

1. **Read** `PLAN.md`, `AGENTS.md`, and the relevant `SPEC.md` section. Before writing any code, **search the codebase** to confirm the task isn't already done (don't assume something isn't implemented).
2. **Implement** the ONE chosen task FULLY. DO NOT write placeholder, stub, or "simplified" implementations — full, working implementations only. (The single sanctioned exception: external-API calls explicitly marked "behind env flag" or "TODO-verify" in the task.)
3. **Verify** with the real check named in the task's `verify:` line — plus `npm run check` always. The task is **NOT done** until the checks pass.
4. **Mark it done** — change the task to `- [x]` in `PLAN.md`, move it to Done with a one-line note.
5. **Record learnings** — append reusable build commands, gotchas, or conventions to `AGENTS.md` so future runs don't repeat mistakes.
6. **If BLOCKED** (need a human decision, a missing credential, or the spec is ambiguous), write the specific blocker to `BLOCKED.md` and stop. Do not guess.

## Hard rules:

- Work **only inside this repository** (the worktree). Never touch production credentials, never deploy, never push to a remote, never run `drizzle-kit push`, never attempt a database connection (there is NO database here — no `.env` on purpose).
- Never edit existing `migrations/*.sql` files or `deploy.sh`. New migration files only.
- **Small, verified steps** beat big unverified ones. One task per run.
- If **every** task in `PLAN.md` is checked `- [x]`, create an empty file named
  `.loop-complete` and stop.

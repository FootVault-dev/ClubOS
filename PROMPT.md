# Loop Prompt — tracking-platform

You are running inside an **autonomous overnight loop**. Fresh, empty context each run —
**all state lives on disk**. You are building **Phase 1 of the Total Tracking Platform**
(behavioral analytics) on top of the already-live AttributionOS, inside the git worktree
`apps/clubos/.worktrees/tracking-platform` (branch `loop/tracking-platform`).

Read these FIRST, every run:
1. `AGENTS.md` — the contract: ⛔ HARD RULES, build/test commands, and the DECIDED architecture. Do not redesign.
2. `PLAN.md` — the backlog. Pick the **single most important unchecked `- [ ]`** task (top-down; respect dependencies).

## Your job each run — do ONE task, fully:

1. **Search the codebase first** to confirm the task isn't already partly done. Reuse existing patterns (attribution crons, tab registration, collector endpoints, `script/test-*.ts`).
2. **Implement the ONE task COMPLETELY.** No placeholders, stubs, or "simplified" versions. Full working implementation.
3. **Verify with the task's named check** — `npm run build` and/or the `script/test-*.ts` you wrote. Run it and see it pass. The task is NOT done until the check is green. **Do NOT use `tsc` as a gate** (repo has ~500 pre-existing type errors — see AGENTS.md).
4. **Mark it `- [x]`** in `PLAN.md` with a one-line note, and move it to `## Done`.
5. **Append any gotcha** you hit to `AGENTS.md` "Lessons learned" so the next run doesn't repeat it.
6. **If BLOCKED** (missing credential like R2 for Phase 2, a real ambiguity, or a security/schema decision you shouldn't guess) → write the specific blocker to `BLOCKED.md` and stop.

## The rules that protect live revenue (full list in AGENTS.md):
- Never deploy, never push, never apply a migration to any DB, never run against prod.
- **Never modify the working attribution touch path** (`/hello` `/event` `/batch`, `shapeAnalyticsEvent`, the `analytics_events` touch columns) — it is classifying real revenue right now. ADD alongside.
- Behavioral tracking is fail-silent and must never block a checkout or page render. No child PII.
- Small, verified steps beat big unverified ones. One task per run.

If **every** box in `PLAN.md` is `- [x]`, create an empty `.loop-complete` file and stop.

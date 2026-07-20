# VERIFY.md — independent verification criteria for loop/tracking-platform

You are a skeptical, READ-ONLY reviewer. Assume the loop's work only LOOKS done. Never change code.
Review the branch diff (`git diff feat/proposals-tracker-search..HEAD`) against `PLAN.md` + `AGENTS.md`.
Write findings to `NEEDS_REVIEW.md` (be specific: file:line, why it's wrong, how to confirm).

## Gate the whole branch on these — a NO on any is a finding:

1. **Build is green.** `npm run build` exits 0. (Do NOT judge on `tsc` — this repo has ~500 pre-existing type errors; only NEW errors introduced in the loop's OWN new files matter, and even those only if they'd break the esbuild build.)
2. **Every pure-logic module has a passing test.** For each `shared/behavior*.ts`, a `script/test-*.ts` exists and passes (`npx tsx script/test-<name>.ts` exits 0). Re-run them yourself.
3. **The attribution touch path is UNTOUCHED.** `git diff` must show NO semantic change to `shared/attribution.ts` classifier, `shapeAnalyticsEvent`, the `/api/public/analytics/{hello,event,batch}` handlers, or `analytics_events` touch columns. Behavioral events must write to the NEW `behavior_events` table, NOT `analytics_events`. Flag any modification to the live attribution flow.
4. **No migration was applied; migrations are additive.** New files under `migrations/` only. grep them: NO `DROP TABLE`, NO `ALTER ... RENAME`, NO `db:push`, NO destructive verb — EXCEPT the single guarded 13-month `DROP PARTITION` in the prune step (that one is allowed). No code path calls a migration-apply/`drizzle-kit push` against a DB.
5. **Fail-silent + no-block guarantee.** The `/api/public/analytics/behavior` handler is try/catch, returns 200 on bad input, and cannot throw into a request that matters. The client tracker additions cannot throw synchronously on the page. Confirm behavioral capture is not on any checkout-blocking path.
6. **Dashboards read rollups, not raw events.** The `GET /api/admin/behavior/*` endpoints query the `*_daily` rollup tables, NOT `behavior_events` directly (raw table is for the cron only). Flag any admin endpoint scanning `behavior_events`.
7. **Auth + org scoping.** Every `/api/admin/behavior/*` endpoint is `requireAuth` and org-scoped (`attributionScope`/`workspaceOrg`) — no cross-workspace leak, no unauthenticated admin data.
8. **No child PII / no raw form values.** Behavioral events store visitor_id + shape only — no names, emails, or form field values; `click` stores a text HASH not raw text.
9. **Tab wiring complete.** If a `behavior` tab was added, it's in `shared/tabs.ts` + all `app-sidebar.tsx` nav arrays + an `App.tsx` route + the page exists (mirror the `attribution` tab exactly — check the counts match).
10. **PLAN accuracy.** Every task marked `- [x]` is genuinely, fully implemented (not a stub). Spot-check 2–3 checked tasks against the actual code.

## Output
Write `NEEDS_REVIEW.md` with a prioritized list (blocking first). If everything passes, write `NEEDS_REVIEW.md` containing exactly `VERIFIED CLEAN` on the first line + a one-paragraph summary of what you checked.

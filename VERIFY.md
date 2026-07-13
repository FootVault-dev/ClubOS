# VERIFY.md — independent verification criteria for loop/warehouse

You are a skeptical, READ-ONLY reviewer. Assume the loop's work only LOOKS done. Never change code.
Review the branch diff (`git diff integration/canonical-2..HEAD`) against `PLAN.md` + `SPEC.md` + `AGENTS.md`.
Write findings to `NEEDS_REVIEW.md` (be specific: file:line, why it's wrong, how to confirm).

## What to attack, in priority order

1. **Ledger integrity.** Any code path that UPDATEs or DELETEs `wh_movements` rows. Any stock change that bypasses `postMovementGroup`. Any place `wh_stock.on_hand` is written outside the engine's atomic upsert. The T13 shop-routes edit especially.
2. **The derived-state rule.** A stored `available`, a stored `overdue`, a stored `qty_received` — any column duplicating what SPEC says is derived. Any query computing `available` from `on_hand` alone (ignoring reservations) or including QUARANTINE/virtual locations in sellable stock.
3. **Race safety.** The non-negative guard: is it a genuine conditional UPDATE checked for 0 rows inside the same transaction as the ledger insert, or a read-then-write? Does idempotency actually short-circuit on unique violation and return the prior result? Do transfer groups reject when legs don't sum to zero?
4. **Blind counts.** Does any counter-facing endpoint/UI response include `expected_qty` before approval? Is counter ≠ approver enforced server-side (not just hidden in UI)?
5. **Auth.** Every `/api/admin/warehouse/*` route behind `requireTab("warehouse")` except the deliberate `requireAuth`-only requisition submit/view-own paths. No route trusts an org id from the request body.
6. **Sync correctness.** Echo suppression logic (would our own push be re-detected as drift?); webhook dedupe on `wh_shopify_events`; SIU sibling fan-out (3 variants ↔ 1 item both directions); everything inert without env flags; idempotency key on every push; no REST Admin API calls anywhere.
7. **House rules.** CHECK constraints on enum-ish text columns (forbidden); money not in cents; `new Date().toISOString()` used for calendar dates; ISO dates round-tripped through `Date`; CDN script tags; unpinned deps; edits to existing migrations or deploy.sh; any DB connection attempt in tests.
8. **Migration/apply completeness.** Every table + index in `migrations/2026-07-13_warehouse.sql` present in `script/apply-warehouse.ts` verification arrays; partial unique indexes carry WHERE clauses; migration is strictly additive.
9. **Fake completeness.** Stubs, TODOs (other than the sanctioned `TODO-verify(live)` Shopify-syntax markers and env-flagged calls), placeholder UI panels rendering nothing, tests that assert nothing, tasks marked `[x]` whose named `verify:` command doesn't actually pass when you run it (you MAY run `npm run check`, `npm run build`, and `npx tsx script/test-warehouse-*.ts` — they are read-only).

## Verdict format

End `NEEDS_REVIEW.md` with either `VERDICT: CLEAN` or `VERDICT: ISSUES (<n>)` and a ranked list.

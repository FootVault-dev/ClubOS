# Plan — tracking-platform (Phase 1: Behavioral Depth, + Phase 2 stretch)

> The loop works the **single most important unchecked box** each run, then commits.
> Tasks are ordered by dependency — do them top-down. Each names a `verify:` you must run
> green before checking it `- [x]`. Full architecture is in `AGENTS.md` (read it first).
> Gate = `npm run build` + your `script/test-*.ts`. NEVER gate on `tsc` (repo has ~500 pre-existing type errors).

## Phase 1 — Behavioral Depth (the overnight target)


- [ ] **T6. t.js v2 behavioral layer.** Extend `shared/tracker-script.ts` (`renderTrackerScript`) to emit the taxonomy (batched queue, `sendBeacon` on `visibilitychange`/unload, element-anchored click with CSS-path + normalized offset, scroll max-band, section IntersectionObserver visible-ms, page_leave dwell, rage_click, route_change, form_start/abandon, vitals). Output stays ES5-safe. If it would exceed 6KB, split boot + lazy-loaded behavioral script (AGENTS §7). Extend `script/test-attribution-tjs.ts` to assert the new shape + size + ES5-safety WITHOUT breaking existing assertions. verify: `npx tsx script/test-attribution-tjs.ts` green + `npm run build` green.

- [ ] **T7. `server/behavior-rollup-cron.ts` — nightly rollups + partition maintenance + prune.** Copy the guarded-start/never-throws pattern from `server/attribution-maintenance-cron.ts`. Steps: recompute yesterday's 5 rollups (idempotent upserts via the `shared/behavior-rollups.ts` builders); `CREATE TABLE IF NOT EXISTS` next month's partition; DROP the partition older than 13 months (guarded). Register `startBehaviorRollupCron()` in `server/index.ts` after the attribution crons. verify: `npm run build` green.

- [ ] **T8. `GET /api/admin/behavior/*` read endpoints.** `overview` (per-site page table: views/uniques/avg dwell/exit), `page/:path*` detail (scroll histogram, section timing, top clicked css_paths), `journeys` (edges for Sankey), `hours` (hour-of-day profile). Each `requireAuth` + org-scoped via `attributionScope(req)`/`workspaceOrg`. Read ONLY the `*_daily` rollup tables. Use `parseInt(String(req.params.x),10)`. verify: `npm run build` green.

- [ ] **T9. `behavior` tab registration.** Add `behavior` to `shared/tabs.ts`, the `Activity`/`MousePointerClick` (pick a lucide icon) import + every nav array in `client/src/components/app-sidebar.tsx` (right after `attribution`), the route in `client/src/App.tsx`. verify: `npm run build` green + grep confirms the route count matches attribution's.

- [ ] **T10. `client/src/pages/behavior.tsx` — page table + per-page detail.** Read-only over T8. Site selector → page table → click a page → detail: scroll-depth funnel bars, section-timing bars, top-clicked-elements list, hour-of-day heat strip. Redeclare response shapes locally (client can't import server types). react-query keys carry every control; explicit `queryFn`. verify: `npm run build` green.

- [ ] **T11. Journey flow (Sankey) in behavior.tsx.** Render `journey_edges_daily` as a page→page flow (a lightweight inline SVG Sankey or a stacked bar of top transitions — no new heavy dep). verify: `npm run build` green.

- [ ] **T12. `BEHAVIOR.md` docs + a `MIGRATIONS-TO-APPLY.md`.** Event dictionary, table/endpoint map, cron ops, and a **numbered list of the migration files a human must apply to Supabase prod BEFORE deploy** (the two new migration files, in order). verify: both files exist and list every new migration file by name.

## Phase 2 — Session Replay (STRETCH — only after ALL Phase 1 boxes are `- [x]`)

> These need a Cloudflare R2 bucket + creds. If `R2_*` / `CLOUDFLARE_*` env vars are ABSENT,
> write the specific missing credential to `BLOCKED.md` and stop — do NOT invent storage.

- [ ] **T13. Replay capture (lazy rrweb) + `replay_sessions` migration FILE.** Lazy-load rrweb in t.js v2 (masked: `maskAllInputs:true`, text-mask on PII pages, Stripe iframes never captured), gzip batches → `POST /api/public/analytics/replay` → object storage (R2; Supabase Storage fallback). Metadata row in a new `replay_sessions` table (migration FILE). verify: `npm run build` green (BLOCK if no storage creds).
- [ ] **T14. Replays viewer + tab (rrweb-player).** verify: `npm run build` green.
- [ ] **T15. 30-day replay retention cron.** verify: `npm run build` green.

## Done

- [x] **T1. `shared/behavior.ts` — pure event-shaping module.** Built `shapeBehaviorEvent`/`shapeBehaviorEvents` (whitelist, css_path sanitising, offset clamp, scroll-band bucketing, viewport coercion, site normalising, FNV-1a text hash instead of raw text, `detectBot` reuse). `script/test-behavior.ts`: 77 assertions green. `npm run build` green. NOTE for T2: added a `textHash` field not listed in AGENTS §3 — the migration needs a `text_hash text` column too (see AGENTS Lessons learned).

- [x] **T2. `behavior_events` partitioned table — migration FILE + drizzle mirror.** `migrations/2026-07-10_behavior_events.sql`: parent `PARTITION BY RANGE (ts)` (composite `PRIMARY KEY (id, ts)` — partitioned tables require the partition key in every PK), 3 monthly partitions (2026-07/08/09), 4 parent indexes (all `IF NOT EXISTS`), includes the `text_hash` column from T1. Drizzle mirror `behaviorEvents` added to `shared/schema.ts` (+ `real` import) — no partition clause, matching indexes for query typing. verify: `npm run build` green; grep confirms only additive verbs (DROP/db:push mentions are comment prose, not SQL statements).

- [x] **T3. Rollup tables — migration FILE + drizzle mirrors.** `migrations/2026-07-10_behavior_rollups.sql`: `page_stats_daily`, `section_stats_daily`, `click_stats_daily`, `journey_edges_daily`, `hour_of_day_profile` per AGENTS §4, all `CREATE TABLE IF NOT EXISTS` with a unique index per table for idempotent upsert (`hour_of_day_profile` is a rolling weekly profile keyed `(site, dow, hour)` with no `day` column — see AGENTS Lessons learned). Drizzle mirrors added to `shared/schema.ts` (+ new `smallint` import for `dow`/`hour`). verify: `npm run build` green; grep confirms no destructive SQL verbs.

- [x] **T4. `shared/behavior-rollups.ts` — SQL builder helpers + tests.** 5 pure `build*Upsert(day)` functions returning `{ text, params }` (standard `$1` positional placeholders, node-postgres-compatible) for `page_stats_daily`/`section_stats_daily`/`click_stats_daily`/`journey_edges_daily` (full-overwrite upserts, all safe to re-run) and `hour_of_day_profile` (deliberate INCREMENT — `sessions = table.sessions + EXCLUDED.sessions` — NOT safe to re-run same day twice, matches T3's Lessons learned). `journey_edges_daily` unions `analytics_events` page_view rows with `behavior_events` route_change rows (reading analytics_events downstream is fine — rule 4 only forbids touching its write path). `ROLLUP_BUILDERS` manifest for T7 to iterate. Also shipped 2 pure client-facing reducers T8/T10 will want: `scrollHistToFunnel` (jsonb histogram → funnel bars) and `hourProfileToGrid` (rows → dense 7×24 grid). `script/test-behavior-rollups.ts`: 93 assertions green. `npm run build` green. NOTE for T7: no DB import anywhere in this module by design — the cron must execute these via `pool.query(text, params)`, which requires exporting the raw `pg.Pool` from `server/db.ts` (currently only `db` — the drizzle wrapper — is exported); `db.execute(sql.raw(text))` does NOT work here since drizzle-orm 0.39's `sql.raw()` takes no params argument.

- [x] **T5. Collector endpoint `POST /api/public/analytics/behavior` (+ OPTIONS).** Added in `server/routes.ts` right after `/batch`, same `setTrackerCors` + fail-silent-200 pattern. New `behaviorEventsToInsert(rawEvents, ctx, limit)` helper in `shared/behavior.ts` (shape via `shapeBehaviorEvents` + drop bot-flagged rows entirely — unlike `analytics_events`, `behavior_events` has no attribution/audit need to keep bot noise) so the route is a 4-line glue (`const toInsert = behaviorEventsToInsert(events, {userAgent}, 50); if (toInsert.length) await db.insert(behaviorEvents).values(toInsert); res.json({ok:true,count})`) and the request→insert-rows mapping unit-tests without a DB. `script/test-behavior-endpoint.ts`: 20 assertions green (bot-drop, malformed-row-drop, textHash-never-raw-text, batch cap, non-array events → []). Did NOT touch `/hello` `/event` `/batch`. `npm run build` green.

<!-- completed tasks move here with a one-line note from the agent -->

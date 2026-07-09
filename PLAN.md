# Plan — tracking-platform (Phase 1: Behavioral Depth, + Phase 2 stretch)

> The loop works the **single most important unchecked box** each run, then commits.
> Tasks are ordered by dependency — do them top-down. Each names a `verify:` you must run
> green before checking it `- [x]`. Full architecture is in `AGENTS.md` (read it first).
> Gate = `npm run build` + your `script/test-*.ts`. NEVER gate on `tsc` (repo has ~500 pre-existing type errors).

## Phase 1 — Behavioral Depth (the overnight target)


- [ ] **T2. `behavior_events` partitioned table — migration FILE + drizzle mirror.** Write `migrations/<today>_behavior_events.sql` per AGENTS §3 (parent PARTITION BY RANGE (ts) + current + next 2 monthly partitions + parent indexes, all `IF NOT EXISTS`). Add the matching `behaviorEvents` `pgTable` mirror to `shared/schema.ts` (no partition clause) + insert type. verify: `npm run build` green AND the SQL file has only additive verbs (grep it: no DROP/ALTER-rename/db:push).

- [ ] **T3. Rollup tables — migration FILE + drizzle mirrors.** `migrations/<today>_behavior_rollups.sql`: `page_stats_daily`, `section_stats_daily`, `click_stats_daily`, `journey_edges_daily`, `hour_of_day_profile` per AGENTS §4 (all `CREATE TABLE IF NOT EXISTS`, a unique key per table for idempotent upsert). Add drizzle mirrors to `shared/schema.ts`. verify: `npm run build` green.

- [ ] **T4. `shared/behavior-rollups.ts` — SQL builder helpers + tests.** Pure functions returning the parameterised SQL strings that recompute each rollup for a given day (used by the cron), plus the client-facing read-shape reducers if any are pure. verify: `npx tsx script/test-behavior-rollups.ts` green (≥15 assertions — e.g. builders emit the expected upsert onConflict, day-bounded WHERE, no `DROP`).

- [ ] **T5. Collector endpoint `POST /api/public/analytics/behavior` (+ OPTIONS).** In `server/routes.ts` near the existing analytics endpoints. `setTrackerCors`, shape via `shapeBehaviorEvents`, insert non-bot rows into `behavior_events`, fail-silent 200. Cap batch at 50. Do NOT touch `/hello` `/event` `/batch`. verify: `npm run build` green + a `script/test-behavior-endpoint.ts` OR a documented curl-shape note (prefer a pure test of the request→rows mapping if factored into `shared/behavior.ts`).

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

<!-- completed tasks move here with a one-line note from the agent -->

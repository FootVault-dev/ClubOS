# Agent Notes — tracking-platform (Total Tracking Platform, Phase 1: Behavioral Depth)

> Durable memory across loop runs. Read this EVERY run. Append what you learn.
> You are building **Phase 1 of `plans/2026-07-09-total-tracking-platform.md`** — behavioral
> analytics (heatmaps, journeys, dwell, section timing) on top of the already-live AttributionOS.

## ⛔ HARD RULES (never break these — they protect live revenue)

1. **Work ONLY in this worktree** (`apps/clubos/.worktrees/tracking-platform`, branch `loop/tracking-platform`). Never `cd` to the main `apps/clubos` checkout.
2. **NEVER deploy** (`deploy.sh`, `fly`, `vercel`), **never `git push`**, never run a server against the prod DB, never call a live external API that writes.
3. **NEVER apply a migration to any database.** All schema changes are **additive SQL FILES** in `migrations/` only (a human/CI applies them). Additive verbs ONLY: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE TYPE ... IF NOT EXISTS`. Never `DROP` (except the one guarded 13-month partition drop in the prune step), never rename, never `db:push`.
4. **NEVER touch the working attribution path.** The live tracker writes `session_start`/`page_view` touch rows (with `channel`, `visitor_id`) to `analytics_events` and that is CLASSIFYING REAL REVENUE RIGHT NOW. Do not change `shared/attribution.ts` classifier semantics, `shapeAnalyticsEvent`, the `/api/public/analytics/{hello,event,batch}` touch behaviour, or `analytics_events` touch columns. Behavioral events go to a NEW table (see Architecture). ADD alongside; never modify-in-place the attribution flow.
5. **Behavioral tracking is fail-silent and MUST NEVER block or slow a checkout / registration / page render.** Every collector write is best-effort try/catch; a failure returns 200 and drops the event. The client tracker never throws.
6. **No child PII, ever.** The attribution "person" is the parent/payer. Behavioral events store no names/emails — only visitor_id + event shape.
7. If you need a human decision, a missing credential, or the spec is ambiguous → write the specific blocker to `BLOCKED.md` and stop. Do NOT guess on schema or security.

## How to build / test this project

- **Build (the primary gate):** `npm run build` — runs `tsx script/build.ts` (Vite client + esbuild server). Must exit 0. This is the real "does it compile + bundle" check.
- **Unit tests:** pure-logic modules ship a `script/test-*.ts` run with `npx tsx script/test-<name>.ts` (exit 0 = pass, prints "N assertions passed"). This is the proven pattern (see `script/test-attribution*.ts`). **Every pure-logic task you add MUST ship a `script/test-*.ts` and you MUST run it green before marking the task done.**
- **⚠️ DO NOT run `npx tsc` / `npm run check` as a gate.** This repo is NOT tsc-clean — there are ~500 PRE-EXISTING type errors (drizzle-zod `.omit()` `boolean not assignable to never`, `req.params: string|string[]`). They are not yours to fix and chasing them wastes the whole iteration. Gate ONLY on `npm run build` + your `script/test-*.ts`.
- **Install:** node_modules is symlinked; do NOT run `npm install`.
- `req.params.x` is typed `string | string[]` here — use `parseInt(String(req.params.x), 10)` / `String(req.query.x)`.

## Architecture — DECIDED, implement against this (do not redesign)

**North star:** granular behavioral events land in a NEW monthly-partitioned table; nightly rollups aggregate them; the ClubOS "Behavior" tab and any agent read ONLY the rollups (never the raw event table). One Postgres keeps person-graph joins trivial; rollups keep dashboards fast. (Plan decisions D17/D18.)

### 1. New event taxonomy (client → collector)
The t.js tracker (from `shared/tracker-script.ts`, served at `/t.js`) gains a v2 behavioral layer emitting these types (BATCHED, `sendBeacon` on unload, ≤2 requests/pageview typical):
- `page_leave` — dwell ms for the pageview
- `scroll` — max scroll depth as a 10% band (0,10,…100)
- `section_view` — visible-ms per `section`/`[data-track-section]` via IntersectionObserver
- `click` — element CSS-path + normalized offset within the element (0..1 x/y) + viewport bucket (`mobile`|`tablet`|`desktop`) + a text hash (NO raw text)
- `rage_click` — ≥3 clicks same element <1s
- `route_change` — SPA navigations
- `form_start` / `form_abandon` — form id only, NO field values
- `vitals` — LCP / CLS / INP

Element anchoring (D18): record the **CSS-path of the target + normalized offset**, NOT pixel x/y — survives responsive layouts. Scroll depth = max-% in 10% bands. Section timing = accumulated visible-ms per section per pageview.

### 2. Collector v2 — where these land
- Add a NEW endpoint `POST /api/public/analytics/behavior` (batch) that accepts `{ events: [...] }`, shapes each via a NEW pure module `shared/behavior.ts` (`shapeBehaviorEvent`), carries over bot-flagging (reuse `detectBot` from `shared/attribution.ts`), stamps GeoLite2 city at ingest if available (optional — see task), and inserts into `behavior_events`. Same CORS/`setTrackerCors` + OPTIONS pattern as the existing analytics endpoints. Fail-silent (200 on bad payload). **Do NOT overload the existing `/batch` (that's the attribution touch path — rule 4).**
- `shared/behavior.ts` is PURE (no DB import) so it unit-tests: validation, event-type whitelist, CSS-path sanitising, offset clamping to [0,1], band bucketing, bot flag. Ship `script/test-behavior.ts`.

### 3. Schema — `behavior_events`, monthly-partitioned (migration FILE only)
`migrations/<date>_behavior_events.sql`: `CREATE TABLE behavior_events (id bigint generated always as identity, visitor_id text, person_id integer, session_id text, site text, event_type text not null, page_path text, css_path text, offset_x real, offset_y real, viewport text, scroll_band int, section_key text, visible_ms int, dwell_ms int, form_id text, metric text, metric_value real, country text, city text, is_bot boolean not null default false, ts timestamptz not null default now()) PARTITION BY RANGE (ts);` + create the current + next 2 monthly partitions + a helper note (no pg_partman). Mirror as a drizzle `pgTable` in `shared/schema.ts` for query typing (drizzle can't own partitioning — the migration is source of truth; the mirror has matching columns, no partition clause). Indexes on the parent: `(visitor_id, ts)`, `(page_path, ts)`, `(event_type, ts)`, `(section_key, ts)`. Header: "Run on Supabase prod BEFORE the Fly deploy. Additive only. DO NOT db:push."

### 4. Rollups (nightly cron; dashboards read THESE only)
New tables (additive migration): `page_stats_daily` (site, page_path, day, views, uniques, avg_dwell_ms, scroll_hist jsonb band→count, exit_rate), `section_stats_daily` (page_path, section_key, day, avg_visible_ms, view_count), `click_stats_daily` (page_path, css_path, viewport, day, clicks, uniques, avg_offset_x, avg_offset_y), `journey_edges_daily` (site, from_path, to_path, day, count — the Sankey source), `hour_of_day_profile` (site, dow, hour, sessions). A cron `server/behavior-rollup-cron.ts` (mirror `server/attribution-maintenance-cron.ts` guarded-start + nightly pattern; register in `server/index.ts` after the attribution crons) recomputes yesterday's rollups via SQL over `behavior_events` (+ `analytics_events` page_view→page_view for journey edges). Idempotent upserts. Also a partition-maintenance step: `CREATE TABLE IF NOT EXISTS` next month's partition. SQL-string builders that CAN be unit-tested go in `shared/behavior-rollups.ts` with `script/test-behavior-rollups.ts`.

### 5. Prune
Raw `behavior_events` older than 13 months dropped by DROP PARTITION (a guarded maintenance step in the same cron — the ONE allowed drop, whole old partition only). Rollups keep forever.

### 6. UI — ClubOS "Behavior" sub-tab
Add a `behavior` tab (mirror how `attribution`/`links` tabs were added: `shared/tabs.ts` + `client/src/components/app-sidebar.tsx` icon import + the nav arrays + `client/src/App.tsx` route + a new `client/src/pages/behavior.tsx`). Read-only, consumes NEW `GET /api/admin/behavior/*` endpoints (each `requireAuth` + org-scoped via the existing `attributionScope(req)`/`workspaceOrg` helpers in routes.ts). Views: per-site page table → per-page detail (scroll-depth funnel bars, section-timing bars, top-clicked-elements list = the heatmap data, journey flow, hour-of-day heat strip). Client can't import server types — redeclare response shapes locally (same as `attribution.tsx`). Endpoints read ONLY the `*_daily` rollup tables.

### 7. t.js size budget
The base tracker stays ES5-safe and small; `renderTrackerScript` returns a STRING tested by `script/test-attribution-tjs.ts` (no `=>`/`const`/`let`/backtick in OUTPUT, `<6KB`). If the behavioral layer pushes it over, split: keep the tiny boot inline, lazy-load the heavier behavioral collector as a second injected script (same lazy pattern Phase 2 uses for rrweb). Extend the tjs test to cover the new size/shape. Do NOT break existing tracker assertions.

## Conventions
- Migrations: `bigint generated always as identity` for high-volume event tables (else `integer ... identity`), `timestamptz NOT NULL DEFAULT now()`, snake_case, additive. Header "Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push."
- Crons: guarded `started` flag, first run +N min after boot, daily interval with `*_INTERVAL_MS` override, never throws, registered in `server/index.ts`. Copy `server/attribution-maintenance-cron.ts`.
- Pure logic in `shared/*.ts` (no DB/Express imports) so it unit-tests; DB glue in `server/*.ts`.
- Reuse `detectBot`, `setTrackerCors`, `attributionScope`/`workspaceOrg`, the tab-registration pattern. Don't reinvent.

## Lessons learned (append-only)
- (add gotchas here as you hit them)

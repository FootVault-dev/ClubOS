# BEHAVIOR.md — Behavioral Analytics (Total Tracking Platform, Phase 1)

The behavioral-depth layer on top of AttributionOS: heatmaps, page-by-page journeys, dwell,
scroll depth, section timing, rage-clicks, form-abandon, web-vitals — **a SEPARATE pipeline
from the live attribution touch flow** (`analytics_events` / `session_start`+`page_view`
classification), which is untouched. See `plans/2026-07-09-total-tracking-platform.md` (D17/D18).

## Data flow
```
t.js (base tracker, attribution) ──lazily injects──▶ /t2.js (behavioral layer)
        │                                                   │ batches, sendBeacon on unload
        ▼                                                   ▼
POST /api/public/analytics/batch,/hello  (UNCHANGED)   POST /api/public/analytics/behavior
        │ → analytics_events (touch, channel)               │ shapeBehaviorEvent (pure, bot-flagged)
                                                            ▼
                                                    behavior_events  (monthly-partitioned, raw)
                                                            │  nightly server/behavior-rollup-cron.ts
                                                            ▼
      page_stats_daily · section_stats_daily · click_stats_daily · journey_edges_daily · hour_of_day_profile
                                                            │  read-only, org-scoped
                                                            ▼
                          GET /api/admin/behavior/*  ──▶  ClubOS "Behavior" tab (client/src/pages/behavior.tsx)
```

## Event taxonomy (client → `POST /api/public/analytics/behavior`)
`page_leave` (dwell ms) · `scroll` (max-depth 10% band) · `section_view` (visible-ms per
`section`/`[data-track-section]`, IntersectionObserver) · `click` (element **CSS-path** +
**normalized 0..1 offset** + viewport bucket + **FNV-1a text hash**, never raw text) ·
`rage_click` · `route_change` (SPA) · `form_start`/`form_abandon` (form id only, **no field
values**) · `vitals` (LCP/CLS/INP). Element-anchored (D18) so it survives responsive redesigns.

## Code map
- **`shared/behavior.ts`** — pure `shapeBehaviorEvent`/`behaviorEventsToInsert` (validation, css-path
  sanitise, offset clamp [0,1], scroll banding, viewport coercion, text→hash, `detectBot` reuse). Test: `script/test-behavior.ts`.
- **`shared/behavior-rollups.ts`** — pure `build*Upsert(day)` SQL builders + `ROLLUP_BUILDERS` manifest
  + client reducers (`scrollHistToFunnel`, `hourProfileToGrid`). Test: `script/test-behavior-rollups.ts`.
- **`server/routes.ts`** — `POST /api/public/analytics/behavior` (+OPTIONS, fail-silent, writes `behavior_events`) ·
  `GET /api/admin/behavior/{overview,page,journeys,hours}` (`requireAuth` + `attributionScope` org-scoped, read rollups only).
- **`server/behavior-rollup-cron.ts`** — nightly: recompute yesterday's 5 rollups (via the raw `pool` exported from `server/db.ts`) → create next month's partition → drop partitions >13 months. Guarded, never throws. Registered in `server/index.ts`.
- **`shared/tracker-script.ts`** — base `/t.js` lazily injects `/t2.js` (the behavioral collector), kept ES5-safe + under the 6KB budget. Tests: `script/test-attribution-tjs.ts`.
- **`client/src/pages/behavior.tsx`** + `behavior` tab (`shared/tabs.ts`, `app-sidebar.tsx`, `App.tsx`).

## Tables
`behavior_events` (raw, partitioned — **cron only / collector only**, never read by dashboards) ·
`page_stats_daily` · `section_stats_daily` · `click_stats_daily` · `journey_edges_daily` · `hour_of_day_profile` (rollups — dashboards read these).

## Privacy / safety invariants
No child PII (person = parent/payer). No raw form values, no raw click text (hash only). Behavioral
capture is fail-silent and never blocks a checkout/registration/render. Migrations additive-only.
Admin reads are org-scoped. The attribution touch path is never modified.

## Deploy
Apply the two migrations first — see `MIGRATIONS-TO-APPLY.md`. Then deploy ClubOS from the canonical
branch (D16), smoke-test `/api/public/analytics/behavior` OPTIONS→204 / POST `{"events":[]}`→200 plus
the standard `/t.js` checklist.

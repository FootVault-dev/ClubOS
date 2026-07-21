# Agent Notes — warehouse

> **Durable memory across loop runs.** Read every run; append what you learn. Keep it tight.

## How to build / test this project

- Install:    `npm install` (should already be done; if `node_modules` is missing, run it)
- Typecheck:  `npm run check`   ← the ALWAYS gate — must be clean before marking any task done
- Build:      `npm run build`   ← run additionally for any task touching `client/`
- Logic tests: plain assertion scripts `script/test-warehouse-*.ts`, run via `npx tsx script/test-warehouse-<x>.ts` (exit 0 = pass). **No vitest/jest in this repo — do not add a test framework.**
- 🔴 **There is NO database in this environment** — no `.env`, no `DATABASE_URL`, no local Postgres. Never open a DB connection. `script/apply-warehouse.ts` and `script/seed-warehouse.ts` are WRITTEN here but only ever RUN by a human later. Logic tests must be DB-free: inject a fake `tx`/db object that records calls.

## The spec

- `SPEC.md` = the architecture plan (schema §4.1, movement engine §4.2, sync §4.3, UI §4.4, backlog §6). `SYNTHESIS.md` = the research it came from. The spec wins over your instincts; `BLOCKED.md` beats guessing.

## Conventions (house rules — violations have caused prod incidents)

- **Schema:** all new tables in `shared/schema.ts`, prefix `wh_`, copy the Drizzle patterns of the existing `shop_*` tables (same pk/timestamp/index helpers). Migration = ONE new file `migrations/2026-07-13_warehouse.sql`, additive only, `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS`.
- **`script/apply-warehouse.ts`:** copy the newest existing `script/apply-*.ts` dry-run pattern (BEGIN → run migration → verify every table via `to_regclass` + every index via `pg_indexes`, assert partial indexes contain `WHERE` → ROLLBACK unless `--apply`). List EVERY new table and index in its verification arrays.
- **NO CHECK constraints on enum-ish text columns** (movement_type, reason_code, status…) — validate in `shared/warehouse.ts`. (A stale CHECK once 500'd the MFL checkout.) CHECKs only for true invariants (`delta <> 0`, non-negative money).
- **Derived, never stored:** `available` (= on_hand − active reservations), loan `overdue` (= due_on < today ∧ status='out'), PO `qty_received` (= Σ receipt movements). Do not add columns for these.
- **The ledger is append-only** — no UPDATE/DELETE code paths on `wh_movements`, ever. Stock corrections are new adjustment movements.
- **Atomic stock guard:** all cache updates go through `postMovementGroup` (SPEC §4.2) in one transaction with the ledger insert. Non-negative enforcement: a conditional `UPDATE … SET on_hand = on_hand + $delta WHERE on_hand + $delta >= 0` (insert row first if absent); 0 rows updated → reject the whole transaction with "insufficient stock at <LOCATION>". Guard skipped only when the item has `allow_negative`.
- **Money in CENTS** (integer). Quantities `numeric(12,3)` (Drizzle `numeric` maps to string in TS — convert explicitly at the edges).
- **Dates:** NZ timezone; use the repo's existing `nzTodayIso()` helper (grep for it) — never `new Date().toISOString()` for a calendar date, never round-trip an ISO date string through `Date`.
- **Routes:** new files `server/warehouse-routes.ts` (HTTP) + `server/warehouse.ts` (movement engine) + `server/warehouse-sync.ts` (channel sync); register routes in `server/index.ts` next to the shop routes registration. Auth: `requireAuth` + `requireTab("warehouse")` from `server/auth.ts` (org comes from the `X-Workspace-Slug` header). Requisition SUBMIT + own-requisition views are `requireAuth` only (any staff).
- **Tabs/UI wiring** (exact checklist): `shared/tabs.ts` → add `{ slug: "warehouse", title: "Warehouse", url: "/admin/warehouse" }` to `printsTabs` AND `"warehouse"` to `SUPER_ADMIN_ONLY_TABS`; `client/src/components/app-sidebar.tsx` → `printsNav` entry; `client/src/App.tsx` → routes; pages in `client/src/pages/warehouse-*.tsx` matching the visual style of the existing `prints-*.tsx` pages (dark premium, TanStack Query via `@/lib/queryClient`).
- **Frontend:** no CDN scripts — npm deps only, pinned exact versions. Scanner: `barcode-detector` ponyfill package (ZXing-C++ WASM, self-hosted assets) + native fast-path feature-detected via `getSupportedFormats()` contents (never `'BarcodeDetector' in window`). QR generation: the `qrcode` npm package.
- **Shopify:** GraphQL only (SPEC §4.3 / D9) via a minimal fetch-based client in `server/warehouse-sync.ts`; env vars per store (`WH_SHOPIFY_CUFC_TOKEN`, `WH_SHOPIFY_SIU_TOKEN`, store domains) read lazily; every push carries an idempotency key; mark mutation syntax `// TODO-verify(live)` — a human verifies against current shopify.dev before deploy. All sync behaviour behind env flags so the code is inert without config.
- **Do not touch** other features' code except the ONE flagged edit in T13 (smallest possible diff in `server/shop-routes.ts`). Never modify `deploy.sh`, `.github/`, existing migrations, or `drizzle.config.*`.
- **Commits:** one per task, message `loop(warehouse): T<n> <summary>`.

## Lessons learned (append-only)

- **2026-07-22 — THE TYPECHECK GATE IS `bash script/check-warehouse-gate.sh`, NOT a clean `npm run check`.** The canonical-2 base carries ~545 pre-existing tsc errors (routes.ts/schema.ts/storage.ts — snapshotted per-file in `script/BASELINE-TSC.txt`), so "check must be clean" was never achievable and is why the first loop runs stalled. The gate script passes iff warehouse-owned files have ZERO errors and no file regresses past its baseline count. Wherever PLAN.md/SPEC.md say `npm run check`, run the gate script instead. `npm run build` DOES pass at baseline and remains a hard gate for client-touching tasks.
- 2026-07-22 — a crashed earlier run mangled `package-lock.json` (restored from base 541b58a) and left a PARTIAL `shared/warehouse.ts` (2 tsc errors, no test script). T1 must finish/fix it, not start over blindly.

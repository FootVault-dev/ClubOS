# Warehouse Management System (WMS) — United Prints workspace, ClubOS

**Date:** 2026-07-13 · **Status:** PLANNED → loop build
**Requested by:** Daniel — "industry gold-standard warehouse management system inside the United Prints workspace… everything numbered, barcoded, scanned in and out… strict control of the flow of goods."
**Research foundation:** `outputs/deep-research/2026-07-13-warehouse-management-system/` (6 topic reports + critic + `synthesis.md` — the design authority for this plan)
**Codebase map:** Explore-agent survey 2026-07-13 (shop schema, print tables, tab wiring, Shopify client, siu-inventory-sync)
**SOP pack (human layer):** `outputs/warehouse/SOPs/`

---

## 1. The problem

One physical warehouse at United Sports Centre holds four brands' sellable merch (MFL + CIC on our own ClubOS commerce engine, SIU + CUFC on two Shopify stores), United Prints raw materials, club training equipment, and event stock. Inventory is "managed" by logging in and out of Shopify; staff walk in and take what they want; counts are fiction. Research confirms this is the *normal* failure state (65% of records wrong in a peer-reviewed 370k-record audit, even WITH software) — the fix is a movement-ledger system plus process, not either alone.

## 2. Decisions locked (Daniel, 2026-07-13)

1. **Phone-camera scanning day 1** — existing scanner/label hardware tested later.
2. **Track everything**: sellable merch + uniforms, print-shop materials, club equipment (loan/return), event stock.
3. **WMS is master** — pushes stock to SIU/CUFC Shopify; no more manual Shopify inventory.
4. **Locked room + named scans** — only named operators move stock; every movement is scanned against a person + reason; everyone else submits a requisition.

## 3. Design decisions (resolved by research + critic — see synthesis.md for sources)

| # | Decision | Key rationale |
|---|---|---|
| D1 | **Append-only movement ledger + derived stock** — `wh_movements` (signed deltas) is the truth; `wh_stock` is a cache maintained in the same transaction; nightly reconcile asserts `on_hand == SUM(delta)` | The universal shape (ERPNext/Odoo/InvenTree source-verified). Kills lost-update races and gives the audit trail we've never had |
| D2 | **`available` is DERIVED (`on_hand − reserved`), never stored** — atomic guards go on the stored `on_hand` (`UPDATE … WHERE on_hand + delta >= 0`), 0 rows = reject | Critic flag #1 — a stored decrementable `available` recreates the exact bug this project kills |
| D3 | **Hard reservations** for every paid-but-unfulfilled order (native + Shopify) — physical truth stays true: the shirt is on the shelf until it's picked | Oversell = reading on_hand instead of available |
| D4 | **Brand-segregated stock keying** `(item, location)` with `brand_owner` on the item — identical physical products owned by different brands are different items; a fungible-pool merge is a cheap later relaxation, the reverse is a painful migration | Critic flag #3; 3PL owner-dimension pattern |
| D5 | **QR labels, printed in-house** (DataMatrix for tiny) — no GS1 membership; manufacturer EANs registered as **aliases** (`wh_barcode_aliases`, many→one, `pack_qty` multiplier), never relabelled by default | iOS Safari gives web pages no autofocus/torch control → 1D scans poorly on iPhone; QR's error correction tolerates the blur. We own a print shop — labels are free |
| D6 | **Scanning stack:** ZXing-C++ WASM via the `barcode-detector` ponyfill (self-hosted), opportunistic native `BarcodeDetector` fast-path — feature-detect on `getSupportedFormats()` contents, never `'BarcodeDetector' in window`. Audio beep = the cross-platform confirm | Verified support matrix; 🔴 measure on a real iPhone before rollout (verify-at-build) |
| D7 | **SKU scheme** `BRAND-CAT-STYLE-COLOUR-SIZE`, uppercase, ≤20 chars, no 0/O I/l ambiguity; encode only durable attributes | "Smart codes become wrong" trap; SKU is the #1 sync-failure join key across every SMB platform |
| D8 | **Locations** `ZONE-AISLE-BAY-LEVEL` (shallow, human-speakable, numeric gaps for inserts) + named zones RECEIVING / PACK / DISPATCH / QUARANTINE + **virtual locations** (SUPPLIER / CUSTOMER / SCRAP / PRODUCTION) so every movement has a real from/to story | Odoo double-entry insight, simplified to signed rows |
| D9 | **Shopify sync: GraphQL only, one-directional.** `inventorySetQuantities` (name:`available`, `ignoreCompareQuantity:true` — Shopify's documented source-of-truth mode) + idempotency keys on every push. Webhooks consumed: `orders/create` (→ reservation), `orders/cancelled` + `refunds/create` (→ release/restock); `inventory_levels/update` consumed ONLY as a drift monitor with echo suppression. Reconcile poll every 10 min: auto-heal WMS-right drift, alert on unexplained | REST is legacy since Oct 2024; 🔴 `@idempotent` directive REQUIRED from 2026-04 — verify current syntax live at build. Existing Python REST client stays for ops scripts only |
| D10 | **Safety buffer 0 by default** (per-item override knob exists) — at a few orders/day with sub-10s pushes the race window is negligible; buffers are a high-velocity tax | Critic: the pro-buffer consensus was an SEO echo chamber; correctness comes from reservations + reconcile |
| D11 | **Native carts (MFL/CIC) become just another channel:** WMS pushes `available` into `shop_variants.stock` (which storefronts already read); the checkout's atomic stock guard stays as a race backstop; the payment webhook posts a **reservation** to the WMS; scan-at-dispatch posts the movement + consumes the reservation | Retires `shop_variants.stock` as truth without touching storefront contracts |
| D12 | **Counting doctrine:** blind counts (counter never sees expected), ABC cadence at club scale — A monthly, B quarterly, C twice-yearly; variance >10% or >$100 → independent recount; counter ≠ approver; approved variance posts an adjustment movement with a reason code | Club-scale numbers are our judgment call (flagged), doctrine is triangulated |
| D13 | **Requisitions + monthly chargeback** — staff request, operators pick in twice-daily windows, collected stock is charged to the drawing brand/department monthly. Two-bin kanban for cheap print consumables (no requisition friction where it isn't worth it) | The chargeback is the second deterrent: "help yourself" becomes an owned line item |
| D14 | **Equipment loans = library model:** named borrower, due date, condition-graded return, overdue **derived** (never stored), replacement charged | Tool-crib/AV standard; house derived-state doctrine |
| D15 | **Movement taxonomy from real systems** (InvenTree codes + Oracle Retail SIM reason codes): types `receipt · putaway · pick · dispatch · transfer · adjustment · count · consume · return · loan_out · loan_return`; reasons `damaged · shrinkage · count_variance · sample · write_off · store_use · event_use`; damaged stock moves to QUARANTINE (unavailable), it doesn't vanish | Don't invent taxonomy |
| D16 | **Negative stock blocked by default**; per-item `allow_negative` for bulk print materials where paperwork lags; enum-ish columns validated in `shared/warehouse.ts`, **no DB CHECKs on open value sets** (house rule — a stale CHECK 500'd the MFL checkout) | ERPNext ships exactly this toggle |
| D17 | **Named operator on every movement** (`operator_user_id NOT NULL`) — perceived certainty of detection is the deterrent that works (Hollinger & Clark) | The whole point |

## 4. Architecture

### 4.1 Schema — new `wh_*` tables (additive migration `2026-07-13_warehouse.sql`)

All in `apps/clubos/shared/schema.ts`, org-scoped where meaningful (warehouse lives in United Prints, org 8), money in cents, quantities `numeric(12,3)` (metres of vinyl), timestamps `timestamptz`.

- **`wh_items`** — everything stocked. `id`, `sku` (unique), `name`, `kind` (`merch|material|equipment|event`), `brand_owner` (`cufc|siu|mfl|cic|up|club`), `category`, `unit` (`ea|m|roll|box`), `purchase_unit`/`purchase_qty` (1 roll = 50 m), `allow_negative` (default false), `is_loanable`, `min_qty` (reorder alert), `cost_cents` (reference), `default_location_id`, `active`, `notes` + **channel mappings**: `shop_variant_id` (nullable FK → `shop_variants`, native carts) and `shopify_store` + `shopify_inventory_item_id` + `shopify_variant_id` (nullable, SIU/CUFC). Partial unique indexes on each mapping.
- **`wh_barcode_aliases`** — `code` (unique), `item_id`, `pack_qty` (default 1), `note`. Manufacturer EANs scan straight through.
- **`wh_locations`** — `code` (unique, e.g. `A-01-2`, `QUARANTINE`), `zone`, `kind` (`bin|zone|virtual`), `active`. Seeded virtuals: SUPPLIER, CUSTOMER, SCRAP, PRODUCTION.
- **`wh_movements`** — THE LEDGER. `id`, `group_id` (uuid — links multi-leg ops; transfer = −row + +row), `item_id`, `location_id`, `delta` numeric `CHECK (delta <> 0)`, `movement_type`, `reason_code`, `ref_kind`/`ref_id` (polymorphic: shop_order, shopify_order, print_order, requisition, loan, po, count), `operator_user_id` **NOT NULL**, `note`, `idempotency_key` (unique, nullable), `created_at`. **Append-only — no UPDATE/DELETE paths in code.**
- **`wh_stock`** — cache. Unique `(item_id, location_id)`, `on_hand`, `updated_at`. Maintained same-transaction via atomic upsert with non-negative guard (skipped when `allow_negative`).
- **`wh_reservations`** — `item_id`, `qty`, `ref_kind`/`ref_id`, `status` (`active|released|consumed`), timestamps. Partial unique `(ref_kind, ref_id, item_id) WHERE status='active'`. **`available(item) = Σ on_hand(sellable bins) − Σ active reservations`** — computed, never stored.
- **`wh_purchase_orders`** + **`wh_po_lines`** — supplier, status (`draft|sent|partial|received|closed|cancelled`), expected_on; lines: item, qty_ordered. `qty_received` derived from receipt movements referencing the line.
- **`wh_requisitions`** + **`wh_requisition_lines`** — requester (any staff, `requireAuth` like the Feedback board), `charge_to` (brand/department), status (`submitted|approved|picking|ready|collected|declined`), needed_by, approved_by, collected_at. Lines: item, qty_requested, qty_picked.
- **`wh_loans`** + **`wh_loan_lines`** — borrower_name + borrower_contact_id (nullable FK contacts — coaches may lack ClubOS logins), due_on, status (`out|returned`), **overdue derived** (`due_on < nzTodayIso() AND status='out'`), condition_grade + condition_note per returned line, replacement_charged_cents.
- **`wh_counts`** + **`wh_count_lines`** — session: scope (zone/class), `blind` (default true), counted_by, approved_by (`counted_by <> approved_by` enforced app-side), status. Lines: item, location, expected_qty (snapshot, hidden from counter UI), counted_qty, resolution (`accepted|recount`), posted movement group on approval.
- **`wh_shopify_events`** — webhook dedupe: `webhook_id` unique, topic, store, processed_at.
- **`wh_sync_state`** — per mapped item×store: last_pushed_qty, last_pushed_at, pending, last_drift_at, drift_note. Echo suppression + the sync dashboard's data.

### 4.2 The movement engine (`server/warehouse.ts` + `shared/warehouse.ts`)

One function every flow goes through — `postMovementGroup(tx, {legs, type, reason, ref, operator, idempotencyKey})`:
1. Validate types/reasons in `shared/warehouse.ts` (no DB CHECKs).
2. Insert ledger rows (idempotency key: unique-violation = already processed, return prior result).
3. For each leg: atomic `INSERT … ON CONFLICT (item,location) DO UPDATE SET on_hand = wh_stock.on_hand + $delta WHERE wh_stock.on_hand + $delta >= 0 RETURNING` (guard skipped for allow_negative items). Zero rows → whole transaction rejects with a clean "insufficient stock at LOCATION" error.
4. Enqueue channel push for mapped items (after commit).
Nightly reconcile job: assert cache == Σledger per (item, location); auto-repair cache from ledger + alert on any repair (a repair means a code path bypassed the engine).

### 4.3 Channel sync (`server/warehouse-sync.ts`)

- **Push:** on any movement/reservation change touching a mapped item → debounce ~5 s → compute `available` → (a) Shopify-mapped: GraphQL `inventorySetQuantities` (available, ignoreCompareQuantity, idempotency key = push uuid) against the right store; (b) native-mapped: `UPDATE shop_variants SET stock = $available`. New minimal **TS GraphQL client** (fetch-based, per-store tokens from env) — the Python REST client is NOT in the serving path.
- **Inbound Shopify:** `orders/create` → dedupe on `X-Shopify-Webhook-Id` → hard reservation per line (SKU/variant-mapped); `orders/cancelled` + `refunds/create` → release/restock. Staff fulfil via the WMS pick queue → dispatch scan posts the movement, consumes the reservation, marks the Shopify order fulfilled (existing fulfillment API path).
- **Drift:** `inventory_levels/update` webhook + 10-min reconcile poll → if Shopify ≠ our last push and it wasn't our echo → auto re-push (WMS is master) + log to `wh_sync_state`; repeated unexplained drift = dashboard alert (someone is editing Shopify by hand).
- **SIU sibling-variant logic** (Plain/Player/Custom = one physical shirt) moves INTO the WMS mapping: three Shopify variants map to one `wh_item`; push fans out to all three. Retires `apps/siu-inventory-sync`'s core job (keep it running until cutover).

### 4.4 Scan station + admin UI

- **`/admin/warehouse/scan`** — mobile-first, full-screen; the operators' home. Flow: scan any code → system identifies item (SKU/alias) or location → big-button context actions (Receive · Putaway · Pick · Dispatch · Transfer · Consume→print job · Loan out · Return · Count). Continuous-scan loop, audio confirm, torch button where supported. ZXing-WASM ponyfill self-hosted in `client/public/`.
- **`/admin/warehouse`** — dashboard (stock health, low-stock alerts, pending requisitions, overdue loans, drift alerts, recent movements feed) + sections: Items (+ label printing), Locations (+ labels), Purchase Orders, Requisitions, Loans, Counts, Sync, Ledger (filterable movement history — the audit trail view).
- **Label printing:** print-sheet pages rendering QR SVGs client-side — item labels (QR = SKU) and bin labels (QR = `LOC:` + code), 50×25 mm singles + A4 grid layouts for UP's own printers.
- **Tab wiring** (copy the `print-sales` pattern exactly): `shared/tabs.ts` → `printsTabs` + `SUPER_ADMIN_ONLY_TABS` (dark launch); sidebar `printsNav`; `App.tsx` routes; `requireTab("warehouse")`. Requisition submission is `requireAuth` (any staff, any workspace — same universal pattern as Feedback).
- **ClubOS Mobile:** the scan station is mobile-web day 1 (satisfies the spirit of the standing rule); a native `apps/clubos-mobile` screen wrapping the same flows is a fast-follow, noted in that project's backlog.

### 4.5 What v1 deliberately excludes

Wave/zone picking, slotting optimisation, labor management, yard/dock scheduling, full event-sourcing machinery (projectors/replay), lot/batch + serial tracking (dormant nullable field only), automated BOM consumption (v1 = manual consume-scan against a print order; per-material BOMs later), POS. Research verdict: the small-warehouse regret is over-building, not under-building.

## 5. Branch & deploy strategy

- **Base:** `integration/canonical-2` (worktree `.worktrees/canonical2`, head `541b58a`) — verified: `feat/mfl-shop` is an ancestor, so the full `shop_*` schema + storefront backends are present. Building on anything older would FK into tables the branch doesn't have.
- **Build isolation:** new worktree `apps/clubos/.worktrees/warehouse` on branch **`loop/warehouse`** cut from `integration/canonical-2`. **No `.env` in the worktree** — the loop cannot reach prod (budget-automation loop precedent). The main checkout (currently `feat/cic-skills-scoring`, shared with a second Claude session) is never touched.
- **Migration:** `migrations/2026-07-13_warehouse.sql` + `script/apply-warehouse.ts` copied near-verbatim from `apply-print-sales.ts` — `--dry-run` = BEGIN → full migration → verify every table/index via `to_regclass`/`pg_indexes` (assert partial indexes carry WHERE) → ROLLBACK. Prod DB already has `shop_*` tables (seeded 07-06), so the FKs are satisfiable regardless of deployed code.
- **Deploy (LATER, gated on Daniel):** deploying the WMS means deploying the canonical-2 lineage → **it ships the shop-outage fix in the same train** (good — that's overdue) but per house rules: probe prod first, `git log prod-branch..deploy-branch` both directions to see what a deploy adds/removes, merge live prod branch in, deploy from a detached worktree, re-probe after. Also register the two new Shopify webhooks + set per-store GraphQL tokens in Fly secrets at cutover.

## 6. Loop build plan (`scripts/loop/run_loop.sh`)

Setup: worktree + `PROMPT.md` / `PLAN.md` / `AGENTS.md` at the worktree root (from `scripts/loop/*.template.md`). Loop model: sonnet (harness default). Gate per task: `npm run check` (tsc) + `npm run build` green + vitest for engine tasks. Independent `verify.sh` pass at the end against `VERIFY.md`. Suggested run: `bash scripts/loop/run_loop.sh apps/clubos/.worktrees/warehouse warehouse 30 30.00` under `caffeinate -is`.

**PLAN.md backlog (ordered):**
- T1 `shared/warehouse.ts` — enums (movement types, reasons, kinds, statuses), validators, `availableQty` helper, types. Unit tests.
- T2 `shared/schema.ts` — all `wh_*` Drizzle tables (§4.1) + `migrations/2026-07-13_warehouse.sql` (additive, IF NOT EXISTS, identity PKs, partial uniques) + `script/apply-warehouse.ts` (dry-run rehearsal pattern).
- T3 Movement engine `server/warehouse.ts` — `postMovementGroup` (§4.2) + vitest: concurrency (two picks racing the last unit — one must fail), idempotency replay, allow_negative, transfer legs.
- T4 Items + locations + aliases: storage layer, routes (`/api/admin/warehouse/*`, `requireTab("warehouse")`), label-payload endpoints.
- T5 Reservations + `available` computation + reserve/release/consume paths + vitest.
- T6 Receiving: PO CRUD + receive-scan endpoint (over/short/damage → QUARANTINE + discrepancy record).
- T7 Putaway + transfers + the generic scan resolver (`POST /scan` → code → item|location|unknown + valid actions).
- T8 Pick/dispatch: pick queue (native orders, Shopify orders, requisitions) + dispatch scan → movement + reservation consume + (Shopify) fulfilment call stub behind env flag.
- T9 Requisitions end-to-end + monthly chargeback report endpoint (per brand/department, cents).
- T10 Loans: check-out/return, overdue derived, condition grades, replacement charge record.
- T11 Counts: blind sessions, snapshot expected, variance workflow, counter≠approver, approval posts adjustment movements.
- T12 Sync worker (§4.3): TS GraphQL client, push queue + debounce, webhook handlers + dedupe, echo suppression, reconcile poll, `wh_sync_state`. Vitest with mocked Shopify.
- T13 Native-cart integration: checkout availability reads pushed `shop_variants.stock` (unchanged contract); payment webhook posts WMS reservation when variant is mapped; feature-flag `WMS_NATIVE_SYNC`.
- T14 Label printing pages (QR SVG, 50×25 + A4 grid).
- T15 Scan station UI (mobile-first, §4.4) — ZXing-WASM ponyfill, continuous scan, action sheets.
- T16 Admin pages: dashboard, items, locations, POs, requisitions, loans, counts, sync, ledger.
- T17 Tab wiring + dark launch + sidebar + routes.
- T18 Seed script `script/seed-warehouse.ts`: virtual locations, zones RECEIVING/PACK/DISPATCH/QUARANTINE, import mapped `wh_items` from existing `shop_variants` (MFL/CIC) — **no bin layout, no quantities invented: opening stock comes from Daniel's first real count.**
- T19 `apps/clubos/WAREHOUSE.md` runbook + nightly reconcile cron wiring.
- T20 `preview/` fixture mount + ui-preflight screenshots (mobile 390×844 + desktop) of scan station + dashboard.

## 7. Verify-at-build (never hardcode — check live)

1. 🔴 Shopify `@idempotent` directive — required from 2026-04; confirm current mutation syntax on the latest stable API version.
2. 🔴 ZXing-WASM scan latency on a real iPhone (Daniel's) before declaring the scan station done.
3. GraphQL cost bucket (50 vs 100/s — irrelevant at our volume, but log the header).
4. Whether REST inventory endpoints still respond (don't use them regardless).
5. Which items are cross-brand fungible and which materials get `allow_negative` — **human answers from Daniel/Dima at seed time.**

## 8. Human gates & open items for Daniel

1. **Deploy gate** — WMS rides the canonical-2 train and ships the shop fix with it; explicit go required.
2. **First physical setup** — shelve/zone the room, print bin labels, run the opening count (the system starts empty; opening stock = first count, not an invented number).
3. **Name the operators** — who besides the print manager gets warehouse-tab access + keys.
4. **Chargeback recipients** — which brands/departments requisitions are charged to (suggest: CUFC/SIU/MFL/CIC/USC/Academy/Office).
5. **Session decision from research, already applied:** no GS1 membership, no dedicated scanner purchases yet.

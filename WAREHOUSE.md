# Warehouse (WMS) — runbook

**Status (2026-07-22): built + tested on branch `loop/warehouse`, worktree
`apps/clubos/.worktrees/warehouse`. NOT deployed. Migration NOT applied.
Nothing seeded. No Shopify credential has ever been set — the sync engine has
never made a real HTTP call.** This worktree has no `.env`/`DATABASE_URL` by
design (loop-isolation rule) — every step below is written to be RUN by a
human, from a real checkout with real credentials, not by the loop.

One physical warehouse at United Sports Centre, tracked in the **United
Prints workspace** (org 8) at `/admin/warehouse`: sellable merch for MFL/CIC
(native ClubOS commerce) and SIU/CUFC (Shopify), print-shop materials, club
equipment loans, and event stock. Full design: `SPEC.md` (read first — this
file is the "how do I actually turn it on" companion, not a second copy of
the architecture). Research behind the design: `SYNTHESIS.md`. Build history
+ every decision made while building it: `PLAN.md`'s `## Done` section and
`AGENTS.md`'s lessons-learned log — read those before changing any warehouse
behaviour, they record *why*, not just *what*.

The feature is **dark-launched**: `"warehouse"` sits in `SUPER_ADMIN_ONLY_TABS`
(`shared/tabs.ts`), so only super-admins see the tab until Daniel decides to
grant it to the Print manager (Dima) via `/admin/team`.

---

## 1. Env vars

None of these exist anywhere today (no `.env` in this worktree, and none of
them are referenced in the real ClubOS `.env` yet — this is the full list a
human sets at cutover). Every one is read **lazily**, per call, never cached
at module load — so the whole subsystem is inert with any subset missing.

| Var | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | everything | already required by the rest of ClubOS — nothing warehouse-specific |
| `WH_SYNC_ENABLED` | `server/warehouse-sync.ts` (`isSyncEnabled`) | `"1"` turns on the debounced push-to-Shopify/native queue. Unset = every movement still posts to the ledger correctly, it just never pushes outward. **Turn this on only after the item↔Shopify mappings below are correct** — the first push after enabling asserts our on-hand as the store's truth. |
| `WH_SHOPIFY_SIU_DOMAIN` | sync | SIU store's `*.myshopify.com` domain |
| `WH_SHOPIFY_SIU_TOKEN` | sync | SIU custom-app Admin API access token |
| `WH_SHOPIFY_SIU_LOCATION_GID` | sync | `gid://shopify/Location/…` — the warehouse's Shopify location for SIU |
| `WH_SHOPIFY_SIU_WEBHOOK_SECRET` | sync (webhook route) | the SIU custom app's API secret key (signs webhook HMACs) |
| `WH_SHOPIFY_CUFC_DOMAIN` | sync | CUFC store's `*.myshopify.com` domain |
| `WH_SHOPIFY_CUFC_TOKEN` | sync | CUFC custom-app Admin API access token |
| `WH_SHOPIFY_CUFC_LOCATION_GID` | sync | `gid://shopify/Location/…` for CUFC |
| `WH_SHOPIFY_CUFC_WEBHOOK_SECRET` | sync (webhook route) | the CUFC custom app's API secret key |
| `WH_SHOPIFY_FULFIL` | `server/warehouse-routes.ts` (`notifyShopifyFulfilled`, inside `POST /dispatch`) | `"1"` enables a **stub only** — it just `console.log`s "would mark fulfilled". The real `fulfillmentCreate` GraphQL call is written in `warehouse-sync.ts` (flagged `// TODO-verify(live)`) but nothing wires it into dispatch yet. Setting this to `1` today does not actually fulfil anything in Shopify — don't rely on it for real fulfilment status until that wiring is a real task. |
| `WMS_NATIVE_SYNC` | `server/shop-routes.ts` (`finalizeShopOrderPaid`) | `"1"` makes a **paid native order** (MFL/CIC storefront) also post a WMS reservation for any line whose variant is mapped to a `wh_items` row. Best-effort/try-catch — a WMS hiccup never fails the customer's payment. Scoped to the single-order payment-confirm path only, **not** the Player-Pay/team-kit path (`finalizeTeamOrderAllPaid`) — see `AGENTS.md`'s 2026-07-22 (T13) entry for why. |

Per-store vars follow the pattern `WH_SHOPIFY_<STORE>_<FIELD>` where
`<STORE>` is `SIU` or `CUFC` (`shared/warehouse.ts`'s `SHOPIFY_STORES`) — a
future third Shopify-mapped store needs no code change, just its own 4 vars
(`getShopifyPushConfig`/`getShopifyWebhookSecret` derive the prefix from the
store key at runtime).

**Fly deploy note:** at real cutover these all become `fly secrets set
WH_SHOPIFY_SIU_TOKEN=... WH_SHOPIFY_CUFC_TOKEN=... ...` (etc.) against the
ClubOS app — same mechanism as every other secret this app already uses. Set
them **before** flipping `WH_SYNC_ENABLED=1`, never after.

---

## 2. Migration + seed steps

Two scripts, both dry-run by default (print what they'd do, touch nothing),
`--apply` to actually write. Run from a real checkout with `DATABASE_URL` set
— never from this loop worktree.

```bash
cd apps/clubos

# 1. Migration — additive only (CREATE TABLE/INDEX IF NOT EXISTS). Dry-run
#    BEGINs, runs the migration, verifies every table (to_regclass) + every
#    index (pg_indexes, asserts partial indexes actually carry a WHERE), then
#    ROLLBACKs. Prod already has shop_variants/organizations/users/contacts,
#    so every FK here is satisfiable regardless of what code is deployed.
npx tsx --env-file=.env script/apply-warehouse.ts            # dry-run
npx tsx --env-file=.env script/apply-warehouse.ts --apply    # commits

# 2. Seed — two independent, idempotent jobs (safe to re-run):
#    (a) locations: the 4 virtual codes (SUPPLIER/CUSTOMER/SCRAP/PRODUCTION)
#        + the 4 named zones (RECEIVING/PACK/DISPATCH/QUARANTINE). NO
#        physical bins — those come from walking the room (§5 below).
#    (b) items: maps every MFL (org 3) + CIC (org 5) shop_variants row into
#        a wh_items row, channel-mapped via shop_variant_id. SIU/CUFC are
#        deliberately NOT seeded here — they're Shopify-mapped, resolved by
#        the mapping step in §4 below, not this catalogue import.
npx tsx --env-file=.env script/seed-warehouse.ts            # dry-run
npx tsx --env-file=.env script/seed-warehouse.ts --apply    # writes
```

Run the migration **before** the seed script (the seed script inserts into
tables the migration creates). Both refuse to run without `DATABASE_URL` —
neither has ever been executed against any database, including in this
worktree (there isn't one here).

**What is deliberately NOT seeded, by design** (opening numbers must come
from a real count, never be invented): `wh_stock` (all quantities),
`default_location_id` on any item (no bin exists yet to default to),
`min_qty`/`cost_cents` (Daniel/Dima's call). CIC gift-card variants and
variants under an archived `shop_products` row are skipped entirely — see
the seed script's own header comment for why.

**⚠️ `script/*.ts` is not in `tsconfig.json`'s `include`** — `npm run
check`/`bash script/check-warehouse-gate.sh` do not typecheck either script.
Both were verified with an isolated one-off `tsc --noEmit --strict …`
invocation during the build (see `AGENTS.md`'s 2026-07-22 (T18) entry) —
worth re-running that same one-off check if either script is edited before
running it for real.

---

## 3. Webhook registration steps

The WMS listens for exactly one URL, keyed by store:

```
POST /api/public/warehouse/shopify/:store/webhook
```

where `:store` is `siu` or `cufc`. It verifies the `X-Shopify-Hmac-Sha256`
header against the matching `WH_SHOPIFY_<STORE>_WEBHOOK_SECRET`, dedupes on
`X-Shopify-Webhook-Id` (table `wh_shopify_events`), and dispatches on
`X-Shopify-Topic`. If a store's webhook secret isn't set yet, the route
**200s an ignored event** rather than 401ing or crashing — so it's safe to
register webhooks before every env var is in place, they just no-op until
the secret lands.

Four topics need subscriptions, on **both** stores:

| Topic | What it does in the WMS |
|---|---|
| `orders/create` | posts a hard reservation per mapped line (sums quantity per `wh_item` first — one order can map two different Shopify variants to the same physical item, e.g. SIU's Plain/Player/Custom fan-out) |
| `orders/cancelled` | releases every reservation on that order |
| `refunds/create` | releases only the refunded (non-`no_restock`) lines — a partial refund does not release the whole order |
| `inventory_levels/update` | **drift monitor only** — never a write path. If Shopify's number differs from our last push and it wasn't our own echo, it's logged to `wh_sync_state` and re-pushed (WMS is master, D9) |

**Register these via the Shopify Admin API** (GraphQL `webhookSubscriptionCreate`,
or the Admin UI's Notifications → webhooks page if you'd rather click through
it once per store) pointed at:

```
https://<clubos-prod-domain>/api/public/warehouse/shopify/siu/webhook
https://<clubos-prod-domain>/api/public/warehouse/shopify/cufc/webhook
```

There is no `register-webhook.mjs`-style script in this repo for the WMS
(unlike `apps/siu-inventory-sync/scripts/register-webhook.mjs`, which only
ever registered the one `orders/create` topic for its own narrower job) — a
human does this once per store, per topic, after the ClubOS deploy carrying
this code is live (registering against a URL that 404s is harmless but
pointless). The custom app's access token needs read access to orders/refunds
and write access to inventory (`write_inventory` at minimum for the push
side) — **verify the exact scope names against the current Shopify Partners
dashboard at setup time**, they are not hardcoded anywhere in this codebase.

---

## 4. Shopify mapping how-to

Every `wh_items` row that should sync to Shopify needs three fields set:
`shopify_store` (`'siu'` or `'cufc'`), `shopify_variant_id`,
`shopify_inventory_item_id`. A native-commerce item (MFL/CIC) instead sets
`shop_variant_id` (FK straight into the existing `shop_variants` table —
that's what the seed script already does for every MFL/CIC row).

**⚠️ There is currently no admin-UI form field for the three Shopify mapping
columns** — `client/src/pages/warehouse-items.tsx`'s create/edit forms only
cover the core item fields (sku/name/kind/brandOwner/category/unit/etc.).
The backend fully supports it (`PATCH /api/admin/warehouse/items/:id` accepts
`shopifyStore`/`shopifyVariantId`/`shopifyInventoryItemId` in its body,
confirmed in `server/warehouse-routes.ts`), so until a future task adds the
UI fields, set them via a direct API call:

```bash
curl -X PATCH https://<clubos-prod-domain>/api/admin/warehouse/items/<id> \
  -H "Cookie: <staff session cookie>" -H "Content-Type: application/json" \
  -d '{"shopifyStore":"siu","shopifyVariantId":"gid://shopify/ProductVariant/...","shopifyInventoryItemId":"gid://shopify/InventoryItem/..."}'
```

Get the two Shopify GIDs from the Shopify Admin GraphQL API (or the product
URL's numeric id, formatted as the GID) for the variant you're mapping.

**SIU's Plain/Player/Custom sibling fan-out is a second table,
`wh_shopify_variant_links`** (item ↔ *extra* sibling variant — the primary
`wh_items.shopify_*` columns above stay the primary mapping). Three physical
identical shirts, three separate Shopify variants (different `Printing`
option) — one `wh_item`, one primary mapping, plus **two**
`wh_shopify_variant_links` rows for the other two variants. This is what
`apps/siu-inventory-sync` did with a live `orders/create` webhook decrement;
the WMS instead pushes the *same* computed `available` to every fanned-out
variant on every sync. **This table also has no admin-UI CRUD yet** — a
future task, or a one-off `INSERT INTO wh_shopify_variant_links (item_id,
store, shopify_variant_id, shopify_inventory_item_id, note) VALUES (...)` at
cutover time, populated from a same-size cross-reference of the three
Printing variants in Shopify. The read side already exists and works: `GET
/api/admin/warehouse/sync-state` (the Sync tab, `warehouse-sync.tsx`) joins
and displays these links today — only the write side is missing.

Once mapped, `WH_SYNC_ENABLED=1` + the right per-store env vars make every
stock-affecting movement debounce (~5s) into a push: Shopify-mapped items go
via GraphQL `inventorySetQuantities` (`name:'available'`,
`ignoreCompareQuantity:true`), native-mapped items via a plain `UPDATE
shop_variants SET stock = …`. **🔴 Verify the `inventorySetQuantities`
mutation's exact current syntax on shopify.dev before the first real push** —
Shopify's `@idempotent` client directive became required from API version
2026-04, and `server/warehouse-sync.ts` (`SHOPIFY_API_VERSION = "2026-01"`,
flagged `// TODO-verify(live)`) was written from spec prose, never executed
against a live store.

---

## 5. Cutover checklist

In order — earlier steps must be done and verified before later ones, this
is not a menu:

1. **Apply the migration** (§2) against the real prod DB.
2. **Run the seed script** (§2), `--apply`.
3. **Physically set up the room** — Daniel/Dima shelve and zone it, print bin
   labels (`/admin/warehouse/labels`), name the operators who get warehouse
   access. The system starts with zero bins and zero stock on purpose.
4. **Run the first real count** — `/admin/warehouse/counts` → create a
   session scoped to everything → walk the room → submit → approve. This is
   opening stock. Nothing before this step should ever show a non-zero
   `on_hand` for anything (there's nothing to show — no bins existed).
5. **Map Shopify items** (§4) for every SIU/CUFC SKU that should sync,
   including the SIU sibling-variant links.
6. **Set the Shopify env vars** (§1) as Fly secrets — do this before step 7.
7. **Deploy** the ClubOS lineage carrying this branch. Follow the house
   deploy discipline from `CLAUDE.md`/`SPEC.md` §5: probe prod first, diff
   `git log prod-branch..deploy-branch` both directions to see what the
   deploy adds *and removes*, merge the live prod branch in, deploy from a
   detached worktree, re-probe after.
8. **Register the two Shopify webhooks** (§3) against the now-live URL.
9. **Flip `WH_SYNC_ENABLED=1`.** The very next movement on a mapped item
   pushes our on-hand to Shopify as truth — make sure step 4/5 are genuinely
   done first, not just "close enough".
10. **Watch the Sync tab** (`/admin/warehouse/sync`) for a few days: per-store
    configured status, the mappings table, and the drift log. Manually hit
    "Push now" on a couple of known-good items to prove the push path works
    end-to-end before trusting it unattended.
11. **Only once the sync dashboard has run clean for a real stretch (no
    unexplained drift, fulfilment matching reality):**
    - **Retire `apps/siu-inventory-sync`** — it did one job (decrementing
      SIU's Plain/Player/Custom siblings on `orders/create`), which the WMS's
      `wh_shopify_variant_links` fan-out now fully replaces. Delete its
      Shopify webhook subscription (Admin API or Admin UI — same
      `orders/create` topic the WMS is now also independently subscribed
      to; leaving both registered would double-process the same order
      through two unrelated systems), then tear down its Vercel project
      (`vercel remove siu-inventory-sync` or delete via the dashboard) and
      its `CRON_SECRET`/`SHOPIFY_SIU_*` env vars. Do **not** do this before
      the WMS's own sibling-link mappings (§4) are confirmed correct — there
      would be a gap with nothing keeping the three variants in sync.
    - Consider enabling `WMS_NATIVE_SYNC=1` (MFL/CIC native-cart reservations
      at payment time — currently unset everywhere, fully dark).
    - Open the `warehouse` tab beyond super-admin (remove the line from
      `SUPER_ADMIN_ONLY_TABS` in `shared/tabs.ts`) once Daniel and Dima have
      shaped the workflow together.
12. **Decide chargeback recipients** for requisitions (suggested in
    `SPEC.md` §8: CUFC/SIU/MFL/CIC/USC/Academy/Office) and which materials
    get `allow_negative` — both are Daniel/Dima calls, not something to
    infer from this codebase.

---

## 6. Nightly reconcile — cron note

Two *different* reconcile functions exist, both **fully built and unit
tested, neither wired to any scheduler yet**:

- **`reconcileStock()`** (`server/warehouse.ts`) — the ledger-vs-cache
  reconcile from D1/SPEC §4.2: compares `wh_stock.on_hand` against
  `SUM(wh_movements.delta)` per `(item, location)`, repairs any drift, and
  reports every repair (a repair happening at all means some code path
  bypassed `postMovementGroup` — that should never happen, so any non-empty
  result here deserves a human look, not just an auto-heal-and-forget). No
  HTTP route calls this today; it's only reachable by importing it directly.
- **`runReconcilePoll()`** (`server/warehouse-sync.ts`) — the *Shopify* drift
  poll from D9: for every Shopify-mapped item, fetches the store's current
  `inventoryLevel` and compares it against our last push, auto-healing (WMS
  is master — always re-push our own number, never adopt Shopify's) or
  flagging genuinely unexplained drift. This one **is** reachable today, but
  only via a manual button: `POST /api/admin/warehouse/reconcile-poll` (the
  Sync tab's "Run reconcile poll now" button) — no automatic schedule.

Neither is in `server/index.ts`'s cron registrations (`startPrintCron`,
`startLeagueBalanceCron`, `startAdSpendCron`, `startAttributionMaintenanceCron`,
`startBehaviorRollupCron` — grep that file for the full list). Wiring either
one on an actual interval is a **future task**, not done by this one. The
existing `server/print-cron.ts` is the established pattern to copy — a
`setInterval` + a staggered first-run `setTimeout` so it doesn't block server
boot, registered in `server/index.ts` next to the other `start*Cron()` calls.
Suggested cadence once that task is picked up: `reconcileStock()` nightly
(it's a full-catalogue ledger scan — cheap, but no reason to run it more than
daily), `runReconcilePoll()` every 10 minutes (D9's own stated interval,
matching the manual button's own purpose — the poll is meant to be frequent
enough to catch a hand-edit in Shopify quickly).

---

## Where things live (quick file map)

| File | What |
|---|---|
| `shared/warehouse.ts` | taxonomy, validators, pure stock math — the ONE place enum-ish values are checked (no DB CHECKs, house rule) |
| `shared/schema.ts` | all 17 `wh_*` Drizzle tables |
| `migrations/2026-07-13_warehouse.sql` | the additive migration |
| `server/warehouse.ts` | the movement engine (`postMovementGroup`, reservations, scan resolver, `reconcileStock`) |
| `server/warehouse-routes.ts` | every `/api/admin/warehouse/*` HTTP route |
| `server/warehouse-sync.ts` | Shopify GraphQL client, push debounce, webhook handlers, `runReconcilePoll` |
| `client/src/pages/warehouse-*.tsx` | scan station, labels, dashboard, items, locations, POs, requisitions, loans, counts, sync, ledger |
| `script/apply-warehouse.ts` / `script/seed-warehouse.ts` | migration runner / catalogue seeder (§2) |
| `script/test-warehouse-*.ts` | DB-free logic tests (`npx tsx script/test-warehouse-<x>.ts`) — run these after any change to `shared/warehouse.ts` or `server/warehouse*.ts` |
| `script/check-warehouse-gate.sh` | the real typecheck gate for this feature (`npm run check` alone is not — see `AGENTS.md`'s 2026-07-22 entry) |

---

# Warehouse v2 — assets, custom fields, counter sale (2026-07-27)

Extends the live WMS. Design decisions **D18–D25** are documented in the header
of `migrations/2026-07-27_warehouse_v2.sql` — read that before changing any of
this. Source requirement: Dima's *ClubOS — Warehouse Module Specification (v1)*.

## What v2 adds

| | |
|---|---|
| **Assets** (`/admin/warehouse/assets`) | Things owned one-by-one — presses, tools, furniture. Serial, condition, warranty, and **where it is / who has it**. |
| **Item fields** (`/admin/warehouse/fields`) | Add a field to a category and it appears on every item in it. No migration, no deploy. Admin-only to edit. |
| **Custody locations** | `person` and `vehicle` join bin/zone/virtual, so "issued to Riley" and "in the van" are real locations. |
| **Counter sale** | A tenth action on the scan station. **Works offline** — queues locally and posts when the connection returns. |

## Deploy steps (in this order)

1. **Rehearse the migration** — runs it inside a transaction and rolls back,
   asserting every object exists AND that nothing existing changed:
   ```
   npx tsx --env-file=.env script/apply-warehouse-v2.ts
   ```
2. **Apply it** (still before the deploy — the columns are additive, so the
   currently-running build ignores them):
   ```
   npx tsx --env-file=.env script/apply-warehouse-v2.ts --apply
   ```
3. **Deploy** from a clean detached worktree at your own commit, after
   re-deriving the prod superset (see the deploy doctrine in CLAUDE.md).
4. **Grant Dima the tab** — `/admin/team` → United Prints → tick **Warehouse**.
   The tab is no longer super-admin-only, but access is still per-member.

## The opening count — how stock actually gets in

Quantities are all zero on purpose. **Opening stock comes from a real physical
count, never a typed-in guess.** There is no bulk-import quantity field
anywhere, by design: even the first stock take is a sequence of ledger rows, so
the audit trail is complete from day one.

1. Lay out the room and create the bins (`/admin/warehouse/locations`), then
   print bin labels from the Locations page.
2. Open a count (`/admin/warehouse/counts`) for a zone.
3. Walk it with a phone: `/admin/warehouse/scan` → scan the bin → **Count** →
   scan each item and enter what is on the shelf.
4. Approve the count. **The counter cannot be the approver** — that is the
   control, not an inconvenience.

Counts are blind: the person counting never sees the expected number.

## Assets — getting the first ones in

1. Create the item (`/admin/warehouse/items`) with a category, e.g. *Production
   equipment*.
2. Switch it to **Tracked asset**. This is only possible while the item has no
   history at all (D18) — after that it is a deliberate data migration, not a
   toggle, and the API refuses it with an explanation.
3. `/admin/warehouse/assets` → **Add asset** for each physical unit: asset tag,
   serial, where it lives, warranty.
4. Print its label. The QR encodes `AST:<tag>`, which the scan station resolves
   straight to that one unit.

**A move or a retirement is always a ledger entry.** The API refuses a PATCH
that tries to change an asset's location or condition — that is not an
oversight, it is the whole point.

## Custom fields — the self-service bit

`/admin/warehouse/fields` → **Add field**. Pick the category, the label, the
kind of answer, and whether it describes **the item** (every roll of that vinyl
is 610mm) or **each unit on its own** (this van's WOF expires in September).

Two things worth knowing before you use it in anger:

- The saved field name is derived from the label **once** and then frozen. You
  can rename the label freely afterwards without losing a single answer.
- **Deleting a field does not delete the answers.** They are kept, and the app
  tells you how many were left behind. Add the field back and they reappear.

## Counter sale + offline

Scan the item → **Sell** → pick the bin → quantity. If the connection is down
the sale is banked locally and an amber strip on the scan station shows what is
waiting; it drains automatically when the network returns, and there is a
**Send now** button.

🔴 **The safety property:** the idempotency key is minted on the phone *before*
the request goes out and stored with the queued sale, so a retry after a lost
response is a no-op server-side rather than a second shirt off the shelf. Never
"simplify" this by generating the key server-side or per-attempt.

A sale the server permanently refuses (bad location, item gone) is dropped from
the queue and reported, rather than wedging every sale behind it forever.

## Files

| Path | What |
|---|---|
| `migrations/2026-07-27_warehouse_v2.sql` | Schema + the D18–D25 rationale |
| `script/apply-warehouse-v2.ts` | Dry-run/apply with additive assertions |
| `server/warehouse-instances.ts` | Asset lifecycle + typed custom fields |
| `server/warehouse-v2-routes.ts` | The v2 API |
| `client/src/pages/warehouse-assets.tsx` | Assets screen |
| `client/src/pages/warehouse-field-templates.tsx` | Field editor |
| `client/src/components/warehouse-custom-fields.tsx` | Dynamic field renderer |
| `client/src/lib/warehouse-offline-queue.ts` | Offline sale queue |
| `script/test-warehouse-v2.ts` · `script/test-warehouse-offline.ts` | Tests |

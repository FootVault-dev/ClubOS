# SIU Store — pinned build contract (2026-09-09)

Moving shop.southislandunited.com off Shopify (Basic plan) onto the ClubOS `shop_*` engine.
SIU becomes the **fourth brand** after MFL, CIC and CUFC (CUFC landed 15:59 today, commit
`3225d1b`..`d15b34d` — this branch descends from it; do not undo any of it).

Audit + raw Shopify exports: `outputs/siu-shop/2026-09-09-shopify-audit/` in the AIOS workspace
(`products-raw.json` 40 products / 358 variants / 90 images · `orders-raw.json` 259 · `customers-raw.json` 458).

## Brand row (server/shop-routes.ts SHOP_BRANDS)

```ts
siu: {
  brandKey: "siu",
  orgId: 2,
  storeName: "South Island United Store",
  orderPrefix: "SIU",
  assetBase: "https://join.southislandunited.com",
  currency: "NZD",
  adminEmail: "info@southislandunited.com",
  allowedOrigins: [
    /^https:\/\/(www\.)?southislandunited\.com$/,
    /^https:\/\/shop\.southislandunited\.com$/,
    /^https:\/\/siu-shop\.vercel\.app$/,
  ],
  storefrontBase: "https://shop.southislandunited.com",
}
```

## THE ONE NEW ENGINE FEATURE — printing as a priced add-on

Shopify models printing as a third option axis (`Printing: None / Player / Custom`), so ONE
physical shirt is three variants sharing a stock pool. That is the bug `apps/siu-inventory-sync`
exists to paper over. **Do not reproduce it.** Stock stays per (colour × size); printing becomes a
priced per-unit add-on on top.

Real prices from the live store: adult jersey $130 plain / $149.99 printed · youth $120 / $139.99.
**Printing = +$19.99 per shirt, both ladders.**

### Schema (migration `migrations/2026-09-09_shop_print_options.sql`, additive, IF NOT EXISTS)
```sql
ALTER TABLE shop_products    ADD COLUMN IF NOT EXISTS print_options jsonb;
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS print_cents integer NOT NULL DEFAULT 0;
ALTER TABLE shop_order_items ADD CONSTRAINT shop_order_items_print_cents_nonneg CHECK (print_cents >= 0);
```
Money is SNAPSHOTTED on the order item, never recomputed at read time.

### `GET /catalog` — each product gains `printOptions` (null when it has none)
```jsonc
"printOptions": {
  "key": "printing",
  "label": "Printing",
  "defaultChoice": "none",
  "choices": [
    { "key":"none",   "label":"No printing",            "priceDollars":0,     "needsName":false, "needsNumber":false, "fromSquad":false },
    { "key":"player", "label":"Squad player",           "priceDollars":19.99, "needsName":true,  "needsNumber":true,  "fromSquad":true  },
    { "key":"custom", "label":"Your own name & number", "priceDollars":19.99, "needsName":true,  "needsNumber":true,  "fromSquad":false }
  ]
}
```

### `POST /quote` and `POST /checkout` — each item may carry `units`
```jsonc
"units": [ { "print":"player", "name":"MEYN", "number":"29" }, { "print":"none" } ]
```
- `units` already exists in the engine (per-shirt name/number, $0). This ADDS an optional `print`.
- When present, `units.length` MUST equal `qty` (existing rule — keep it).
- `print` absent ⇒ `defaultChoice`. Unknown key ⇒ 4xx. A choice with `needsName`/`needsNumber`
  ⇒ name/number required, else 4xx. Name ≤14 chars, number 1–2 digits (existing sanitisers).
- A product with `print_options: null` that receives a non-default `print` ⇒ 4xx.
- **Printing is priced SERVER-SIDE from `print_options`.** The browser never sends a price.

### Quote/order line gains
`printDollars` (line total for printing) and `lineDollars` = unit×qty + printDollars.

## Files — each agent owns its own, no overlap

| Agent | Owns |
|---|---|
| A1 engine | `server/shop-routes.ts` · `server/email.ts` · `shared/schema.ts` · `shared/tabs.ts` · `client/src/components/app-sidebar.tsx` · `migrations/2026-09-09_shop_print_options.sql` · `script/preflight-deploy.ts` |
| A2 data | `script/seed-shop-siu.ts` · `script/apply-shop-print-options.ts` · `script/_verify-shop-siu-live.ts` · `client/public/shop/siu/*.webp` |
| B store | the AIOS root repo only: `apps/siu-shop/**` |

## Tab wiring (A1)
- `shared/tabs.ts` → add `{ slug:"store", title:"Store", url:"/admin/store" }` to **`siuExtraTabs`**.
  (`campsTabs` has no store; CUFC gets its own via `cufcExtraTabs`.)
- `client/src/components/app-sidebar.tsx` → `siuNav` currently filters `store` OUT with the comment
  "SIU has no store on the shop_* engine". **Remove `store` from that filter and update the comment.**
  Leave the fm-history / fm-competitions / open-trainings filters alone.
- The `/admin/store` route in `client/src/App.tsx` was added by the CUFC commit in the shared
  default Switch — SIU inherits it. **No App.tsx change needed.**
- NOT super-admin-only (matches MFL/CIC/CUFC).

## Images — follow the CUFC precedent, NOT the MFL/CIC one
MFL and CIC put product images in the Supabase `shop-images` bucket. The org-wide free storage
quota 402'd every project on 2026-09-05 and took real apps down. CUFC's session instead committed
`client/public/shop/cufc/*.webp`, served by ClubOS itself off `assetBase`. **Do the same:**
`client/public/shop/siu/{handle}-{n}.webp`, catalog URLs `/shop/siu/...` (relative — `absUrl()`
prefixes `assetBase`).

## Hard rules
- Embedded Stripe PaymentElement only, never a hosted redirect or payment link.
- Money in cents in the DB, dollars in API responses and every UI surface.
- Never invent a price or a shipping rate. Unknowns are flagged for Daniel, not guessed.
- The seed strips the stale "under pre-order only … shipping in early March" paragraph from every
  jersey description (written for March 2026, wrong today).
- MFL, CIC and CUFC must be byte-for-byte unregressed. Every new code path is `siu`-gated or
  null-guarded on `print_options`.
- Nothing deploys. Nothing touches shop.southislandunited.com DNS. Staging only.

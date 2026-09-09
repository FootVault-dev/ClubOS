-- Printing as a priced add-on — the shop_* engine's own model, NOT Shopify's.
--
-- Shopify (the store SIU is moving off) models printing as a third option
-- axis ("Printing: None / Player / Custom"), so ONE physical shirt becomes
-- three variants sharing a stock pool — the bug apps/siu-inventory-sync
-- exists to paper over. Stock here stays per (colour × size); printing is a
-- priced per-unit add-on on top, carried in shop_products.print_options and
-- priced server-side into shop_order_items.print_cents at checkout time.
--
-- Additive only. Both columns are nullable / defaulted so every existing
-- MFL, CIC and CUFC product and order item is unaffected: print_options is
-- NULL (no printing add-on offered) and print_cents defaults to 0 (no line
-- has ever charged for printing). Money is SNAPSHOTTED on the order item at
-- checkout, never recomputed at read time — same doctrine as unit_cents and
-- line_cents on this table.

ALTER TABLE shop_products
  ADD COLUMN IF NOT EXISTS print_options jsonb;

ALTER TABLE shop_order_items
  ADD COLUMN IF NOT EXISTS print_cents integer NOT NULL DEFAULT 0;

-- DROP + ADD rather than IF NOT EXISTS: Postgres has no
-- "ADD CONSTRAINT IF NOT EXISTS", so this is the idempotent house pattern
-- (see 2026-08-07_notifications.sql). A negative print_cents would mean the
-- store paid the customer to print a shirt.
ALTER TABLE shop_order_items
  DROP CONSTRAINT IF EXISTS shop_order_items_print_cents_nonneg;
ALTER TABLE shop_order_items
  ADD CONSTRAINT shop_order_items_print_cents_nonneg CHECK (print_cents >= 0);

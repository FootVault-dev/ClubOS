-- Per-variant price override for the shop.
-- Additive + nullable: null means "use the product price" (every MFL kit stays
-- null, unchanged). Set per variant only for variable-price products such as the
-- CIC Gift Card, where each denomination ($10…$500) is its own price.
-- Run on Supabase prod BEFORE the Fly deploy.

ALTER TABLE shop_variants ADD COLUMN IF NOT EXISTS price_cents integer;

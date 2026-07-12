-- MFL Store — kit customisation + Player Pay (group payment).
-- Additive only. Run on Supabase prod BEFORE the Fly deploy.
--
-- customisation (jsonb, per order item): KitCustomisation —
--   { frontSponsor?: {text?, logoUrl?}, backTopSponsor?: {...}, backBottomSponsor?: {...} }
--   (logoUrl wins if both are present; logoUrl is always a shop-images bucket URL).
-- units (jsonb, per order item): UnitPersonalisation[] — one {name?, number?}
--   per shirt in the line (length === qty). Personalisation is included, $0.
--
-- Player Pay: a coach sets up a team kit order (payment_mode='player_pay',
-- status='awaiting_players'); one shop_order_shares row per player carries an
-- unguessable share_token pay link. Shares sum EXACTLY to the order total
-- (shipping split evenly, remainder cents on the last share). When the last
-- share is paid the order flips awaiting_players → paid (all_paid_at stamped).

ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS customisation jsonb;
ALTER TABLE shop_order_items ADD COLUMN IF NOT EXISTS units jsonb;

ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'standard'; -- 'standard' | 'player_pay'
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS team_name text;
ALTER TABLE shop_orders ADD COLUMN IF NOT EXISTS all_paid_at timestamp;

-- One row per player on a player_pay order. share_token is the public pay-link
-- key (unguessable). status: 'pending' | 'paid'. amount_cents = unit price +
-- even shipping split (remainder cents on the LAST share created).
CREATE TABLE IF NOT EXISTS shop_order_shares (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id integer NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  player_name text NOT NULL,
  player_email text NOT NULL,
  player_phone text,
  size text NOT NULL,
  shirt_name text,
  shirt_number text,
  amount_cents integer NOT NULL,
  share_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id text,
  paid_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_order_shares_order_idx ON shop_order_shares (order_id);
CREATE INDEX IF NOT EXISTS shop_order_shares_token_idx ON shop_order_shares (share_token);

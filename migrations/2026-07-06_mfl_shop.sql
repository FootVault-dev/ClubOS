-- MFL Store — native e-commerce module (Shopify replacement pilot).
-- Generic multi-brand shop tables (organization_id everywhere); MFL (org 3) first.
-- Additive only. Run on Supabase prod BEFORE the Fly deploy.

-- Products. `cost_usd` is a supplier cost REFERENCE only (USD, ex shipping/duties)
-- — never used in any calculation. Money the customer sees is integer NZD cents.
CREATE TABLE IF NOT EXISTS shop_products (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  subtitle text,
  description text,
  type text NOT NULL DEFAULT 'shirt',            -- 'kit' | 'shirt' | ... (open-ended)
  price_cents integer NOT NULL DEFAULT 0,
  compare_at_cents integer,
  cost_usd numeric(10,2),                        -- reference only (USD, ex shipping/duties)
  badge text,
  status text NOT NULL DEFAULT 'draft',          -- 'draft' | 'active' | 'archived'
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_products_org_slug_unique ON shop_products (organization_id, slug);
CREATE INDEX IF NOT EXISTS shop_products_org_status_idx ON shop_products (organization_id, status, sort_order);

CREATE TABLE IF NOT EXISTS shop_product_colours (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id integer NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  name text NOT NULL,
  swatch_hex text,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS shop_product_colours_product_idx ON shop_product_colours (product_id);

-- colour_id null = product-level image (used when a product has no colours yet
-- or for shared shots).
CREATE TABLE IF NOT EXISTS shop_product_images (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id integer NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  colour_id integer REFERENCES shop_product_colours(id) ON DELETE CASCADE,
  url text NOT NULL,
  alt text,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shop_product_images_product_idx ON shop_product_images (product_id);

-- Variant = colour × size. Stock lives here.
CREATE TABLE IF NOT EXISTS shop_variants (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id integer NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
  colour_id integer NOT NULL REFERENCES shop_product_colours(id) ON DELETE CASCADE,
  size text NOT NULL,
  sku text,
  stock integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS shop_variants_product_idx ON shop_variants (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS shop_variants_colour_size_unique ON shop_variants (colour_id, size);

CREATE TABLE IF NOT EXISTS shop_shipping_options (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  label text NOT NULL,
  description text,
  price_cents integer NOT NULL DEFAULT 0,
  requires_address boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shop_shipping_options_org_idx ON shop_shipping_options (organization_id, active, sort_order);

-- kind 'percent' → value is a whole percent (10 = 10%); kind 'fixed' → value is cents.
CREATE TABLE IF NOT EXISTS shop_discount_codes (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  kind text NOT NULL DEFAULT 'percent',          -- 'percent' | 'fixed'
  value integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  starts_at timestamp,
  ends_at timestamp,
  max_uses integer,
  used_count integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_discount_codes_org_code_unique ON shop_discount_codes (organization_id, code);

-- Orders. Totals are GST-INCLUSIVE; gst_cents is the NZ GST content
-- (= round(total * 3 / 23)) recorded for reporting. order_token is the public
-- status-lookup key (unguessable); order_number is the human-facing "MFL-1001".
CREATE TABLE IF NOT EXISTS shop_orders (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_number text UNIQUE,
  order_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending',
  -- 'pending' | 'paid' | 'processing' | 'ready_for_pickup' | 'shipped' |
  -- 'completed' | 'cancelled' | 'refunded'
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  shipping_option_id integer REFERENCES shop_shipping_options(id) ON DELETE SET NULL,
  shipping_label text,                           -- snapshot at checkout
  shipping_cents integer NOT NULL DEFAULT 0,     -- snapshot at checkout
  address_line1 text,
  address_line2 text,
  suburb text,
  city text,
  postcode text,
  subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  discount_code text,
  gst_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NZD',
  stripe_payment_intent_id text,
  contact_id integer REFERENCES contacts(id),
  source text NOT NULL DEFAULT 'online',         -- POS-ready ('online' | 'pos' | ...)
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  gclid text,
  visitor_id text,
  notes text,
  paid_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shop_orders_org_status_idx ON shop_orders (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS shop_orders_pi_idx ON shop_orders (stripe_payment_intent_id);

-- Line items snapshot everything at purchase time (title/colour/size/image/price
-- + supplier cost reference) so history never drifts when products change.
CREATE TABLE IF NOT EXISTS shop_order_items (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id integer NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
  product_id integer REFERENCES shop_products(id) ON DELETE SET NULL,
  variant_id integer REFERENCES shop_variants(id) ON DELETE SET NULL,
  title text NOT NULL,
  colour_name text,
  size text,
  image_url text,
  unit_cents integer NOT NULL DEFAULT 0,
  qty integer NOT NULL DEFAULT 1,
  line_cents integer NOT NULL DEFAULT 0,
  cost_usd_snapshot numeric(10,2)
);
CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON shop_order_items (order_id);

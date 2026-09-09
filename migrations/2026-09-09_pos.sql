-- ─────────────────────────────────────────────────────────────────────────────
-- POS — one register for every brand, every programme, every counter.
--
-- Run BEFORE the deploy:
--   npx tsx --env-file=.env script/apply-pos.ts             (dry run, rolled back)
--   npx tsx --env-file=.env script/apply-pos.ts --commit
--
-- ADDITIVE. Seven new tables, one sequence, one nullable column on
-- registrations. Nothing existing is altered otherwise.
--
-- The model, in one breath: a SALE is one cart, one receipt and one or more
-- PAYMENTS. Every LINE carries the brand it belongs to (organization_id) so the
-- cash-up and the accounts split by brand inside one sale. The sale is bound to
-- ONE money account — the Stripe account and bank account the money lands in
-- ('club' for the football side, 'cugc' for United Gymnastics, 'trust' for the
-- Cross Street Football Trust). A cart cannot mix money accounts; Postgres
-- refuses the line. A SHIFT is the unit of cash accountability: opened with a
-- float, closed with a counted figure; expected cash is DERIVED, never stored.
--
-- Deliberately NO CHECK constraints on `status`, `kind`, `method`, `reason` or
-- `account` — those value sets grow, and a stale CHECK is how the MFL checkout
-- 500'd. They are validated in shared/pos.ts. The CHECKs and triggers that ARE
-- here encode arithmetic and money rules that can never need to grow.
-- ─────────────────────────────────────────────────────────────────────────────

-- Which money account each brand's sales land in. DATA, not code: a new brand
-- is a row, a re-banked brand is an UPDATE.
CREATE TABLE IF NOT EXISTS pos_org_money_accounts (
  organization_id   integer PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  account           text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pos_org_money_accounts (organization_id, account)
SELECT id, CASE WHEN slug = 'united-gymnastics' THEN 'cugc' ELSE 'club' END
FROM organizations
ON CONFLICT (organization_id) DO NOTHING;

-- A register is a named place money is taken: "Office counter", "CIC merch
-- stand". The Stripe Terminal location/reader hang off it once phase 3 lands.
CREATE TABLE IF NOT EXISTS pos_registers (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name                text NOT NULL,
  location            text,
  -- The brand tab the register opens on. Not a scope: every register sells
  -- every brand.
  default_org_id      integer REFERENCES organizations(id) ON DELETE SET NULL,
  stripe_location_id  text,
  stripe_reader_id    text,
  active              boolean NOT NULL DEFAULT true,
  created_by_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO pos_registers (name, location, default_org_id)
SELECT 'Office counter', 'United Sports Centre office', (SELECT id FROM organizations WHERE slug = 'christchurch-united')
WHERE NOT EXISTS (SELECT 1 FROM pos_registers);

-- A shift: who opened the till, with what float, who closed it, what they
-- counted. Expected cash = float + cash payments − cash refunds (+ rounding
-- already inside the payments), computed on read. Variance = counted − expected.
CREATE TABLE IF NOT EXISTS pos_shifts (
  id                          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  register_id                 integer NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  -- RESTRICT: deleting a staff account must never erase who held the cash.
  opened_by_user_id           integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  opening_float_cents         integer NOT NULL DEFAULT 0,
  closed_by_user_id           integer REFERENCES users(id) ON DELETE RESTRICT,
  closed_at                   timestamptz,
  closing_cash_counted_cents  integer,
  notes                       text,
  CONSTRAINT pos_shifts_float_nonneg   CHECK (opening_float_cents >= 0),
  CONSTRAINT pos_shifts_counted_nonneg CHECK (closing_cash_counted_cents IS NULL OR closing_cash_counted_cents >= 0),
  -- A closed shift carries all three closing facts or none of them.
  CONSTRAINT pos_shifts_close_pair CHECK (
    ((closed_at IS NULL) = (closed_by_user_id IS NULL)) AND
    ((closed_at IS NULL) = (closing_cash_counted_cents IS NULL))
  )
);

-- 🔴 One open shift per register — enforced here, not in app code a race can
-- walk through.
CREATE UNIQUE INDEX IF NOT EXISTS pos_shifts_one_open_per_register
  ON pos_shifts (register_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS pos_shifts_register_idx ON pos_shifts (register_id, opened_at);

CREATE SEQUENCE IF NOT EXISTS pos_sale_number_seq;

CREATE TABLE IF NOT EXISTS pos_sales (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- R-000001. Minted by the trigger below, never typed.
  sale_number         text NOT NULL DEFAULT '',
  -- The receipt page. 128 random bits: it shows what was bought and paid, and
  -- maybe a name. The set must not be enumerable.
  token               uuid NOT NULL DEFAULT gen_random_uuid(),
  register_id         integer NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  shift_id            integer NOT NULL REFERENCES pos_shifts(id) ON DELETE RESTRICT,
  -- 'club' | 'cugc' | 'trust' — see pos_org_money_accounts. Every line's brand
  -- must map to this; the trigger refuses anything else.
  money_account       text NOT NULL,
  -- open | paid | void | refunded | partially_refunded (shared/pos.ts)
  status              text NOT NULL DEFAULT 'open',

  subtotal_cents      integer NOT NULL DEFAULT 0,
  discount_cents      integer NOT NULL DEFAULT 0,
  discount_reason     text,
  -- Cash rounds to the nearest 10c (Swedish rounding, retailer convention):
  -- −4..+5. Card and EFTPOS never round. Recorded, so the books carry the exact
  -- sale and the till carries what was actually handed over.
  rounding_cents      integer NOT NULL DEFAULT 0,
  -- Always 0 in v1. The column exists so a surcharge is a data flip, never a
  -- schema change, if the law and the club ever want one.
  surcharge_cents     integer NOT NULL DEFAULT 0,
  total_cents         integer NOT NULL DEFAULT 0,
  -- GST content of the GST-inclusive total: round(total × 3 ÷ 23).
  gst_cents           integer NOT NULL DEFAULT 0,
  paid_cents          integer NOT NULL DEFAULT 0,
  refunded_cents      integer NOT NULL DEFAULT 0,

  -- Optional customer. RESTRICT: a person with a sale against them cannot be
  -- deleted out from under the money.
  contact_id          integer REFERENCES contacts(id) ON DELETE RESTRICT,
  customer_name       text,
  customer_email      text,
  customer_phone      text,
  -- A purchase never implies marketing consent. This is stamped only when the
  -- customer ticked an unticked box, and the timestamp is the evidence.
  marketing_opt_in_at timestamptz,

  served_by_user_id   integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notes               text,
  receipt_sent_at     timestamptz,
  -- Stamped ONCE, atomically, when the paid sale's side effects ran (stock,
  -- registrations confirmed, tickets minted). A webhook racing the register's
  -- own confirm call does the work exactly once.
  fulfilled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz,
  voided_at           timestamptz,
  void_reason         text,

  CONSTRAINT pos_sales_total_math        CHECK (total_cents = subtotal_cents - discount_cents + rounding_cents + surcharge_cents),
  CONSTRAINT pos_sales_nonneg            CHECK (subtotal_cents >= 0 AND discount_cents >= 0 AND surcharge_cents >= 0 AND total_cents >= 0 AND paid_cents >= 0 AND refunded_cents >= 0),
  CONSTRAINT pos_sales_discount_le_sub   CHECK (discount_cents <= subtotal_cents),
  CONSTRAINT pos_sales_discount_reason   CHECK (discount_cents = 0 OR (discount_reason IS NOT NULL AND length(trim(discount_reason)) > 0)),
  CONSTRAINT pos_sales_rounding_range    CHECK (rounding_cents BETWEEN -4 AND 5),
  CONSTRAINT pos_sales_paid_le_total     CHECK (paid_cents <= total_cents),
  CONSTRAINT pos_sales_refund_le_paid    CHECK (refunded_cents <= paid_cents),
  -- Paid is a fact with a timestamp; open never carries one; void never holds
  -- money.
  CONSTRAINT pos_sales_state CHECK (
    (status = 'open'  AND paid_at IS NULL AND voided_at IS NULL AND paid_cents < GREATEST(total_cents, 1)) OR
    (status = 'void'  AND voided_at IS NOT NULL AND paid_cents = 0 AND void_reason IS NOT NULL) OR
    (status IN ('paid','refunded','partially_refunded') AND paid_at IS NOT NULL AND paid_cents = total_cents)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_number_unq ON pos_sales (sale_number) WHERE sale_number <> '';
CREATE UNIQUE INDEX IF NOT EXISTS pos_sales_token_unq  ON pos_sales (token);
CREATE INDEX IF NOT EXISTS pos_sales_shift_idx    ON pos_sales (shift_id, status);
CREATE INDEX IF NOT EXISTS pos_sales_register_idx ON pos_sales (register_id, created_at);
CREATE INDEX IF NOT EXISTS pos_sales_contact_idx  ON pos_sales (contact_id);

CREATE TABLE IF NOT EXISTS pos_sale_lines (
  id                          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- CASCADE is safe only because a sale holding money cannot be deleted (trigger).
  sale_id                     integer NOT NULL REFERENCES pos_sales(id) ON DELETE CASCADE,
  -- variant | registration | event_ticket | custom
  kind                        text NOT NULL,
  -- The brand this line belongs to. Drives the bucket check and the cash-up split.
  organization_id             integer NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  variant_id                  integer REFERENCES shop_variants(id) ON DELETE SET NULL,
  product_id                  integer REFERENCES shop_products(id) ON DELETE SET NULL,
  registration_id             integer REFERENCES registrations(id) ON DELETE RESTRICT,
  club_event_ticket_type_id   integer REFERENCES club_event_ticket_types(id) ON DELETE RESTRICT,
  club_event_order_id         integer REFERENCES club_event_orders(id) ON DELETE RESTRICT,
  -- Snapshots at the moment of sale. A later price edit cannot re-price a sold line.
  title                       text NOT NULL,
  detail                      text,
  unit_cents                  integer NOT NULL,
  qty                         integer NOT NULL,
  line_cents                  integer NOT NULL,
  meta                        jsonb,
  sort                        integer NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_sale_lines_unit_nonneg CHECK (unit_cents >= 0),
  CONSTRAINT pos_sale_lines_qty_pos     CHECK (qty >= 1),
  CONSTRAINT pos_sale_lines_math        CHECK (line_cents = unit_cents * qty)
);

-- A registration is sold in exactly one sale.
CREATE UNIQUE INDEX IF NOT EXISTS pos_sale_lines_registration_unq
  ON pos_sale_lines (registration_id) WHERE registration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_sale_lines_sale_idx ON pos_sale_lines (sale_id, sort);
CREATE INDEX IF NOT EXISTS pos_sale_lines_variant_idx ON pos_sale_lines (variant_id);

CREATE TABLE IF NOT EXISTS pos_payments (
  id                        integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  sale_id                   integer NOT NULL REFERENCES pos_sales(id) ON DELETE RESTRICT,
  -- cash | eftpos | card_present | bank_transfer | other (shared/pos.ts)
  method                    text NOT NULL,
  amount_cents              integer NOT NULL,
  -- The EFTPOS slip number, the bank reference, whatever proves it.
  reference                 text,
  stripe_payment_intent_id  text,
  -- pending | succeeded | failed | canceled. Only 'succeeded' moves paid_cents.
  status                    text NOT NULL DEFAULT 'succeeded',
  created_by_user_id        integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT now(),
  succeeded_at              timestamptz,
  CONSTRAINT pos_payments_amount_pos   CHECK (amount_cents > 0),
  CONSTRAINT pos_payments_succeeded_at CHECK ((status = 'succeeded') = (succeeded_at IS NOT NULL)),
  -- A card payment without a PaymentIntent is a payment nobody can trace.
  CONSTRAINT pos_payments_card_needs_pi CHECK (method <> 'card_present' OR stripe_payment_intent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_payments_pi_unq ON pos_payments (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_payments_sale_idx ON pos_payments (sale_id);

CREATE TABLE IF NOT EXISTS pos_refunds (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  sale_id             integer NOT NULL REFERENCES pos_sales(id) ON DELETE RESTRICT,
  payment_id          integer REFERENCES pos_payments(id) ON DELETE RESTRICT,
  method              text NOT NULL,
  amount_cents        integer NOT NULL,
  -- A refund without a reason is the question Victor asks three months later.
  reason              text NOT NULL,
  stripe_refund_id    text,
  issued_by_user_id   integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_refunds_amount_pos CHECK (amount_cents > 0),
  CONSTRAINT pos_refunds_reason     CHECK (length(trim(reason)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS pos_refunds_stripe_unq ON pos_refunds (stripe_refund_id) WHERE stripe_refund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_refunds_sale_idx ON pos_refunds (sale_id);

-- The sale that did NOT happen, and why. This is how we MEASURE how many
-- customers hold an eftpos-only card before paying for an eftpos integration.
CREATE TABLE IF NOT EXISTS pos_declines (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  register_id         integer NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  shift_id            integer REFERENCES pos_shifts(id) ON DELETE RESTRICT,
  -- eftpos_only | card_declined | no_change | price | other (shared/pos.ts)
  reason              text NOT NULL,
  amount_cents        integer,
  note                text,
  created_by_user_id  integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_declines_amount_nonneg CHECK (amount_cents IS NULL OR amount_cents >= 0)
);
CREATE INDEX IF NOT EXISTS pos_declines_register_idx ON pos_declines (register_id, created_at);

-- A registration paid at the register points at its sale, so the person page,
-- the cash-up and the receipt agree.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS pos_sale_id integer REFERENCES pos_sales(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS registrations_pos_sale_idx ON registrations (pos_sale_id) WHERE pos_sale_id IS NOT NULL;

-- ── Triggers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pos_touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
-- Total and GST are DERIVED from the parts on every update, so the app only
-- ever sets a discount, a rounding or a surcharge and can never write a total
-- that disagrees with them (pos_sales_total_math then always holds).
CREATE OR REPLACE FUNCTION pos_sales_before_update() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.subtotal_cents <> OLD.subtotal_cents OR NEW.discount_cents <> OLD.discount_cents
     OR NEW.rounding_cents <> OLD.rounding_cents OR NEW.surcharge_cents <> OLD.surcharge_cents THEN
    NEW.total_cents := NEW.subtotal_cents - NEW.discount_cents + NEW.rounding_cents + NEW.surcharge_cents;
    NEW.gst_cents   := round(NEW.total_cents * 3.0 / 23.0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_sales_touch ON pos_sales;
DROP TRIGGER IF EXISTS pos_sales_bu ON pos_sales;
CREATE TRIGGER pos_sales_bu BEFORE UPDATE ON pos_sales FOR EACH ROW EXECUTE FUNCTION pos_sales_before_update();
DROP TRIGGER IF EXISTS pos_registers_touch ON pos_registers;
CREATE TRIGGER pos_registers_touch BEFORE UPDATE ON pos_registers FOR EACH ROW EXECUTE FUNCTION pos_touch_updated_at();

-- Sale number + the shift must be open on this register.
CREATE OR REPLACE FUNCTION pos_sales_before_insert() RETURNS trigger AS $$
DECLARE s record;
BEGIN
  IF NEW.sale_number IS NULL OR NEW.sale_number = '' THEN
    NEW.sale_number := 'R-' || lpad(nextval('pos_sale_number_seq')::text, 6, '0');
  END IF;
  SELECT register_id, closed_at INTO s FROM pos_shifts WHERE id = NEW.shift_id;
  IF s IS NULL THEN RAISE EXCEPTION 'POS_SHIFT_MISSING: shift % does not exist', NEW.shift_id; END IF;
  IF s.closed_at IS NOT NULL THEN RAISE EXCEPTION 'POS_SHIFT_CLOSED: shift % is closed', NEW.shift_id; END IF;
  IF s.register_id <> NEW.register_id THEN RAISE EXCEPTION 'POS_SHIFT_REGISTER: shift % belongs to another register', NEW.shift_id; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_sales_bi ON pos_sales;
CREATE TRIGGER pos_sales_bi BEFORE INSERT ON pos_sales FOR EACH ROW EXECUTE FUNCTION pos_sales_before_insert();

-- 🔴 A sale that has taken money cannot be deleted. After payment it is a refund.
CREATE OR REPLACE FUNCTION pos_sales_before_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.paid_cents > 0 OR EXISTS (SELECT 1 FROM pos_payments WHERE sale_id = OLD.id AND status = 'succeeded') THEN
    RAISE EXCEPTION 'POS_SALE_HAS_MONEY: sale % has taken money and cannot be deleted', OLD.sale_number;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_sales_bd ON pos_sales;
CREATE TRIGGER pos_sales_bd BEFORE DELETE ON pos_sales FOR EACH ROW EXECUTE FUNCTION pos_sales_before_delete();

-- Recompute a sale's money from its lines. Rounding is cleared: it is decided at
-- cash-tender time, and any change to the cart invalidates it.
CREATE OR REPLACE FUNCTION pos_sales_recompute(p_sale_id integer) RETURNS void AS $$
DECLARE sub integer;
BEGIN
  SELECT coalesce(sum(line_cents), 0) INTO sub FROM pos_sale_lines WHERE sale_id = p_sale_id;
  -- total/gst follow from the BEFORE UPDATE trigger.
  UPDATE pos_sales
     SET subtotal_cents = sub,
         discount_cents = LEAST(discount_cents, sub),
         discount_reason = CASE WHEN LEAST(discount_cents, sub) = 0 THEN NULL ELSE discount_reason END,
         rounding_cents = 0
   WHERE id = p_sale_id;
END;
$$ LANGUAGE plpgsql;

-- Lines: only on an open, unpaid sale; only for a brand in the sale's bucket.
CREATE OR REPLACE FUNCTION pos_sale_lines_guard() RETURNS trigger AS $$
DECLARE sale record; acct text; sid integer;
BEGIN
  sid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END;
  SELECT status, paid_cents, money_account INTO sale FROM pos_sales WHERE id = sid FOR UPDATE;
  IF sale IS NULL THEN RAISE EXCEPTION 'POS_SALE_MISSING: sale % does not exist', sid; END IF;
  IF sale.status <> 'open' OR sale.paid_cents > 0 THEN
    RAISE EXCEPTION 'POS_LINES_FROZEN: sale % has taken money or is closed; its lines cannot change', sid;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT account INTO acct FROM pos_org_money_accounts WHERE organization_id = NEW.organization_id;
    IF acct IS NULL THEN RAISE EXCEPTION 'POS_BUCKET_UNKNOWN: organisation % has no money account', NEW.organization_id; END IF;
    IF acct <> sale.money_account THEN
      RAISE EXCEPTION 'POS_BUCKET_MISMATCH: this brand banks to %, the sale banks to % — start a separate sale', acct, sale.money_account;
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_sale_lines_guard_t ON pos_sale_lines;
CREATE TRIGGER pos_sale_lines_guard_t BEFORE INSERT OR UPDATE OR DELETE ON pos_sale_lines FOR EACH ROW EXECUTE FUNCTION pos_sale_lines_guard();

CREATE OR REPLACE FUNCTION pos_sale_lines_after() RETURNS trigger AS $$
BEGIN
  PERFORM pos_sales_recompute(CASE WHEN TG_OP = 'DELETE' THEN OLD.sale_id ELSE NEW.sale_id END);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_sale_lines_after_t ON pos_sale_lines;
CREATE TRIGGER pos_sale_lines_after_t AFTER INSERT OR UPDATE OR DELETE ON pos_sale_lines FOR EACH ROW EXECUTE FUNCTION pos_sale_lines_after();

-- Payments: never more than what is owed; a succeeded payment is immutable.
CREATE OR REPLACE FUNCTION pos_payments_guard() RETURNS trigger AS $$
DECLARE sale record; owing integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'succeeded' THEN
    IF NEW.status <> 'succeeded' OR NEW.amount_cents <> OLD.amount_cents OR NEW.method <> OLD.method OR NEW.sale_id <> OLD.sale_id THEN
      RAISE EXCEPTION 'POS_PAYMENT_IMMUTABLE: a payment that succeeded cannot be changed — refund it';
    END IF;
    RETURN NEW;
  END IF;
  SELECT status, total_cents, paid_cents INTO sale FROM pos_sales WHERE id = NEW.sale_id FOR UPDATE;
  IF sale IS NULL THEN RAISE EXCEPTION 'POS_SALE_MISSING: sale % does not exist', NEW.sale_id; END IF;
  IF sale.status <> 'open' THEN RAISE EXCEPTION 'POS_SALE_NOT_OPEN: sale is %, no more payments', sale.status; END IF;
  IF NEW.status = 'succeeded' THEN
    owing := sale.total_cents - sale.paid_cents;
    IF NEW.amount_cents > owing THEN
      RAISE EXCEPTION 'POS_OVERPAY: % owing, % offered', owing, NEW.amount_cents;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_payments_guard_t ON pos_payments;
CREATE TRIGGER pos_payments_guard_t BEFORE INSERT OR UPDATE ON pos_payments FOR EACH ROW EXECUTE FUNCTION pos_payments_guard();

CREATE OR REPLACE FUNCTION pos_payments_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'succeeded' THEN RAISE EXCEPTION 'POS_PAYMENT_IMMUTABLE: a payment that succeeded cannot be deleted — refund it'; END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_payments_bd ON pos_payments;
CREATE TRIGGER pos_payments_bd BEFORE DELETE ON pos_payments FOR EACH ROW EXECUTE FUNCTION pos_payments_no_delete();

-- A payment that succeeded moves the sale's paid figure, and paid = total flips
-- the sale to 'paid' with a timestamp. Here, so no code path can forget.
CREATE OR REPLACE FUNCTION pos_payments_apply() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    UPDATE pos_sales
       SET paid_cents = paid_cents + NEW.amount_cents,
           status  = CASE WHEN paid_cents + NEW.amount_cents >= total_cents THEN 'paid' ELSE status END,
           paid_at = CASE WHEN paid_cents + NEW.amount_cents >= total_cents THEN now() ELSE paid_at END
     WHERE id = NEW.sale_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_payments_apply_t ON pos_payments;
CREATE TRIGGER pos_payments_apply_t AFTER INSERT OR UPDATE ON pos_payments FOR EACH ROW EXECUTE FUNCTION pos_payments_apply();

-- Refunds: never more than was paid and not yet refunded.
CREATE OR REPLACE FUNCTION pos_refunds_guard() RETURNS trigger AS $$
DECLARE sale record;
BEGIN
  SELECT status, paid_cents, refunded_cents INTO sale FROM pos_sales WHERE id = NEW.sale_id FOR UPDATE;
  IF sale IS NULL THEN RAISE EXCEPTION 'POS_SALE_MISSING: sale % does not exist', NEW.sale_id; END IF;
  IF sale.status NOT IN ('paid', 'partially_refunded') THEN
    RAISE EXCEPTION 'POS_REFUND_STATE: sale is %, nothing to refund', sale.status;
  END IF;
  IF NEW.amount_cents > sale.paid_cents - sale.refunded_cents THEN
    RAISE EXCEPTION 'POS_OVERREFUND: % refundable, % requested', sale.paid_cents - sale.refunded_cents, NEW.amount_cents;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_refunds_guard_t ON pos_refunds;
CREATE TRIGGER pos_refunds_guard_t BEFORE INSERT ON pos_refunds FOR EACH ROW EXECUTE FUNCTION pos_refunds_guard();

CREATE OR REPLACE FUNCTION pos_refunds_apply() RETURNS trigger AS $$
BEGIN
  UPDATE pos_sales
     SET refunded_cents = refunded_cents + NEW.amount_cents,
         status = CASE WHEN refunded_cents + NEW.amount_cents >= paid_cents THEN 'refunded' ELSE 'partially_refunded' END
   WHERE id = NEW.sale_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_refunds_apply_t ON pos_refunds;
CREATE TRIGGER pos_refunds_apply_t AFTER INSERT ON pos_refunds FOR EACH ROW EXECUTE FUNCTION pos_refunds_apply();

-- A shift cannot close over a sale that holds money and is not finished.
CREATE OR REPLACE FUNCTION pos_shifts_guard_close() RETURNS trigger AS $$
BEGIN
  IF NEW.closed_at IS NOT NULL AND OLD.closed_at IS NULL THEN
    IF EXISTS (SELECT 1 FROM pos_sales WHERE shift_id = NEW.id AND status = 'open' AND paid_cents > 0) THEN
      RAISE EXCEPTION 'POS_SHIFT_HAS_PARTIAL: a sale on this shift has taken money and is not finished';
    END IF;
  END IF;
  IF OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.closing_cash_counted_cents IS DISTINCT FROM OLD.closing_cash_counted_cents) THEN
    RAISE EXCEPTION 'POS_SHIFT_CLOSED: a closed shift is a record; add a note, do not edit the count';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pos_shifts_guard_close_t ON pos_shifts;
CREATE TRIGGER pos_shifts_guard_close_t BEFORE UPDATE ON pos_shifts FOR EACH ROW EXECUTE FUNCTION pos_shifts_guard_close();

-- ── RLS: the second wall against a leaked anon key ───────────────────────────
ALTER TABLE pos_org_money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_registers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_shifts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sales              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sale_lines         ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_refunds            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_declines           ENABLE ROW LEVEL SECURITY;

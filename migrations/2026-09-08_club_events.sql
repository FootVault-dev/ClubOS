-- ═══════════════════════════════════════════════════════════════════════════
-- Club Events — ticketed events (the first: the CUFC Club Dinner, 13 Nov 2026)
-- 2026-09-08 · from Malcolm's email + the 4 Sep meeting (Les, Malcolm, Daniel)
--
-- Additive. Touches no existing table. Pattern cloned from Team Pay
-- (2026-08-27_teampay.sql): every rule that money depends on is a constraint
-- or a trigger here, not a line of TypeScript, because two people buying the
-- last two seats at the same instant is a race, and a race walks through an `if`.
--
-- 🔴 NO transaction control in this file. script/apply-club-events.ts wraps it,
-- and a BEGIN/COMMIT here would defeat its --dry-run.
--
-- Why not `events` / `tickets`: `calendar_events`, `community_events` and a
-- dozen `*_events` audit tables already exist, and the tab slug `events` is
-- SIU's Community Events. `club_` is the prefix for the club's OWN things
-- (club_squads). Prices live on a TICKET TYPE with a sales window, so
-- "early bird $150 to 1 October, then $165" is two rows and a clock, not code.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_events (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id   integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  slug              text    NOT NULL,
  -- Short code that prefixes every ticket reference: DIN26-0001.
  short_code        text    NOT NULL,
  name              text    NOT NULL,
  tagline           text,
  description       text,
  -- Bullet list shown as "what's included" — jsonb array of strings.
  includes          jsonb   NOT NULL DEFAULT '[]'::jsonb,
  brand             text    NOT NULL DEFAULT 'cufc',

  venue_name        text,
  venue_address     text,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz,

  -- NULL = no cap. A cap is enforced by the trigger below, in the database.
  capacity          integer,
  table_size        integer NOT NULL DEFAULT 10,
  max_per_order     integer NOT NULL DEFAULT 10,
  age_restriction   text,

  -- draft | open | closed. Validated in app code (CLUB_EVENT_STATUSES in
  -- shared/club-events.ts), never by a DB CHECK — a stale CHECK on an
  -- enum-ish column is how the MFL checkout once 500'd.
  status            text    NOT NULL DEFAULT 'draft',

  -- Which Stripe account collects: 'club' (the club's own) or 'trust' (the
  -- Cross Street Football Trust's, keyed by CLUB_EVENTS_TRUST_STRIPE_* env).
  -- Malcolm asked for ticket money ring-fenced outside the club so the venue
  -- is paid within 7 days; this column is how that decision is recorded.
  stripe_account    text    NOT NULL DEFAULT 'club',
  currency          text    NOT NULL DEFAULT 'NZD',

  contact_email     text,
  -- Shown beside the pay button, e.g. who the money goes to.
  payment_note      text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_events_capacity_positive   CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT club_events_table_size_positive CHECK (table_size > 0),
  CONSTRAINT club_events_max_per_order_sane  CHECK (max_per_order BETWEEN 1 AND 50),
  CONSTRAINT club_events_ends_after_start    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
-- The public URL is /events/{slug} with no org in it, so the slug is global.
CREATE UNIQUE INDEX IF NOT EXISTS club_events_slug_unique ON club_events (slug);
CREATE INDEX IF NOT EXISTS club_events_org_idx ON club_events (organization_id);

-- ── ticket types: a price with a sales window ───────────────────────────────
CREATE TABLE IF NOT EXISTS club_event_ticket_types (
  id            integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  event_id      integer NOT NULL REFERENCES club_events(id) ON DELETE CASCADE,
  name          text    NOT NULL,
  price_cents   integer NOT NULL,
  -- NULL = open-ended on that side. "Early bird to 1 October" is
  -- sales_end = 2026-10-01 00:00 NZ; "Standard from 1 October" is
  -- sales_start = the same instant. The server picks the type at purchase.
  sales_start   timestamptz,
  sales_end     timestamptz,
  -- NULL = no cap for this type (the event's capacity still applies).
  quantity_cap  integer,
  sort          integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_event_ticket_types_price_nonneg CHECK (price_cents >= 0),
  CONSTRAINT club_event_ticket_types_cap_positive CHECK (quantity_cap IS NULL OR quantity_cap > 0),
  CONSTRAINT club_event_ticket_types_window_sane
    CHECK (sales_start IS NULL OR sales_end IS NULL OR sales_start < sales_end)
);
CREATE INDEX IF NOT EXISTS club_event_ticket_types_event_idx ON club_event_ticket_types (event_id);

-- ── orders: one purchase, one payment, N seats ──────────────────────────────
CREATE TABLE IF NOT EXISTS club_event_orders (
  id                        integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- RESTRICT, not CASCADE: an event that has taken money cannot be deleted.
  event_id                  integer NOT NULL REFERENCES club_events(id) ON DELETE RESTRICT,
  ticket_type_id            integer NOT NULL REFERENCES club_event_ticket_types(id) ON DELETE RESTRICT,

  -- Human ticket reference (DIN26-0001). Filled by the trigger below from the
  -- event's short_code + this row's id, so it is never typed and never clashes.
  ref                       text    NOT NULL,
  -- 🔴 The buyer's order page. 128 random bits: the page shows names, an
  -- email, a phone number and what was paid. The set must not be enumerable.
  token                     text    NOT NULL,

  buyer_name                text    NOT NULL,
  buyer_email               text    NOT NULL,
  buyer_phone               text,

  quantity                  integer NOT NULL,
  -- Copied from the ticket type at purchase so a later price edit cannot
  -- re-price a sold ticket. total is derived from the pair and the CHECK
  -- keeps them honest.
  unit_price_cents          integer NOT NULL,
  total_cents               integer NOT NULL,

  -- pending | paid | cancelled | refunded — app-validated, see above.
  status                    text    NOT NULL DEFAULT 'pending',

  -- online_card | eftpos | cash | bank_transfer | other (shared/payments.ts).
  payment_method            text,
  payment_reference         text,
  stripe_payment_intent_id  text,
  stripe_customer_id        text,

  -- Read back off Stripe, or typed by the staff member who took the cash.
  -- NULL means no money has landed, which is not the same as $0.
  paid_at                   timestamptz,
  paid_cents                integer,

  refunded_cents            integer NOT NULL DEFAULT 0,
  refunded_at               timestamptz,
  refund_reason             text,
  stripe_refund_id          text,

  -- Who took an office/EFTPOS payment. RESTRICT: deleting a staff account must
  -- never erase who handled the cash (same rule as registrations).
  served_by_user_id         integer REFERENCES users(id) ON DELETE RESTRICT,

  -- "Sit us with…" — a table name the buyer types so a team can build a
  -- table across separate purchases.
  table_name                text,
  buyer_notes               text,
  staff_notes               text,

  -- Attribution, same columns the camp registrations carry.
  source                    text,
  source_url                text,
  fbp                       text,
  fbc                       text,
  user_agent                text,
  ip_address                text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_event_orders_quantity_sane   CHECK (quantity BETWEEN 1 AND 50),
  CONSTRAINT club_event_orders_price_nonneg    CHECK (unit_price_cents >= 0),
  CONSTRAINT club_event_orders_total_honest    CHECK (total_cents = quantity * unit_price_cents),
  -- paid_at and paid_cents travel together — never "Paid, $0.00" by accident.
  CONSTRAINT club_event_orders_paid_pair       CHECK ((paid_at IS NULL) = (paid_cents IS NULL)),
  CONSTRAINT club_event_orders_paid_nonneg     CHECK (paid_cents IS NULL OR paid_cents >= 0),
  -- A refund can never exceed what was paid.
  CONSTRAINT club_event_orders_refund_sane     CHECK (refunded_cents >= 0 AND refunded_cents <= COALESCE(paid_cents, 0)),
  -- The word "paid" always carries a payment.
  CONSTRAINT club_event_orders_paid_has_money  CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS club_event_orders_ref_unique   ON club_event_orders (ref);
CREATE UNIQUE INDEX IF NOT EXISTS club_event_orders_token_unique ON club_event_orders (token);
-- One Stripe payment can settle one order and only one.
CREATE UNIQUE INDEX IF NOT EXISTS club_event_orders_pi_unique
  ON club_event_orders (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS club_event_orders_event_idx ON club_event_orders (event_id, status);
CREATE INDEX IF NOT EXISTS club_event_orders_email_idx ON club_event_orders (lower(buyer_email));

-- ── guests: one row per seat ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS club_event_guests (
  id                     integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id               integer NOT NULL REFERENCES club_event_orders(id) ON DELETE CASCADE,
  seat_no                integer NOT NULL,
  -- NULL = the buyer hasn't told us yet. Never invented from the buyer's name.
  full_name              text,
  dietary                text,
  checked_in_at          timestamptz,
  checked_in_by_user_id  integer REFERENCES users(id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_event_guests_seat_positive CHECK (seat_no > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS club_event_guests_seat_unique ON club_event_guests (order_id, seat_no);

-- ── audit log ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS club_event_log (
  id             integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  event_id       integer NOT NULL REFERENCES club_events(id) ON DELETE CASCADE,
  order_id       integer REFERENCES club_event_orders(id) ON DELETE CASCADE,
  kind           text    NOT NULL,
  actor          text    NOT NULL,            -- buyer | staff | stripe | system
  actor_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  detail         jsonb,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_event_log_order_idx ON club_event_log (order_id);
CREATE INDEX IF NOT EXISTS club_event_log_event_idx ON club_event_log (event_id, at);

-- ── the ticket reference ────────────────────────────────────────────────────
-- Identity defaults are applied BEFORE row triggers fire, so NEW.id is real here.
CREATE OR REPLACE FUNCTION club_event_orders_set_ref() RETURNS trigger AS $$
DECLARE
  code text;
BEGIN
  IF NEW.ref IS NULL OR NEW.ref = '' THEN
    SELECT short_code INTO code FROM club_events WHERE id = NEW.event_id;
    NEW.ref := upper(coalesce(code, 'EV')) || '-' || lpad(NEW.id::text, 4, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS club_event_orders_ref ON club_event_orders;
CREATE TRIGGER club_event_orders_ref
  BEFORE INSERT ON club_event_orders
  FOR EACH ROW EXECUTE FUNCTION club_event_orders_set_ref();

-- ── capacity ────────────────────────────────────────────────────────────────
-- 🔴 The DATABASE decides whether a seat is still for sale. A paid order always
-- holds its seats; a pending order holds them for 30 minutes from creation
-- (a card form left open), then lets go. cancelled/refunded hold nothing.
-- The event row is locked FOR UPDATE so two buyers of the last seats serialise.
CREATE OR REPLACE FUNCTION club_event_orders_enforce_capacity() RETURNS trigger AS $$
DECLARE
  cap       integer;
  type_cap  integer;
  taken     integer;
BEGIN
  -- Only transitions that can ADD seats to the live count are guarded.
  IF NEW.status NOT IN ('pending', 'paid') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IN ('pending','paid') AND OLD.status IN ('pending','paid')
     AND NEW.quantity = OLD.quantity
     AND NEW.event_id = OLD.event_id
     AND NEW.ticket_type_id = OLD.ticket_type_id
     -- 🔴 …except a pending order whose 30-minute hold has EXPIRED being paid:
     -- its seats were released and may have been sold on. That one must
     -- re-check, and the app refunds the card if the room is now full.
     AND NOT (OLD.status = 'pending' AND NEW.status = 'paid'
              AND OLD.created_at <= now() - interval '30 minutes')
  THEN
    RETURN NEW;
  END IF;

  SELECT capacity INTO cap FROM club_events WHERE id = NEW.event_id FOR UPDATE;

  IF cap IS NOT NULL THEN
    SELECT coalesce(sum(quantity), 0) INTO taken
    FROM club_event_orders
    WHERE event_id = NEW.event_id
      AND id <> NEW.id
      AND (status = 'paid' OR (status = 'pending' AND created_at > now() - interval '30 minutes'));
    IF taken + NEW.quantity > cap THEN
      RAISE EXCEPTION 'club_events: sold out — % of % seats taken (event %)', taken, cap, NEW.event_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  SELECT quantity_cap INTO type_cap FROM club_event_ticket_types WHERE id = NEW.ticket_type_id;
  IF type_cap IS NOT NULL THEN
    SELECT coalesce(sum(quantity), 0) INTO taken
    FROM club_event_orders
    WHERE ticket_type_id = NEW.ticket_type_id
      AND id <> NEW.id
      AND (status = 'paid' OR (status = 'pending' AND created_at > now() - interval '30 minutes'));
    IF taken + NEW.quantity > type_cap THEN
      RAISE EXCEPTION 'club_events: that ticket type is sold out — % of % (type %)', taken, type_cap, NEW.ticket_type_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS club_event_orders_capacity ON club_event_orders;
CREATE TRIGGER club_event_orders_capacity
  BEFORE INSERT OR UPDATE ON club_event_orders
  FOR EACH ROW EXECUTE FUNCTION club_event_orders_enforce_capacity();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Enabled with no policies: the server connects as postgres (bypasses RLS);
-- a leaked anon key reads nothing. Standing rule after any migration.
ALTER TABLE club_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_event_ticket_types  ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_event_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_event_guests        ENABLE ROW LEVEL SECURITY;
ALTER TABLE club_event_log           ENABLE ROW LEVEL SECURITY;

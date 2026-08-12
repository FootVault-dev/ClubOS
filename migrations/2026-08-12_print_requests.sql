-- ─────────────────────────────────────────────────────────────────────────────
-- Internal print requests — staff ask the print shop, Dima approves or declines
--
-- Today this runs on WhatsApp and someone hand-types the outcome into
-- print_orders. Three such rows are already in there with no order number, one
-- titled "Name and number for Anderson #22 from Tr…" — the workflow exists, it
-- just has no system.
--
-- A request is deliberately NOT a print_orders row. An order is work the shop
-- has committed to; a request is a question waiting on an answer. Approving
-- turns one into the other and keeps the link, exactly as approving a website
-- quote does.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS print_requests (
  id                 integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- 🔴 RESTRICT, not SET NULL: who asked for a print job is part of its
  -- history. Deleting a staff account must not erase who ordered the signage.
  requester_user_id  integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  status             text NOT NULL DEFAULT 'new',       -- new | approved | declined

  request_type       text NOT NULL,                     -- banner | corflute | signage | garment | sticker_decal | poster | other
  title              text NOT NULL,
  for_brand          text,                              -- CUFC | SIU | MFL | CIC | CUGC | USC | USG

  quantity           integer NOT NULL DEFAULT 1,

  -- Nullable on purpose: a shirt has no width and height, and a 0 would read
  -- as a real measurement taken by a real person.
  width_mm           integer,
  height_mm          integer,
  size_note          text,

  -- [{size, qty, name, number}] — "name and number for Anderson #22" is the
  -- club's most common ask and a single quantity box throws the detail away.
  garment_details_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  print_location     text,

  details            text,
  -- A LINK. There is no file transport on this path yet, and a bare filename
  -- is useless to whoever has to print it.
  artwork_url        text,
  artwork_note       text,

  needed_by          date,
  urgency            text NOT NULL DEFAULT 'standard',  -- standard | urgent

  decided_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at         timestamp,
  decline_reason     text,
  print_order_id     integer REFERENCES print_orders(id) ON DELETE SET NULL,

  created_at         timestamp NOT NULL DEFAULT now(),
  updated_at         timestamp NOT NULL DEFAULT now()
);

-- No CHECK constraints on the enum-ish columns: a stale one in prod is how the
-- MFL checkout 500'd. Validation lives in the app, where it can be changed.

CREATE INDEX IF NOT EXISTS print_requests_org_status_idx
  ON print_requests (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS print_requests_requester_idx
  ON print_requests (requester_user_id, created_at DESC);

-- 🔴 New tables default to RLS OFF, and a Supabase anon key is public by
-- design. Our own connections are postgres/service-role (rolbypassrls), so
-- this changes nothing for the app — it is the second wall that catches a
-- leaked key. Twice bitten already.
ALTER TABLE print_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE print_requests IS
  'Internal print requests from club staff (Travis et al) → Dima approves/declines in ClubOS → United Prints → Requests. Approving creates a print_orders job and links it via print_order_id.';

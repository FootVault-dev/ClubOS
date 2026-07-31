-- PayShare — third-party group-checkout orchestration for the USC booking site.
--
-- Additive only: three new tables plus one nullable boolean on venue_settings.
-- Nothing existing is altered. Player Pay (split_sessions / split_members) is
-- deliberately untouched — the two split options run side by side, and PayShare
-- must never be able to take our own split down with it.
--
-- No CHECK constraints on the enum-ish columns (status, role, kind): a stale
-- CHECK is how the MFL checkout once 500'd. The app validates these; the
-- database enforces only the invariants that must never be raced.

BEGIN;

ALTER TABLE venue_settings
  ADD COLUMN IF NOT EXISTS payshare_enabled boolean DEFAULT false;

-- One session = one group paying for one pending booking group.
CREATE TABLE IF NOT EXISTS payshare_sessions (
  id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id         text NOT NULL,
  booking_group_id   text,
  amount_minor       integer NOT NULL,
  currency           text NOT NULL,
  status             text NOT NULL DEFAULT 'open',
  session_url        text,
  merchant_order_ref text,
  expires_at         timestamp,
  completed_at       timestamp,
  created_at         timestamp NOT NULL DEFAULT now()
);

-- PayShare's session id is the join key on every inbound hook and webhook, so
-- it must resolve to exactly one row or a replayed hook could fund two bookings.
CREATE UNIQUE INDEX IF NOT EXISTS payshare_sessions_session_id_unique
  ON payshare_sessions (session_id);
CREATE INDEX IF NOT EXISTS payshare_sessions_booking_group_idx
  ON payshare_sessions (booking_group_id);

CREATE TABLE IF NOT EXISTS payshare_participants (
  id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payshare_session_id      integer NOT NULL REFERENCES payshare_sessions(id) ON DELETE CASCADE,
  participant_id           text NOT NULL,
  role                     text NOT NULL DEFAULT 'participant',
  share_amount_minor       integer NOT NULL,
  currency                 text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending',
  pay_token                text NOT NULL,
  stripe_payment_intent_id text,
  return_url               text,
  paid_at                  timestamp,
  created_at               timestamp NOT NULL DEFAULT now()
);

-- One row per participant per session: PayShare retries the create-payment hook,
-- and without this a retry mints a second payment intent for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS payshare_participants_session_participant_unique
  ON payshare_participants (payshare_session_id, participant_id);
-- The pay token is the URL a stranger could otherwise guess.
CREATE UNIQUE INDEX IF NOT EXISTS payshare_participants_pay_token_unique
  ON payshare_participants (pay_token);

-- Inbound-event dedupe. The SDK offers an in-memory Map/Set for this; prod runs
-- TWO Fly machines, so in-memory state lets a replayed webhook confirm the same
-- booking twice. This index is the real guard.
CREATE TABLE IF NOT EXISTS payshare_events (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id      text NOT NULL,
  kind          text NOT NULL,
  session_id    text,
  response_json jsonb,
  received_at   timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payshare_events_event_id_kind_unique
  ON payshare_events (event_id, kind);

COMMIT;

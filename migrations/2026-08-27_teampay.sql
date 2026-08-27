-- ═══════════════════════════════════════════════════════════════════════════
-- Team Pay — team entries, squad payment, and the fill-in marketplace
-- 2026-08-27 · from Isaac Living's spec (13 Aug Tournament Planning Meeting)
--
-- Additive. Touches no existing table. Every rule that money or a person's
-- privacy depends on is a constraint here, not a line of TypeScript — because
-- two managers tapping "add this fill-in" at the same instant is a race, and a
-- race walks straight through an `if`.
--
-- 🔴 NO transaction control in this file. script/apply-teampay.ts wraps it, and
-- a BEGIN/COMMIT in here would defeat its --dry-run (the inner COMMIT ends the
-- transaction and the ROLLBACK then runs in autocommit). 14 migrations in this
-- repo still have that hole; this one does not.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the registry ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_competitions (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  kind                text    NOT NULL,
  tournament_id       integer REFERENCES tournaments(id) ON DELETE CASCADE,
  program_id          integer REFERENCES programs(id)    ON DELETE CASCADE,

  slug                text    NOT NULL,
  name                text    NOT NULL,
  brand               text    NOT NULL DEFAULT 'ethniccup',

  fee_cents           integer NOT NULL,
  currency            text    NOT NULL DEFAULT 'NZD',
  default_squad_size  integer NOT NULL DEFAULT 14,

  entries_open        boolean NOT NULL DEFAULT false,
  payments_enabled    boolean NOT NULL DEFAULT false,
  fillins_open        boolean NOT NULL DEFAULT false,

  blurb               text,
  pay_by_date         date,

  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now(),

  -- A competition belongs to a tournament or a programme. Never both, never
  -- neither. One CHECK enforces the kind and the foreign key together, so the
  -- discriminator can never disagree with the column it discriminates.
  CONSTRAINT teampay_competitions_one_parent CHECK (
    (kind = 'tournament' AND tournament_id IS NOT NULL AND program_id IS NULL)
    OR
    (kind = 'program'    AND program_id    IS NOT NULL AND tournament_id IS NULL)
  ),
  CONSTRAINT teampay_competitions_fee_sane   CHECK (fee_cents >= 0),
  CONSTRAINT teampay_competitions_squad_sane CHECK (default_squad_size BETWEEN 1 AND 40)
);

CREATE UNIQUE INDEX IF NOT EXISTS teampay_competitions_slug_unique
  ON teampay_competitions (slug);
CREATE INDEX IF NOT EXISTS teampay_competitions_org_idx
  ON teampay_competitions (organization_id);

-- ── entries ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_entries (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  competition_id   integer NOT NULL REFERENCES teampay_competitions(id) ON DELETE CASCADE,
  organization_id  integer NOT NULL REFERENCES organizations(id)        ON DELETE CASCADE,

  team_name        text    NOT NULL,
  community        text,

  manager_name     text    NOT NULL,
  manager_email    text    NOT NULL,
  manager_phone    text,

  squad_size       integer NOT NULL,
  fee_cents        integer NOT NULL,

  organiser_token  text    NOT NULL,

  status           text    NOT NULL DEFAULT 'active',
  withdrawn_at     timestamp,
  paid_up_at       timestamp,
  notes            text,

  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now(),

  CONSTRAINT teampay_entries_squad_sane CHECK (squad_size BETWEEN 1 AND 40),
  CONSTRAINT teampay_entries_fee_sane   CHECK (fee_cents >= 0)
  -- Deliberately NO check on `status`. A stale CHECK on an enum-ish column is
  -- how the MFL checkout once 500'd; statuses are validated in app code.
);

CREATE UNIQUE INDEX IF NOT EXISTS teampay_entries_organiser_token_unique
  ON teampay_entries (organiser_token);
CREATE INDEX IF NOT EXISTS teampay_entries_competition_idx
  ON teampay_entries (competition_id);

-- ── the roster ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_players (
  id                       integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entry_id                 integer NOT NULL REFERENCES teampay_entries(id) ON DELETE CASCADE,

  name                     text    NOT NULL,
  email                    text,
  phone                    text,

  invite_token             text    NOT NULL,
  source                   text    NOT NULL DEFAULT 'roster',
  is_manager               boolean NOT NULL DEFAULT false,

  first_opened_at          timestamp,
  open_count               integer NOT NULL DEFAULT 0,
  last_opened_at           timestamp,

  declined_at              timestamp,
  removed_at               timestamp,

  nudge_count              integer NOT NULL DEFAULT 0,
  last_nudged_at           timestamp,

  paid_cents               integer,
  paid_at                  timestamp,
  stripe_customer_id       text,
  stripe_payment_intent_id text,
  stripe_refund_id         text,
  refunded_at              timestamp,
  refunded_cents           integer,

  -- FK added after teampay_fillins exists — see the ALTER below.
  fillin_id                integer,

  created_at               timestamp NOT NULL DEFAULT now(),
  updated_at               timestamp NOT NULL DEFAULT now(),

  -- A player nobody can reach cannot be invited, nudged, or paid — so a roster
  -- row without a way to contact them is not a roster row, it is a note.
  CONSTRAINT teampay_players_contactable CHECK (email IS NOT NULL OR phone IS NOT NULL),

  -- Paid means an amount. The two travel together or the dashboard shows
  -- "Paid — $0.00", which is what every camp registration in this database
  -- already says because amount_paid was never set.
  CONSTRAINT teampay_players_paid_pair CHECK ((paid_at IS NULL) = (paid_cents IS NULL)),
  CONSTRAINT teampay_players_paid_sane CHECK (paid_cents IS NULL OR paid_cents >= 0),

  -- You cannot refund money that was never taken, nor more of it than was taken.
  CONSTRAINT teampay_players_refund_sane CHECK (
    refunded_cents IS NULL
    OR (paid_cents IS NOT NULL AND refunded_cents >= 0 AND refunded_cents <= paid_cents)
  ),

  -- 🔴 A player who paid cannot be quietly dropped off the roster. Removing them
  -- forces the refund decision to be made and recorded, rather than leaving a
  -- real charge attached to nobody.
  CONSTRAINT teampay_players_no_silent_drop CHECK (
    NOT (removed_at IS NOT NULL AND paid_at IS NOT NULL AND refunded_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS teampay_players_invite_token_unique
  ON teampay_players (invite_token);
CREATE INDEX IF NOT EXISTS teampay_players_entry_idx
  ON teampay_players (entry_id);
CREATE INDEX IF NOT EXISTS teampay_players_payment_intent_idx
  ON teampay_players (stripe_payment_intent_id);

-- One live row per email per team. Re-inviting someone reactivates their row
-- instead of minting a second link, so "has Ahmed paid?" has one answer.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_players_entry_email_unique
  ON teampay_players (entry_id, lower(email))
  WHERE email IS NOT NULL AND removed_at IS NULL;

-- Exactly one manager row per entry.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_players_one_manager
  ON teampay_players (entry_id)
  WHERE is_manager;

-- 🔴 Isaac's requirement, in the database: a fill-in cannot end up on two teams.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_players_one_team_per_fillin
  ON teampay_players (fillin_id)
  WHERE fillin_id IS NOT NULL AND removed_at IS NULL;

-- ── the fill-in pool ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_fillins (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  competition_id   integer NOT NULL REFERENCES teampay_competitions(id) ON DELETE CASCADE,
  organization_id  integer NOT NULL REFERENCES organizations(id)        ON DELETE CASCADE,

  first_name       text    NOT NULL,
  last_name        text,
  email            text    NOT NULL,
  phone            text,

  position         text,
  ability          text,
  highest_level    text,
  from_where       text,
  motivation       text,
  note             text,

  status           text    NOT NULL DEFAULT 'available',
  player_token     text    NOT NULL,

  created_at       timestamp NOT NULL DEFAULT now(),
  updated_at       timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS teampay_fillins_player_token_unique
  ON teampay_fillins (player_token);
CREATE INDEX IF NOT EXISTS teampay_fillins_competition_idx
  ON teampay_fillins (competition_id, status);

-- One signup per person per competition. Someone re-submitting the form gets
-- their existing profile back, not a duplicate in the pool.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_fillins_competition_email_unique
  ON teampay_fillins (competition_id, lower(email));

-- Deferred from teampay_players above, now that the target table exists.
-- SET NULL rather than CASCADE: a fill-in withdrawing from the pool must never
-- delete the roster row of a team they already joined and paid for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teampay_players_fillin_id_fkey'
  ) THEN
    ALTER TABLE teampay_players
      ADD CONSTRAINT teampay_players_fillin_id_fkey
      FOREIGN KEY (fillin_id) REFERENCES teampay_fillins(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── holds ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_fillin_holds (
  id             integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  fillin_id      integer NOT NULL REFERENCES teampay_fillins(id)  ON DELETE CASCADE,
  entry_id       integer NOT NULL REFERENCES teampay_entries(id)  ON DELETE CASCADE,

  state          text    NOT NULL DEFAULT 'active',
  hold_token     text    NOT NULL,

  requested_at   timestamp NOT NULL DEFAULT now(),
  expires_at     timestamp NOT NULL,
  responded_at   timestamp,
  manager_note   text,
  player_id      integer REFERENCES teampay_players(id) ON DELETE SET NULL,

  created_at     timestamp NOT NULL DEFAULT now(),

  CONSTRAINT teampay_holds_window_sane CHECK (expires_at > requested_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS teampay_fillin_holds_hold_token_unique
  ON teampay_fillin_holds (hold_token);
CREATE INDEX IF NOT EXISTS teampay_fillin_holds_fillin_idx
  ON teampay_fillin_holds (fillin_id);
CREATE INDEX IF NOT EXISTS teampay_fillin_holds_entry_idx
  ON teampay_fillin_holds (entry_id, state);

-- 🔴 THE double-booking guard. Two managers tapping the same player at the same
-- moment: one gets the hold, the other gets a unique violation and is told the
-- player has just been claimed. App code cannot do this correctly.
CREATE UNIQUE INDEX IF NOT EXISTS teampay_fillin_holds_one_active
  ON teampay_fillin_holds (fillin_id)
  WHERE state = 'active';

-- ── audit ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS teampay_events (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  entry_id    integer REFERENCES teampay_entries(id)  ON DELETE CASCADE,
  player_id   integer REFERENCES teampay_players(id)  ON DELETE SET NULL,
  fillin_id   integer REFERENCES teampay_fillins(id)  ON DELETE SET NULL,
  kind        text    NOT NULL,
  actor       text    NOT NULL DEFAULT 'system',
  detail      jsonb,
  created_at  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS teampay_events_entry_idx
  ON teampay_events (entry_id, created_at);

-- ── the two rules a constraint cannot express ───────────────────────────────

-- 🔴 The share is fee ÷ squad size. Change the squad size after someone has
-- paid and the player who paid first paid a different price for the same seat.
-- The manager can resize freely until the first payment lands, and not after.
CREATE OR REPLACE FUNCTION teampay_freeze_squad_size() RETURNS trigger AS $$
BEGIN
  IF NEW.squad_size IS DISTINCT FROM OLD.squad_size
     AND EXISTS (SELECT 1 FROM teampay_players WHERE entry_id = OLD.id AND paid_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'teampay: squad size is fixed once a player has paid (entry %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teampay_entries_freeze_squad_size ON teampay_entries;
CREATE TRIGGER teampay_entries_freeze_squad_size
  BEFORE UPDATE ON teampay_entries
  FOR EACH ROW EXECUTE FUNCTION teampay_freeze_squad_size();

-- 🔴 A squad cannot hold more players than it has seats, or the club collects
-- more than the team fee. The DATABASE decides this; the dashboard only greys
-- out the button. One authority, one answer, no race.
--
-- "Counts towards the squad" here is the same rule as countsTowardsSquad() in
-- shared/teampay.ts: paid always counts; otherwise not declined and not removed.
CREATE OR REPLACE FUNCTION teampay_enforce_squad_capacity() RETURNS trigger AS $$
DECLARE
  seats integer;
  taken integer;
BEGIN
  -- Only guard transitions that can ADD someone to the active squad.
  IF TG_OP = 'UPDATE'
     AND NEW.declined_at IS NOT DISTINCT FROM OLD.declined_at
     AND NEW.removed_at  IS NOT DISTINCT FROM OLD.removed_at
     AND NEW.entry_id    IS NOT DISTINCT FROM OLD.entry_id
  THEN
    RETURN NEW;
  END IF;

  SELECT squad_size INTO seats FROM teampay_entries WHERE id = NEW.entry_id FOR UPDATE;
  IF seats IS NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO taken
  FROM teampay_players
  WHERE entry_id = NEW.entry_id
    AND id <> NEW.id
    AND (paid_at IS NOT NULL OR (declined_at IS NULL AND removed_at IS NULL));

  IF (NEW.paid_at IS NOT NULL OR (NEW.declined_at IS NULL AND NEW.removed_at IS NULL))
     AND taken + 1 > seats
  THEN
    RAISE EXCEPTION 'teampay: squad is full — % of % seats taken (entry %)', taken, seats, NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS teampay_players_squad_capacity ON teampay_players;
CREATE TRIGGER teampay_players_squad_capacity
  BEFORE INSERT OR UPDATE ON teampay_players
  FOR EACH ROW EXECUTE FUNCTION teampay_enforce_squad_capacity();

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- 🔴 New tables default to RLS OFF, and the Supabase anon key is public by
-- design — it ships in a browser bundle. Off + public key has meant "the world
-- can read this table" twice in this workspace already (17 DanielMeynOS tables,
-- 13 hada_* salon tables). These hold squad members' phone numbers and the
-- stories of people new to the country. RLS on, no policies: our own server
-- connects as service-role and bypasses it; a leaked anon key reaches nothing.
ALTER TABLE teampay_competitions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE teampay_entries       ENABLE ROW LEVEL SECURITY;
ALTER TABLE teampay_players       ENABLE ROW LEVEL SECURITY;
ALTER TABLE teampay_fillins       ENABLE ROW LEVEL SECURITY;
ALTER TABLE teampay_fillin_holds  ENABLE ROW LEVEL SECURITY;
ALTER TABLE teampay_events        ENABLE ROW LEVEL SECURITY;

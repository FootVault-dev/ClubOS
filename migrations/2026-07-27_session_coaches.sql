-- Coaching roster + coach roll for term programmes (Zach, U4–U8 programme lead).
--
-- The player roll answers "which children were here on this date at this time".
-- This answers the other half nobody could see: WHICH COACHES were rostered on,
-- and which of them actually turned up — tracked across a whole term.
--
-- Shape deliberately mirrors `attendance`:
--   * one row per coach per SESSION (camp_date), because camp_dates is keyed by
--     SLOT — the U4–U8 programme runs Sat 09:30 (U4–U6) AND Sat 10:30 (U7–U8)
--     and they are different sessions with different coaches.
--   * a coach IS a `contacts` row (type='staff'). Players and coaches already
--     live there — Paul Holocher's Term 3 roster was seeded into it on
--     2026-07-22 — and forking them would fork the club's database.
--   * status is 'present' | 'absent' | NULL, where NULL means NOT MARKED YET.
--     A half-taken roll must never read as "nobody came". Deliberately not a DB
--     enum or CHECK: a stale CHECK is how the MFL checkout 500'd.
--
-- Both FKs to people/sessions are NO ACTION (≈ RESTRICT), matching `attendance`:
-- deleting a coach must never erase the record of who ran a session, and a
-- schedule regenerate must not silently destroy a term of coaching history.

CREATE TABLE IF NOT EXISTS session_coaches (
  id                  integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  camp_id             integer NOT NULL REFERENCES programs(id),
  camp_date_id        integer NOT NULL REFERENCES camp_dates(id),
  contact_id          integer NOT NULL REFERENCES contacts(id),
  -- 'lead' | 'coach' | 'assistant' — validated by the route, not the DB.
  role                text NOT NULL DEFAULT 'coach',
  -- 'present' | 'absent' | NULL (not marked yet).
  status              text,
  marked_at           timestamp,
  marked_by_user_id   integer REFERENCES users(id),
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_user_id  integer REFERENCES users(id)
);

-- One line per coach per session: assigning the same coach twice is a no-op,
-- not a duplicate row that would double every count on the overview.
CREATE UNIQUE INDEX IF NOT EXISTS session_coaches_unique
  ON session_coaches (camp_date_id, contact_id);

CREATE INDEX IF NOT EXISTS session_coaches_camp_idx ON session_coaches (camp_id);
CREATE INDEX IF NOT EXISTS session_coaches_contact_idx ON session_coaches (contact_id);

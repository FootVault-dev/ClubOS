-- Academy term-programme attendance (the roll). ADDITIVE ONLY.
--
-- Why this exists
-- ---------------
-- `attendance` was built for holiday camps, where a registrant is a `children`
-- row reached through one `registration_items` line per child per day. Academy
-- term programmes have neither shape: the registrant contact IS the player
-- (contacts.type = 'player', see storage.getProgramPlayers "Shape 1"), and a
-- term enrolment writes NO per-date registration_items at all. Programme 4
-- (FUNiño — First Kicks) has 72 registrants and 0 registration_items, so the
-- existing roll query returns an empty list for every session.
--
-- So `attendance` gains a second, mutually-exclusive person reference.
--
--   child_id   — holiday camps (unchanged, still the only shape camps write)
--   contact_id — academy/term programmes, where the player is a contact
--
-- Both FKs stay NO ACTION (≈ RESTRICT): deleting a person must never silently
-- erase the record of whether they turned up — the same reasoning that made
-- club_squad_members and housing tenants RESTRICT.
--
-- `status` is the term-roll state and is deliberately NOT a CHECK-constrained
-- enum. A stale CHECK is how the MFL checkout started 500ing; the app validates
-- the value ('present' | 'absent') and NULL honestly means "not marked yet",
-- which is a different fact from "absent" and must stay distinguishable.
--
-- Sign-out is intentionally absent from this shape. A holiday camp signs a
-- child out to a named adult (a custody record). A 45-minute academy session
-- ends when training ends — checked_out_at stays NULL for term programmes and
-- the roll UI never offers it.

ALTER TABLE attendance ALTER COLUMN child_id DROP NOT NULL;

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS contact_id integer REFERENCES contacts(id);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_at timestamp;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS marked_by_user_id integer REFERENCES users(id);

-- One roll line per person per session. The existing UNIQUE (camp_date_id,
-- child_id) keeps doing that job for camps; NULL child_id rows don't collide
-- with each other because Postgres treats NULLs as distinct in a UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_camp_date_contact_uniq
  ON attendance (camp_date_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- A roll line must point at exactly one person. This is a structural
-- invariant, not an enum, so a CHECK is the right tool: a row referencing
-- neither (or both) is a bug that would silently produce a phantom register
-- entry. Guarded so a re-run doesn't fail on an existing constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'attendance'::regclass AND conname = 'attendance_one_person_ck'
  ) THEN
    ALTER TABLE attendance ADD CONSTRAINT attendance_one_person_ck
      CHECK ((child_id IS NOT NULL) <> (contact_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS attendance_contact_idx ON attendance (contact_id) WHERE contact_id IS NOT NULL;

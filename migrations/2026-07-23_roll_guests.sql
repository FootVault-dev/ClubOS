-- Walk-ups on the roll: children who turn up to a session but are not a
-- confirmed registration. ADDITIVE ONLY.
--
-- Why
-- ---
-- The academy roll is built from confirmed registrations, which is right for
-- the paying cohort but silently loses the two groups the club most needs to
-- see: children on a free **open training** (the invite-only funnel into
-- U9–U20, see the Open Trainings tab) and children who are training while
-- their family **hasn't paid yet**. Both stand on the field and both were
-- invisible, so "how many kids were actually here" and "how many of them are
-- registered" could not be answered from the roll.
--
-- `guest_kind` records WHY someone on the roll isn't a registration:
--
--   NULL            — a confirmed registration (the normal case)
--   'open_training' — free open-training attendee / trialist
--   'unpaid'        — training but the registration isn't paid
--
-- Deliberately not a CHECK-constrained enum, same reasoning as
-- attendance.status: a stale CHECK is how the MFL checkout started 500ing, and
-- new reasons (a make-up session, a sibling tagging along) should not require a
-- migration. The route validates the value.
--
-- The person is still a real `contacts` row, NOT a name typed onto the
-- attendance line. An open trainer is a lead the club wants to convert, and a
-- name-on-a-row cannot be counted across sessions, searched for, or turned into
-- a registration later. attendance.contact_id already carries them.

ALTER TABLE attendance ADD COLUMN IF NOT EXISTS guest_kind text;

-- "Who came but isn't registered" is the reporting question this exists to
-- answer, so it gets an index rather than a table scan over every roll line
-- the club has ever taken.
CREATE INDEX IF NOT EXISTS attendance_guest_kind_idx
  ON attendance (camp_id, guest_kind)
  WHERE guest_kind IS NOT NULL;

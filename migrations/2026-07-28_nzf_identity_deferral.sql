-- A documented skip for NZ Football identity capture at the counter.
--
-- Why (Daniel's call, 2026-07-28):
--   The office walk-up path let staff save a registration with no NZF identity
--   and no address at all, which quietly recreated the very gap the structured
--   fields were built to close — and the office is exactly where open-training
--   invitees pay, so it is real volume, not an edge case.
--
--   The fix is NOT to block the counter. A parent standing there with cash and
--   a queue behind them must always be able to pay, and some genuinely cannot
--   answer on the spot: they don't know their child's iwi, or they haven't got
--   the postcode in their head. Blocking that would cost the club a
--   registration to satisfy a data field, and would push staff into inventing
--   answers — the worst possible outcome, because a guessed ethnicity is
--   indistinguishable from a real one once it is stored.
--
--   So: the fields are REQUIRED by default, and skipping is a deliberate,
--   attributed act that lands the child on a follow-up list. Capture is the
--   default; a gap is a decision someone made and signed.
--
-- ADDITIVE AND IDEMPOTENT. Three nullable columns. Nothing is dropped and no
-- existing row changes — every contact registered before today simply has no
-- deferral recorded, which is correct: nobody deferred anything, the question
-- was never asked.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_deferred_at     timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_deferred_reason text;

-- Who made the call. Same reasoning as registrations.served_by_user_id: this is
-- an accountability record, so deleting a staff account must never erase who
-- decided a child's identity data could wait.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_deferred_by_user_id integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_identity_deferred_by_user_id_fkey'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_identity_deferred_by_user_id_fkey
      FOREIGN KEY (identity_deferred_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- The follow-up list: everyone whose NZF data is still outstanding, deferred or
-- not. Partial so it stays small as the gap closes. (The existing
-- contacts_nzf_identity_incomplete_idx covers the identity fields; this one
-- exists so "who did we promise to come back to" is a cheap lookup on its own.)
CREATE INDEX IF NOT EXISTS contacts_identity_deferred_idx
  ON contacts (identity_deferred_at)
  WHERE identity_deferred_at IS NOT NULL;

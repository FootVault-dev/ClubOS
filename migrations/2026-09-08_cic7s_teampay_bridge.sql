-- CIC 7's — the register-interest form becomes the front door to a paid team entry.
--
-- Daniel, 2026-09-08: "after registrations of interest once they submit they
-- immediately get redirected to sales page to pay for whole team or player pay
-- … all linked with clubos backend."
--
-- The form on cic7s.com already writes a cic7s_registrations row. This gives
-- that row two things: a random token the browser is handed back (the sales
-- page spends it ONCE to create the Team Pay entry, server-side, pre-filled
-- from the registration — no personal details ride in a URL), and the id of
-- the entry it became, so "entered" is a fact with a team behind it and not a
-- word somebody typed.
--
-- 🔴 The token is the only key the public route accepts. The row id is
-- sequential and guessable; a route keyed on it would let anyone create a team
-- under somebody else's name and email.
--
-- 🔴 ON DELETE SET NULL, not CASCADE: staff deleting a test team from the
-- Team Entries board must never erase the registration of interest behind it.
--
-- Additive and idempotent. No existing column is altered. No BEGIN/COMMIT here
-- on purpose — the applier wraps it so a dry run can roll it back.

ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS enter_token text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS teampay_entry_id integer
  REFERENCES teampay_entries(id) ON DELETE SET NULL;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS notes text;

-- One token, one registration. Two rows sharing a token would let the sales
-- page create a team for the wrong person.
CREATE UNIQUE INDEX IF NOT EXISTS cic7s_registrations_enter_token_unique
  ON cic7s_registrations (enter_token) WHERE enter_token IS NOT NULL;

-- One registration, one team. A double-tap on the sales page must not put the
-- same squad in the draw twice (the same rule ethnic_cup_registrations carries).
CREATE UNIQUE INDEX IF NOT EXISTS cic7s_registrations_teampay_entry_unique
  ON cic7s_registrations (teampay_entry_id) WHERE teampay_entry_id IS NOT NULL;

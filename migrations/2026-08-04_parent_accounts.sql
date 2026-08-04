-- Parent accounts — the Friendly Manager replacement for families.
--
-- A parent proves control of an email address and gets a read/write view of
-- their OWN family: their children, those children's programmes and fees, and
-- the details the club holds about all of them. Nothing about the club's data
-- model changes — `contacts` already holds every field a parent account needs.
-- What was missing was a way for the parent to reach it.
--
-- Additive only: one new table. No existing column is added, altered or dropped.
--
-- ── Why the login anchors on GUARDIAN rows only ──────────────────────────────
-- Probed against prod before writing (2026-08-04):
--     6,508 player contacts   — 4,662 of them carry an email
--     3,989 guardian contacts — 3,918 of them carry an email
--     2,761 email addresses map to MORE THAN ONE contact row (6,190 rows)
--     worst case: one address maps to 17 rows
-- The reason is that a child's contact row is stamped with the PARENT's email.
-- So "find the contact with this email" is not a login — it can land on a child.
-- The session therefore resolves to contacts of type 'guardian' only, and the
-- family is the union across ALL guardian rows sharing that verified address
-- (a parent who registered three times has three guardian rows; showing them
-- one of the three would show them a third of their family).

CREATE TABLE IF NOT EXISTS parent_login_codes (
  id            integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  -- Lower-cased and trimmed at write time. Not unique: a parent may request a
  -- fresh code before the old one expires, and both rows must survive so the
  -- rate limiter can count them.
  email         text        NOT NULL,
  -- The code itself is NEVER stored. A leaked backup must not be a set of live
  -- credentials, and staff reading the table must not be able to sign in as a
  -- family. sha256(code + email) — salted by the address so identical codes
  -- issued to two families do not share a hash.
  code_hash     text        NOT NULL,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  -- Wrong guesses against THIS code. A 6-digit code is 1-in-a-million per try,
  -- so the code dies after 5 wrong answers rather than being brute-forced.
  attempts      integer     NOT NULL DEFAULT 0,
  request_ip    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The verify path looks up the newest live code for an address; the rate
-- limiter counts recent rows for an address. Both are this index.
CREATE INDEX IF NOT EXISTS parent_login_codes_email_idx
  ON parent_login_codes (email, created_at DESC);

-- Rate limiting by origin IP, so one host cannot farm codes at every address
-- it can guess.
CREATE INDEX IF NOT EXISTS parent_login_codes_ip_idx
  ON parent_login_codes (request_ip, created_at DESC) WHERE request_ip IS NOT NULL;

-- Guardian lookup by email is now on the login path, not just an admin search.
-- Case-insensitive because families type their address however they like.
CREATE INDEX IF NOT EXISTS contacts_email_lower_idx
  ON contacts (LOWER(TRIM(email))) WHERE email IS NOT NULL AND email <> '';

-- RLS, per the standing rule: a new table defaults to RLS OFF, and off is how
-- a leaked key becomes a data breach. The app connects as the table owner
-- (rolbypassrls), so this changes nothing for ClubOS itself — it is the second
-- wall. This table holds login material, so it gets no policy at all: nothing
-- but the owner may ever read it.
ALTER TABLE parent_login_codes ENABLE ROW LEVEL SECURITY;

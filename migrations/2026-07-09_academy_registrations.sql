-- ─────────────────────────────────────────────────────────────────────────────
-- Academy registrations — "The Great Reset": CUFC moves every academy
-- programme off Friendly Manager onto ClubOS.
--
-- Covers FUNiño (U4–U8), Pre-Academy (U9–U12), Academy (U13–U17), and the
-- "additional" programmes (Technification, Goalkeeper, Morning Programme).
-- These are all `programs` rows with type='academy'; the core/additional split
-- is the existing `academy_section` column.
--
-- THREE THINGS THIS MIGRATION EXISTS FOR
--
-- 1. NZ FOOTBALL / MAINLAND FOOTBALL AUDIT FIELDS.
--    Mainland Football require a database audit each season, and NZF's National
--    Registration System (Sporty, which replaced COMET on 1 Jan 2026) requires
--    country of birth, ethnicity, specific ethnic group / iwi, and an optional
--    second ethnicity for every registrant. Friendly Manager collects these
--    today (fields `custom[countryOfBirth|ethnicity|subEthnicity|ethnicity2|
--    subEthnicity2]`, verified in outputs/cufc-tilda-archive/friendlymanager/
--    form-6.html). ClubOS `contacts` did not. Without these columns we cannot
--    satisfy the audit from ClubOS, and the Sporty registration sync
--    (outputs/sporty-api-brief/BRIEF.md, Integration 1) cannot be built.
--
--    Stored as free TEXT, deliberately NOT an enum / CHECK: Sporty's exact
--    accepted vocabulary is not yet confirmed with NZF, and prod enum drift is
--    a known hazard in this DB. The app validates against
--    shared/academy.ts NZF_ETHNICITIES (Stats NZ level-1 classification).
--
-- 2. THE FRIENDLY MANAGER MIGRATION KEY.
--    `contacts.friendly_manager_id` + `registrations.legacy_source` /
--    `legacy_external_id` let tomorrow's FM database export be reconciled
--    against rows created by the new signup flow, so a family who registers
--    online tonight is not duplicated when the historical import lands.
--
-- 3. PROOF OF CONSENT AT THE MOMENT OF PAYMENT.
--    The club's Membership & Payment Policy 2026 and NZF's registration terms
--    are accepted per-registration. We record WHEN and WHICH VERSION, because
--    a tick-box with no version is not evidence.
--
-- `academy_section` already exists in the live DB (added by raw SQL in
-- server/seed.ts) but is absent from shared/schema.ts — this migration makes it
-- official and idempotent so the Drizzle mirror is finally honest. See
-- reference_clubos_prod_db_drift: NEVER db:push.
--
-- ADDITIVE ONLY — safe on the live Supabase DB. No enums, no CHECK constraints
-- on string columns, every new column nullable or defaulted. Run BEFORE the Fly
-- deploy:  npx tsx --env-file=.env script/apply-academy-registrations.ts
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. NZF-required identity fields on the player/guardian contact ───────────
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country_of_birth   text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS place_of_birth     text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity          text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sub_ethnicity      text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity2         text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS sub_ethnicity2     text;

-- Friendly Manager reconciliation key (populated by the historical import).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS friendly_manager_id text;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_friendly_manager_id_key
  ON contacts (friendly_manager_id)
  WHERE friendly_manager_id IS NOT NULL;

-- Dedupe key for "same child, next term". Without this, re-registering a child
-- creates a second contact row every term (the existing class-registration
-- endpoint always INSERTs the child). Partial + expression index: one child per
-- (guardian-less) identity triple. Guardian linkage stays in contact_relationships.
CREATE INDEX IF NOT EXISTS contacts_player_identity_idx
  ON contacts (lower(first_name), lower(last_name), date_of_birth)
  WHERE type = 'player' AND date_of_birth IS NOT NULL;

-- Guardian lookup is case-insensitive: emails have been stored with whatever
-- casing the parent typed, across years of different flows, so an exact match
-- silently forks a family into two contacts. NOT unique — the existing table
-- already contains duplicates (see the class-registration bug in ACADEMY.md);
-- a unique index here would fail to create.
CREATE INDEX IF NOT EXISTS contacts_lower_email_idx
  ON contacts (lower(email))
  WHERE email IS NOT NULL;

-- ── 2. Programme columns ────────────────────────────────────────────────────
-- 'core' (FUNiño / Pre-Academy / Academy) vs 'additional' (Technification,
-- Goalkeeper, Morning). Already present in prod; declared here for idempotency.
ALTER TABLE programs ADD COLUMN IF NOT EXISTS academy_section text;

-- The season a term-based academy programme belongs to. Age grades are derived
-- as (season_year - birth_year) — NZF classifies by year of birth, so a child
-- born 2017 is U9 for the 2026 season.
ALTER TABLE programs ADD COLUMN IF NOT EXISTS season_year integer;

-- Whether this programme is open for online self-registration. Distinct from
-- `is_active` (which controls public visibility): a programme can be listed and
-- described while registrations are closed.
ALTER TABLE programs ADD COLUMN IF NOT EXISTS registration_open boolean NOT NULL DEFAULT false;

-- ── 3. Registration: consent evidence + payment plan + legacy provenance ─────
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS policy_accepted_at timestamptz;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS policy_version     text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS nzf_consent_at     timestamptz;

-- 'term' (one term) | 'year' (all four terms up front — earns the policy's 5%
-- training-fee discount). Free text, validated in shared/academy.ts.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS academy_payment_plan text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS season_year          integer;

-- Where the row came from. NULL = born in ClubOS. 'friendly_manager' = imported.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS legacy_source      text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS legacy_external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS registrations_legacy_external_id_key
  ON registrations (legacy_source, legacy_external_id)
  WHERE legacy_external_id IS NOT NULL;

-- ── 4. Academy waitlist ─────────────────────────────────────────────────────
-- Programmes have a `capacity`. Today the class flow ignores it and would
-- happily oversell a session. When a programme is full we capture the family
-- instead of losing them. (leagueWaitlist exists but is MFL-team shaped.)
CREATE TABLE IF NOT EXISTS academy_waitlist (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   integer NOT NULL,
  program_id        integer NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  season_year       integer,
  child_first_name  text NOT NULL,
  child_last_name   text NOT NULL,
  child_dob         date,
  guardian_name     text NOT NULL,
  email             text NOT NULL,
  phone             text NOT NULL,
  notes             text,
  status            text NOT NULL DEFAULT 'waiting',  -- waiting | offered | converted | declined
  offered_at        timestamptz,
  converted_registration_id integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS academy_waitlist_program_idx ON academy_waitlist (program_id, status);
CREATE INDEX IF NOT EXISTS academy_waitlist_org_idx     ON academy_waitlist (organization_id, created_at);
-- One entry per child per programme.
CREATE UNIQUE INDEX IF NOT EXISTS academy_waitlist_child_key
  ON academy_waitlist (program_id, lower(email), lower(child_first_name), lower(child_last_name));

-- Structured NZ Football identity + address fields on contacts.
--
-- Why this exists (28 July 2026, two days before Mainland's membership snapshot):
--   Sporty refused our 495-member import outright: "Of 495 people, 448 are
--   missing Ethnicity group, Nationality and Country of Birth. We are unable to
--   import data where required fields are missing." Our own UAT run said the
--   same thing from the other direction — only 8 of 116 real registrations
--   passed NZ Football's validation.
--
--   ClubOS was not blameless here. It DID ask for those fields, but as FREE
--   TEXT, so what came back was unusable: "Christchurch" as a country of birth,
--   "ニュージーランド" as another, dual values in nationality, an ethnicity typed
--   into the nationality box, and 68 bare "European" answers that NZ Football
--   cannot accept because their taxonomy splits NZ European from Other European.
--   A free-text box for a controlled vocabulary is a data-quality bug that only
--   shows up months later, at somebody else's validation gate.
--
--   The fix is upstream: the form now offers exactly the values NZ Football
--   publishes (shared/nzf-vocabulary.ts, generated from their own reference
--   endpoints), so an answer is valid at the moment a parent gives it. These
--   columns are where a structured answer can actually land.
--
-- ADDRESS:
--   contacts.address was a single free-text line. Sporty requires SIX separate
--   fields and — contradicting its own swagger, verified live — ALL of them are
--   mandatory, INCLUDING Region. A one-line address cannot be split back apart
--   reliably (a leading "1272 Courtenay Road" was being read as postcode 1272),
--   so the parts are captured as parts.
--
-- ADDITIVE AND IDEMPOTENT. Nothing is dropped, nothing is rewritten, and the
-- legacy `address` column stays exactly as it is — every existing read path,
-- export and report keeps working untouched. New columns are NULL for every
-- existing row, which is honest: we do not know these values, and inventing a
-- child's ethnicity or region to fill a column is precisely the failure this
-- migration exists to stop.

-- ── Structured address ──────────────────────────────────────────────────────

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_street   text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_suburb   text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_city     text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_region   text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_postcode text;
-- FIFA/IOC alpha-3 (NZL), not ISO 3166-1. Defaulted nowhere: a blank country is
-- a known gap, whereas a defaulted "NZL" is a guess that reads as a fact.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS address_country  text;

-- ── Identity codes alongside the existing names ─────────────────────────────
-- The name columns (nationality, country_of_birth, ethnicity, sub_ethnicity…)
-- already exist and keep holding the human-readable answer. These carry the
-- machine value NZ Football keys on, so the push never has to re-resolve a
-- string it already resolved once — and a later rename on their side cannot
-- silently re-point an existing registration at a different ethnicity.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nationality_code      text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country_of_birth_code text;

-- Ethnicity group ids (NZ European 1, Māori 2, Pacific Peoples 3, Asian 4,
-- Other 5, MELAA 6, Other European 7) and the specific selection ids beneath
-- them. Arrays because Māori takes up to 4 iwi and the others take up to 2.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity_group_id       integer;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity_selection_ids  integer[];
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity2_group_id      integer;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ethnicity2_selection_ids integer[];

-- Deliberately NO CHECK constraints on these. A stale CHECK against a
-- vocabulary NZ Football controls is how the MFL checkout started 500-ing;
-- validation lives in shared/nzf-identity.ts where it can be regenerated from
-- their live reference data instead of shipped in a migration.

-- ── Provenance ──────────────────────────────────────────────────────────────
-- Which vocabulary version an answer was captured against, so a future audit
-- can tell a value collected under today's list from one collected after NZF
-- next changes it. Also marks WHERE the answer came from: 'form' (the family
-- chose it), 'staff' (office entry), 'import' (a migration). Never inferred.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_captured_at     timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS identity_captured_source text;

-- Partial index for the backfill campaign: "who is still missing the fields NZ
-- Football requires". Partial so it stays small as the gap closes.
CREATE INDEX IF NOT EXISTS contacts_nzf_identity_incomplete_idx
  ON contacts (id)
  WHERE ethnicity_group_id IS NULL
     OR nationality_code IS NULL
     OR country_of_birth_code IS NULL;

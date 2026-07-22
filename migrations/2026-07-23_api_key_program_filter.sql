-- Programme-level scoping for API keys (2026-07-23)
--
-- Scopes gate WHAT kind of data a key reads; allowed_org_ids gates WHOSE
-- workspace. This adds the third axis: WHICH PROGRAMMES inside that workspace.
--
-- Driven by the holiday-camp/U4-U8 coordinator case: Zach runs those programmes
-- but the club's whole academy lives in the same CUFC workspace, so camps:read
-- and registrations:read handed him Pre-Academy, Academy and Technification
-- families too. No scope granularity could express "his programmes only".
--
-- Shape: {"types": ["holiday_camp"], "slugs": ["u4-u8"]}
--   a programme matches if its type is listed OR its slug is listed.
--
-- NULL = unrestricted. Every existing key stays NULL and is unaffected, so this
-- migration cannot change what any key already reads. Present-but-empty means
-- the key reads no programmes at all (the enforcement fails closed).
--
-- Additive and idempotent. Safe to run before the deploy — the column is inert
-- until the code that reads it ships.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS program_filter jsonb;

COMMENT ON COLUMN api_keys.program_filter IS
  'Programme allow-list for this key: {"types":[...],"slugs":[...]}, matched as type OR slug. NULL = all programmes. Empty = none.';

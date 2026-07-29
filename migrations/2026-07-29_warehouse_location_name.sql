-- ─────────────────────────────────────────────────────────────────────────────
-- Warehouse — a location gets a human name (D28).
--
-- Daniel asked for the first real location to be called "United Sports Centre
-- Warehouse". It could not be: `code` is the only text a location carries, and
-- a code must be a virtual code, a named zone, or 2–4 uppercase alphanumeric
-- segments (shared/warehouse.ts isValidLocationCode) — no spaces, because that
-- string is printed on a bin label and read back by a scanner.
--
-- So the code stays the identity and gains a name beside it:
--
--   code = 'USC-WAREHOUSE'   → scanned, printed, exported, joined on
--   name = 'United Sports Centre Warehouse'  → what a person sees in a picker
--
-- 🔴 NULLABLE, no default. Every one of the existing locations was created
-- without a name and must keep rendering its code — `locationLabel()` falls
-- back to it. A default here would invent a name for a bin nobody has named.
-- No CHECK constraint (a stale one is how the MFL checkout started 500-ing);
-- length and whitespace are normalised in shared/warehouse.ts on the way in.
--
-- 🔴 NOT unique. Two sites can each have a "Main Shed"; uniqueness lives on
-- `code`, which is what everything actually keys on.
--
-- ADDITIVE ONLY. No rows are written by this migration. Seeding the first
-- location is a separate, idempotent step (script/seed-warehouse-usc.ts).
--
-- Rehearse (rolls back), then apply:
--   npx tsx --env-file=.env script/apply-warehouse-location-name.ts
--   npx tsx --env-file=.env script/apply-warehouse-location-name.ts --apply
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE wh_locations ADD COLUMN IF NOT EXISTS name text;

COMMENT ON COLUMN wh_locations.name IS
  'Optional human name shown in pickers (e.g. United Sports Centre Warehouse). Display only — code remains the identity, and is what labels encode and scanners read.';

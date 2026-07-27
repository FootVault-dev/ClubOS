-- ─────────────────────────────────────────────────────────────────────────────
-- HIRING — per-membership brand scope.
--
-- The Hiring tab is deliberately ONE tab for every brand: a job row is owned by
-- an org (United Sports Group) and *advertised* under a public brand key —
-- cufc, mfl, cic. That is what lets one careers engine recruit for every brand.
--
-- The cost of that design was all-or-nothing access. Being granted the tab meant
-- seeing every brand's postings and every brand's applicants, so there was no
-- way to let the person who runs Mini Football and the CIC triage their own
-- referees without also handing them the club's Marketing Manager applications —
-- CVs, phone numbers and salary conversations for a role that reports above them.
--
-- This column is that missing scope, and it lives next to `tabs` because it is
-- the same kind of fact: what this person may see in this workspace.
--
--   NULL         every brand. This is what every existing membership means, and
--                the reason the column has no default and no backfill — applying
--                this migration must not narrow anyone's access by a single row.
--   ["mfl","cic"]  only those brands.
--   []           no brands. A real answer, not "unset": the tab opens empty
--                rather than silently opening full.
--
-- Enforcement is server-side on every admin hiring route (server/hiring-routes.ts).
-- The client filter is a courtesy; the API is the boundary.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE user_organizations
  ADD COLUMN IF NOT EXISTS hiring_brands jsonb;

COMMENT ON COLUMN user_organizations.hiring_brands IS
  'Hiring tab brand whitelist. NULL = all brands (default). [] = none. Enforced in server/hiring-routes.ts.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Global Search — enable fuzzy, typo-tolerant, case-insensitive matching across
-- ClubOS. pg_trgm powers the `%` similarity operator + similarity() ranking so a
-- search finds a record even when the query isn't spelled/cased exactly right.
--
-- GIN trigram indexes below accelerate both `col % q` and `col ILIKE '%q%'` on the
-- highest-volume / most-searched columns. Smaller tables are searched without a
-- dedicated index (a seq scan on a few hundred rows is instant).
--
-- ADDITIVE ONLY — safe on the live Supabase DB (an extension + IF NOT EXISTS
-- indexes; no table/column/row changes). Run BEFORE the Fly deploy. Regular (not
-- CONCURRENT) index builds — the apply script runs the file in one implicit
-- transaction, and these tables are small enough that the build is sub-second.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- People / CRM (the org-less shared pools — biggest tables)
CREATE INDEX IF NOT EXISTS trgm_contacts_first   ON contacts   USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_contacts_last    ON contacts   USING gin (last_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_contacts_email   ON contacts   USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_contacts_team    ON contacts   USING gin (team_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_children_first   ON children   USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_children_last    ON children   USING gin (last_name gin_trgm_ops);

-- Sponsorship
CREATE INDEX IF NOT EXISTS trgm_prospects_company ON sponsorship_prospects USING gin (company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_prospects_contact ON sponsorship_prospects USING gin (contact_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_deals_company     ON sponsorship_deals     USING gin (sponsor_company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_deals_title       ON sponsorship_deals     USING gin (title gin_trgm_ops);

-- Grants
CREATE INDEX IF NOT EXISTS trgm_grant_funders_name ON grant_funders      USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_grant_apps_title   ON grant_applications USING gin (project_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_grant_apps_funder  ON grant_applications USING gin (funder_name gin_trgm_ops);

-- e-Sign (referee contracts + agreements)
CREATE INDEX IF NOT EXISTS trgm_esign_docs_title  ON esign_documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_esign_signer_name ON esign_signers   USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_esign_signer_mail ON esign_signers   USING gin (email gin_trgm_ops);

-- Proposals
CREATE INDEX IF NOT EXISTS trgm_proposals_title   ON proposals USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_proposals_company ON proposals USING gin (company gin_trgm_ops);

-- Teams / clubs
CREATE INDEX IF NOT EXISTS trgm_league_teams_name ON league_teams     USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_tourn_teams_name  ON tournament_teams USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_clubs_name        ON clubs            USING gin (name gin_trgm_ops);

-- Members
CREATE INDEX IF NOT EXISTS trgm_members_name  ON members USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_members_email ON members USING gin (email gin_trgm_ops);

-- Print
CREATE INDEX IF NOT EXISTS trgm_print_orders_customer ON print_orders   USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_print_orders_company  ON print_orders   USING gin (customer_company gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_print_contacts_last   ON print_contacts USING gin (last_name gin_trgm_ops);

-- Inbox / enquiries
CREATE INDEX IF NOT EXISTS trgm_inbox_name  ON inbox_messages USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_inbox_email ON inbox_messages USING gin (email gin_trgm_ops);

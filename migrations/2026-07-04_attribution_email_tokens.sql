-- AttributionOS — migration file 4: per-recipient email click tokens (T14).
-- Additive only (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- Safe to re-run. Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
-- A broadcast stamps each recipient's ours-domain links with `ci=emc…`, a signed
-- token stored here mapping token → recipient email + campaign. On click the cookie
-- middleware resolves the token back to the email and binds the visitor to that
-- person. The attribution person is always the PARENT/payer — email only, no child PII.

CREATE TABLE IF NOT EXISTS email_click_tokens (
  id              integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  token           varchar(64) NOT NULL,
  organization_id integer,
  campaign_id     integer,
  email           text NOT NULL,
  created_at      timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_click_tokens_token_key ON email_click_tokens (token);

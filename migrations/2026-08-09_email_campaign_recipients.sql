-- Per-recipient delivery + open tracking for the ClubOS mailers.
--
-- email_campaigns already holds the sent/failed COUNTERS. This adds the row-level
-- detail behind them: who each send actually went to, and whether that person
-- opened it. Additive — nothing existing changes shape, and a mailer that never
-- writes here keeps working exactly as it does today.
--
-- Deliberately shared rather than CUGC-specific: email_campaigns has no
-- organization_id (every mailer writes to it, told apart by a namespaced
-- segment_type), so the recipient detail belongs on the same spine.

CREATE TABLE IF NOT EXISTS email_campaign_recipients (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  campaign_id integer NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  email text NOT NULL,
  -- 'sent'  = Resend accepted the message for delivery
  -- 'failed'= Resend rejected it after all retries
  -- NOTE: 'sent' is the honest ceiling of what we know. There is no delivery
  -- webhook wired up, so we must never label this "delivered to the inbox".
  status text NOT NULL DEFAULT 'sent',
  sent_at timestamptz NOT NULL DEFAULT now(),
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0
);

-- One row per person per campaign. Lower(email) so a re-send to "A@x.com"
-- can't create a second row alongside "a@x.com".
CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_recipients_campaign_email_uq
  ON email_campaign_recipients (campaign_id, lower(email));

CREATE INDEX IF NOT EXISTS email_campaign_recipients_campaign_idx
  ON email_campaign_recipients (campaign_id);

-- New tables default to RLS OFF and the Supabase anon key is public by design,
-- so this is the second wall behind a leaked key. The app connects as postgres /
-- service-role (rolbypassrls) and is unaffected. See reference_supabase_rls_hardening.
ALTER TABLE email_campaign_recipients ENABLE ROW LEVEL SECURITY;

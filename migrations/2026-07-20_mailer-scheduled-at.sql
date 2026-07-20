-- Additive: scheduled sends for the mailer.
-- email_campaigns.scheduled_at — when set with status 'scheduled', the
-- mailer-schedule worker dispatches the send at/after this time. Null = send now.
-- Idempotent + additive only (prod-DB-drift rule). Safe before OR after deploy:
-- the old app simply ignores the column.
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS scheduled_at timestamp;

-- Helps the worker find due campaigns without a full scan.
CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduled
  ON email_campaigns (scheduled_at)
  WHERE status = 'scheduled';

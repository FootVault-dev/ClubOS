-- ═══════════════════════════════════════════════════════════════════════════
-- Marketing Suite ("MarketingOS") — Phase B additive migration.
--
-- Phase B (send engine + Resend event pipeline) needs three small ADDITIVE
-- changes on top of the Phase A foundation (2026-07-09_marketing_suite.sql).
-- All IF-NOT-EXISTS / nullable — safe to run repeatedly, never destructive.
-- Apply BEFORE deploy (ClubOS rule: migrate-before-deploy, never db:push).
--
-- NOTE: graphile-worker (the durable job runner) creates and migrates its OWN
-- `graphile_worker` schema automatically on server start — it is NOT in this
-- file. This migration only covers the mkt_* tables.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Campaign orchestrator idempotency — a re-run of the `campaign:send` job
--    re-inserts the same (campaign_id, profile_id) message rows with
--    ON CONFLICT DO NOTHING, so a recipient is never double-mailed. NULLS
--    DISTINCT (Postgres default) means flow messages (campaign_id NULL) never
--    collide with each other, so this never blocks the flow send path.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_email_messages_campaign_profile_unq
  ON mkt_email_messages (campaign_id, profile_id);

-- 2. Compiled, ready-to-send email HTML on the campaign. The Tiptap block tree
--    lives on the linked template (block_tree); Phase D's serializer will
--    populate this. Until then the send engine reads body_html directly so the
--    pipeline is end-to-end functional today.
ALTER TABLE mkt_campaigns
  ADD COLUMN IF NOT EXISTS body_html text;

-- 3. Suppression expiry — powers the preference-centre "pause 30 days". A NULL
--    expiry = permanent; a future expiry is ignored by the send gate once it has
--    passed, so the profile silently resumes without a cron un-suppress.
ALTER TABLE mkt_suppressions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

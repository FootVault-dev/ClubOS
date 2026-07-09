-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing Suite ("MarketingOS") — Phase A foundation.
--
-- The in-house email + SMS marketing engine that replaces both Klaviyo accounts.
-- Everything here is the DATA FOUNDATION: the canonical marketing identity
-- (mkt_profiles), the two-axis consent model (mkt_consent), the 4-scope
-- suppression list (mkt_suppressions), the append-only event stream
-- (mkt_events/mkt_metrics), plus the lists/segments/templates/campaigns/flows/
-- email-event/SMS tables the later phases build on.
--
-- Spec: outputs/deep-research/2026-07-09-clubos-marketing-suite/synthesis.md §(a)
-- Plan: plans/2026-07-09-clubos-marketing-suite.md (Phase A). Mirrors the Drizzle
-- definitions appended to shared/schema.ts exactly.
--
-- ADDITIVE ONLY — new tables/types/indexes, no drops, no changes to existing
-- tables. Idempotent (safe to re-run): CREATE TYPE guarded by a DO/EXCEPTION
-- block; every table/index uses IF NOT EXISTS. Run BEFORE the Fly deploy
-- (migrate-before-deploy; never db:push). Apply with:
--   npx tsx --env-file=.env script/apply-marketing-schema.ts
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enums (closed vocab only) ────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE mkt_channel AS ENUM ('email', 'sms'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_sub_state AS ENUM ('subscribed', 'unsubscribed', 'never'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_legal_basis AS ENUM ('express', 'inferred', 'deemed', 'none', 'opted_out'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_suppression_scope AS ENUM ('global', 'brand', 'category', 'list'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_suppression_reason AS ENUM ('unsub_oneclick', 'unsub_prefs', 'complaint', 'hard_bounce', 'manual', 'invalid'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_email_stream AS ENUM ('marketing', 'transactional'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_sms_encoding AS ENUM ('gsm7', 'ucs2'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE mkt_flow_trigger_type AS ENUM ('event', 'list', 'segment', 'date_property'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── mkt_profiles — canonical marketing identity ──────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_profiles (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  integer NOT NULL,
  email         text,
  phone_e164    text,
  external_id   text,
  first_name    text,
  last_name     text,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_event_at timestamptz,
  -- NO FK: the attribution `persons` spine does not exist in this branch.
  person_id     integer,
  contact_id    integer REFERENCES contacts(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_profiles_ws_email_unq ON mkt_profiles (workspace_id, lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mkt_profiles_ws_phone_unq ON mkt_profiles (workspace_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_profiles_ws_idx      ON mkt_profiles (workspace_id);
CREATE INDEX IF NOT EXISTS mkt_profiles_contact_idx ON mkt_profiles (contact_id);

-- ── mkt_consent — two orthogonal axes per channel ────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_consent (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id          integer NOT NULL REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  channel             mkt_channel NOT NULL,
  sub_state           mkt_sub_state NOT NULL DEFAULT 'never',
  legal_basis         mkt_legal_basis NOT NULL DEFAULT 'inferred',
  can_receive         boolean NOT NULL DEFAULT false,
  source              text,
  method_detail       text,
  double_optin        boolean NOT NULL DEFAULT false,
  privacy_notice_text text,
  consent_shown_text  text,
  consent_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_consent_profile_channel_unq ON mkt_consent (profile_id, channel);

-- ── mkt_suppressions — 4-scope superset (never leaks across brands) ──────────
CREATE TABLE IF NOT EXISTS mkt_suppressions (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text,
  phone_e164  text,
  channel     mkt_channel NOT NULL,
  scope       mkt_suppression_scope NOT NULL DEFAULT 'global',
  brand_key   text,
  category    text,
  list_id     integer,
  reason      mkt_suppression_reason NOT NULL DEFAULT 'manual',
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- NULLS NOT DISTINCT: dedupe rows whose nullable scope columns are null (an
-- email-only global suppression is a single logical row). Mirrors the
-- `unique(...).nullsNotDistinct()` constraint in shared/schema.ts.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_suppressions_scope_unq
  ON mkt_suppressions (email, phone_e164, channel, scope, brand_key, category, list_id) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS mkt_suppressions_email_idx ON mkt_suppressions (email, channel);
CREATE INDEX IF NOT EXISTS mkt_suppressions_phone_idx ON mkt_suppressions (phone_e164, channel);

-- ── mkt_metrics — event-type registry ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_metrics (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id integer NOT NULL,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_metrics_ws_name_unq ON mkt_metrics (workspace_id, name);

-- ── mkt_events — append-only keystone stream ─────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   integer NOT NULL,
  profile_id     integer NOT NULL REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  metric_id      integer NOT NULL REFERENCES mkt_metrics(id) ON DELETE CASCADE,
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb,
  value          numeric(14, 2),
  value_currency text,
  unique_id      text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
-- NULLS DISTINCT (default): events with no unique_id always insert; events with
-- one are idempotent/deduped.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_events_dedupe_unq   ON mkt_events (profile_id, metric_id, unique_id);
CREATE INDEX IF NOT EXISTS mkt_events_ws_metric_idx       ON mkt_events (workspace_id, metric_id, occurred_at);
CREATE INDEX IF NOT EXISTS mkt_events_profile_idx         ON mkt_events (profile_id);

-- ── mkt_lists / mkt_list_members — static membership ─────────────────────────
CREATE TABLE IF NOT EXISTS mkt_lists (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id integer NOT NULL,
  name         text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_lists_ws_idx ON mkt_lists (workspace_id);

CREATE TABLE IF NOT EXISTS mkt_list_members (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_id    integer NOT NULL REFERENCES mkt_lists(id) ON DELETE CASCADE,
  profile_id integer NOT NULL REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  source     text,
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_list_members_list_profile_unq ON mkt_list_members (list_id, profile_id);
CREATE INDEX IF NOT EXISTS mkt_list_members_profile_idx            ON mkt_list_members (profile_id);

-- ── mkt_segments / mkt_segment_members — dynamic + materialised cache ────────
CREATE TABLE IF NOT EXISTS mkt_segments (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     integer NOT NULL,
  name             text NOT NULL,
  definition       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'active',
  member_count     integer NOT NULL DEFAULT 0,
  last_computed_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_segments_ws_idx ON mkt_segments (workspace_id);

CREATE TABLE IF NOT EXISTS mkt_segment_members (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  segment_id  integer NOT NULL REFERENCES mkt_segments(id) ON DELETE CASCADE,
  profile_id  integer NOT NULL REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_segment_members_seg_profile_unq ON mkt_segment_members (segment_id, profile_id);
CREATE INDEX IF NOT EXISTS mkt_segment_members_profile_idx           ON mkt_segment_members (profile_id);

-- ── mkt_templates — Tiptap block tree, never raw HTML ────────────────────────
CREATE TABLE IF NOT EXISTS mkt_templates (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id integer NOT NULL,
  name         text NOT NULL,
  channel      text NOT NULL DEFAULT 'email',
  kind         text NOT NULL DEFAULT 'template',
  subject      text,
  block_tree   jsonb,
  is_marketing boolean NOT NULL DEFAULT true,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_templates_ws_idx ON mkt_templates (workspace_id);

-- ── mkt_campaigns — one consolidated engine ──────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_campaigns (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    integer NOT NULL,
  name            text NOT NULL,
  channel         text NOT NULL DEFAULT 'email',
  subject         text,
  preheader       text,
  from_name       text,
  from_email      text,
  reply_to        text,
  template_id     integer REFERENCES mkt_templates(id) ON DELETE SET NULL,
  audience        jsonb NOT NULL DEFAULT '{}'::jsonb,
  smart_send      boolean NOT NULL DEFAULT true,
  utm             jsonb,
  is_marketing    boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'draft',
  scheduled_at    timestamptz,
  sent_at         timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  sent_count      integer NOT NULL DEFAULT 0,
  failed_count    integer NOT NULL DEFAULT 0,
  created_by      integer REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_campaigns_ws_status_idx ON mkt_campaigns (workspace_id, status);

-- ── mkt_flows / versions / enrollments / step_runs — automation engine ───────
CREATE TABLE IF NOT EXISTS mkt_flows (
  id                        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id              integer NOT NULL,
  brand_key                 text,
  name                      text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft',
  trigger_type              mkt_flow_trigger_type NOT NULL,
  trigger_config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_filter              jsonb,
  re_entry                  boolean NOT NULL DEFAULT false,
  quiet_hours               jsonb NOT NULL DEFAULT '{"start":"20:00","end":"08:00","tz":"Pacific/Auckland"}'::jsonb,
  smart_send_window_seconds integer,
  -- SOFT pointer (no FK) to sidestep the flows<->flow_versions circular dependency.
  live_version_id           integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_flows_ws_idx ON mkt_flows (workspace_id);

CREATE TABLE IF NOT EXISTS mkt_flow_versions (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id      integer NOT NULL REFERENCES mkt_flows(id) ON DELETE CASCADE,
  version_no   integer NOT NULL,
  graph        jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_flow_versions_flow_version_unq ON mkt_flow_versions (flow_id, version_no);

CREATE TABLE IF NOT EXISTS mkt_flow_enrollments (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_id          integer NOT NULL REFERENCES mkt_flows(id) ON DELETE CASCADE,
  flow_version_id  integer NOT NULL REFERENCES mkt_flow_versions(id) ON DELETE CASCADE,
  profile_id       integer NOT NULL REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'active',
  current_step_id  text,
  trigger_event    jsonb,
  entered_at       timestamptz NOT NULL DEFAULT now(),
  exited_at        timestamptz,
  exit_reason      text,
  next_run_job_key text
);
CREATE INDEX IF NOT EXISTS mkt_flow_enrollments_flow_status_idx ON mkt_flow_enrollments (flow_id, status);
CREATE INDEX IF NOT EXISTS mkt_flow_enrollments_profile_idx     ON mkt_flow_enrollments (profile_id);

CREATE TABLE IF NOT EXISTS mkt_flow_step_runs (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id   integer NOT NULL REFERENCES mkt_flow_enrollments(id) ON DELETE CASCADE,
  step_id         text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  channel         text,
  -- Polymorphic (email OR sms message id) — no FK.
  message_id      integer,
  idempotency_key text,
  scheduled_for   timestamptz,
  executed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_flow_step_runs_idem_unq       ON mkt_flow_step_runs (idempotency_key);
CREATE INDEX IF NOT EXISTS mkt_flow_step_runs_enrollment_idx        ON mkt_flow_step_runs (enrollment_id);

-- ── mkt_email_messages — one row per recipient per send ──────────────────────
CREATE TABLE IF NOT EXISTS mkt_email_messages (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key         text,
  workspace_id      integer,
  campaign_id       integer REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  flow_id           integer REFERENCES mkt_flows(id) ON DELETE SET NULL,
  profile_id        integer REFERENCES mkt_profiles(id) ON DELETE SET NULL,
  resend_email_id   text,
  stream            mkt_email_stream NOT NULL DEFAULT 'marketing',
  to_email          text,
  subject           text,
  status            text NOT NULL DEFAULT 'queued',
  scheduled_at      timestamptz,
  sent_at           timestamptz,
  delivered_at      timestamptz,
  bounced_at        timestamptz,
  complained_at     timestamptz,
  first_opened_at   timestamptz,
  first_clicked_at  timestamptz,
  open_count        integer NOT NULL DEFAULT 0,
  human_open_count  integer NOT NULL DEFAULT 0,
  click_count       integer NOT NULL DEFAULT 0,
  human_click_count integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_email_messages_resend_id_unq ON mkt_email_messages (resend_email_id) WHERE resend_email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_email_messages_campaign_idx        ON mkt_email_messages (campaign_id);
CREATE INDEX IF NOT EXISTS mkt_email_messages_flow_idx            ON mkt_email_messages (flow_id);
CREATE INDEX IF NOT EXISTS mkt_email_messages_profile_idx         ON mkt_email_messages (profile_id);

-- ── mkt_email_events — raw Resend stream, idempotent on svix_id ──────────────
CREATE TABLE IF NOT EXISTS mkt_email_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  svix_id         text,
  event_type      text NOT NULL,
  resend_email_id text,
  message_id      bigint REFERENCES mkt_email_messages(id) ON DELETE SET NULL,
  occurred_at     timestamptz,
  received_at     timestamptz NOT NULL DEFAULT now(),
  link_url        text,
  ip_address      text,
  user_agent      text,
  is_machine      boolean NOT NULL DEFAULT false,
  machine_reason  text,
  raw_payload     jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_email_events_svix_unq      ON mkt_email_events (svix_id) WHERE svix_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mkt_email_events_resend_id_idx        ON mkt_email_events (resend_email_id);
CREATE INDEX IF NOT EXISTS mkt_email_events_message_idx          ON mkt_email_events (message_id);

-- ── mkt_email_link_clicks ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_email_link_clicks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  bigint REFERENCES mkt_email_messages(id) ON DELETE CASCADE,
  campaign_id integer REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  profile_id  integer REFERENCES mkt_profiles(id) ON DELETE SET NULL,
  link_url    text,
  is_bot      boolean NOT NULL DEFAULT false,
  clicked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_email_link_clicks_campaign_idx ON mkt_email_link_clicks (campaign_id);
CREATE INDEX IF NOT EXISTS mkt_email_link_clicks_message_idx  ON mkt_email_link_clicks (message_id);

-- ── mkt_conversions — materialised AND recomputable ──────────────────────────
CREATE TABLE IF NOT EXISTS mkt_conversions (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id          integer REFERENCES mkt_profiles(id) ON DELETE CASCADE,
  message_id          bigint REFERENCES mkt_email_messages(id) ON DELETE SET NULL,
  campaign_id         integer REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  conversion_type     text,
  revenue_cents       integer,
  currency            text NOT NULL DEFAULT 'NZD',
  attributed_click_at timestamptz,
  converted_at        timestamptz NOT NULL DEFAULT now(),
  window_days         integer NOT NULL DEFAULT 3,
  model               text NOT NULL DEFAULT 'last_touch_click'
);
CREATE INDEX IF NOT EXISTS mkt_conversions_profile_idx  ON mkt_conversions (profile_id);
CREATE INDEX IF NOT EXISTS mkt_conversions_campaign_idx ON mkt_conversions (campaign_id);

-- ── mkt_sms_messages / mkt_sms_inbound ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS mkt_sms_messages (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  profile_id          integer REFERENCES mkt_profiles(id) ON DELETE SET NULL,
  phone_e164          text NOT NULL,
  campaign_id         integer REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  body                text NOT NULL,
  encoding            mkt_sms_encoding NOT NULL DEFAULT 'gsm7',
  segments            integer,
  cost_cents          integer,
  provider            text,
  provider_message_id text,
  sender_id           text,
  status              text NOT NULL DEFAULT 'queued',
  is_marketing        boolean NOT NULL DEFAULT true,
  queued_for          timestamptz,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_sms_messages_profile_idx  ON mkt_sms_messages (profile_id);
CREATE INDEX IF NOT EXISTS mkt_sms_messages_campaign_idx ON mkt_sms_messages (campaign_id);

CREATE TABLE IF NOT EXISTS mkt_sms_inbound (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone_e164          text NOT NULL,
  body                text,
  matched_keyword     text,
  provider_message_id text,
  received_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_sms_inbound_phone_idx ON mkt_sms_inbound (phone_e164);

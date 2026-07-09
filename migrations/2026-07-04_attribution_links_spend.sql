-- AttributionOS — migration file 2: short links / QR, Meta ad spend + entities,
-- and attribution columns on every conversion/lead table.
-- Additive only (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- CREATE INDEX IF NOT EXISTS). Safe to re-run. Run on Supabase prod BEFORE the
-- Fly deploy. DO NOT db:push.
--
-- The attribution "person" is always the PARENT/payer — never a child.

-- ── short_links ──────────────────────────────────────────────────────────────
-- One row per trackable short link / QR poster (Dub-style). `key` is the public
-- slug served at /l/:key. `destination` is validated to an allowlisted (our-own)
-- host at create time — no open redirect. Counters are cached and repairable
-- from link_clicks + the conversion tables (see T21 repair function).
CREATE TABLE IF NOT EXISTS short_links (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key text NOT NULL,                          -- public slug (unique) → /l/:key
  destination text NOT NULL,                  -- allowlisted target URL (our domains only)
  channel text,                               -- canonical channel locked at create time
  campaign text,
  medium text,
  content text,
  brand text,                                 -- which brand this link is for
  note text,                                  -- free-text staff note
  qr_default boolean NOT NULL DEFAULT false,  -- link built primarily for a QR poster
  clicks integer NOT NULL DEFAULT 0,          -- cached counter (repairable from link_clicks)
  leads integer NOT NULL DEFAULT 0,
  sales integer NOT NULL DEFAULT 0,
  sale_amount_cents integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by integer REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS short_links_key_unq ON short_links (key);
CREATE INDEX IF NOT EXISTS short_links_org_idx
  ON short_links (organization_id, active, created_at DESC);

-- ── link_clicks ──────────────────────────────────────────────────────────────
-- One row per counted click on a short link. `click_id` is the minted first-party
-- id echoed to the destination as ?ci= and unique per click. `ip_hash` is
-- SHA256(ip+ua) only — no raw IP is ever stored; it is the 1h per-link dedupe key.
CREATE TABLE IF NOT EXISTS link_clicks (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  link_id integer NOT NULL REFERENCES short_links(id) ON DELETE CASCADE,
  click_id text NOT NULL,                     -- minted first-party click id (unique; ?ci=)
  visitor_id text,
  ip_hash text,                               -- SHA256(ip+ua) — no raw IP; 1h dedupe key
  ua text,
  referrer text,
  is_qr boolean NOT NULL DEFAULT false,       -- scanned from a QR poster (?qr=1)
  is_bot boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS link_clicks_click_id_unq ON link_clicks (click_id);
CREATE INDEX IF NOT EXISTS link_clicks_link_idx ON link_clicks (link_id, created_at DESC);

-- ── ad_spend_daily ───────────────────────────────────────────────────────────
-- Daily Meta Insights at level=ad, broken down by publisher_platform +
-- platform_position (so FB vs IG spend is separable). Re-upserted for the last
-- 7 days each run — the unique key is (date, ad_id, publisher_platform,
-- platform_position). Breakdown columns default to '' so the unique key never
-- has a NULL (NULLs are distinct in a unique index and would defeat the upsert).
-- spend_cents is integer cents (Meta returns spend as decimal dollars — convert).
CREATE TABLE IF NOT EXISTS ad_spend_daily (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  date date NOT NULL,
  ad_id text NOT NULL,
  adset_id text,
  campaign_id text,
  publisher_platform text NOT NULL DEFAULT '',  -- 'facebook' | 'instagram' | 'audience_network' | 'messenger'
  platform_position text NOT NULL DEFAULT '',   -- 'feed' | 'story' | 'reels' | ...
  spend_cents integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  refreshed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ad_spend_daily_unq
  ON ad_spend_daily (date, ad_id, publisher_platform, platform_position);

-- ── ad_entities ──────────────────────────────────────────────────────────────
-- Name lookup for ad / adset / campaign ids seen in spend or conversions.
-- Refreshed from /{ad-id}?fields=name,adset{name,campaign{name}}.
CREATE TABLE IF NOT EXISTS ad_entities (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  ad_id text NOT NULL,
  adset_id text,
  campaign_id text,
  ad_name text,
  adset_name text,
  campaign_name text,
  account_id text,
  refreshed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ad_entities_ad_id_unq ON ad_entities (ad_id);

-- ── attribution columns on the conversion / lead tables ──────────────────────
-- Discrete, joinable columns (visitor/click/person + the Meta ad ids + the
-- classified channel) stamped at conversion time. `hdyhau` is the self-reported
-- "how did you hear about us" answer. Two tables already carry an equivalent
-- self-reported column (registrations.referral_source, cugc_registrations.heard_via)
-- so `hdyhau` is NOT added to those — reporting COALESCEs the existing column.
-- person_id is a plain integer (no FK) to match analytics_events.person_id.

-- registrations (camps / classes / MFL teams) — reuses referral_source for HDYHAU
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS attribution_channel text;

-- cugc_registrations — reuses heard_via for HDYHAU
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE cugc_registrations ADD COLUMN IF NOT EXISTS attribution_channel text;

-- cugc_free_sessions
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE cugc_free_sessions ADD COLUMN IF NOT EXISTS hdyhau text;

-- league_waitlist
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE league_waitlist ADD COLUMN IF NOT EXISTS hdyhau text;

-- cic7s_registrations
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE cic7s_registrations ADD COLUMN IF NOT EXISTS hdyhau text;

-- football_institute_applications
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE football_institute_applications ADD COLUMN IF NOT EXISTS hdyhau text;

-- print_orders
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE print_orders ADD COLUMN IF NOT EXISTS hdyhau text;

-- booking_requests
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS visitor_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS click_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS person_id integer;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS fbp text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS fbc text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS meta_ad_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS meta_adset_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS meta_campaign_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS meta_platform text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS attribution_channel text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS hdyhau text;

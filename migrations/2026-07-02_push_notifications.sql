-- Push notifications for the CIC Youth mobile app (Expo push service).
-- ADDITIVE ONLY — safe to run on the live Supabase DB. Run this BEFORE the Fly
-- deploy that ships the new endpoints (per the prod-DB rule: never db:push --force).

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token          TEXT NOT NULL UNIQUE,             -- ExponentPushToken[...]
  app            TEXT NOT NULL DEFAULT 'cic-youth',
  platform       TEXT NOT NULL DEFAULT 'unknown',  -- 'ios' | 'android' | 'unknown'
  device_name    TEXT,
  disabled       BOOLEAN NOT NULL DEFAULT FALSE,   -- flipped when Expo reports DeviceNotRegistered
  failure_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_app_active
  ON device_push_tokens (app, disabled);

CREATE TABLE IF NOT EXISTS push_campaigns (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app              TEXT NOT NULL DEFAULT 'cic-youth',
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  data_json        TEXT,
  audience         TEXT NOT NULL DEFAULT 'all',
  recipient_count  INTEGER DEFAULT 0,
  sent_count       INTEGER DEFAULT 0,
  failed_count     INTEGER DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft',  -- 'draft' | 'sending' | 'sent'
  sent_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_campaigns_app
  ON push_campaigns (app, created_at DESC);

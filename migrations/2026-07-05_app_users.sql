-- Mobile app users (marketing email list) captured from the CIC Youth app.
-- ADDITIVE ONLY — run BEFORE the Fly deploy that ships the register endpoint.

CREATE TABLE IF NOT EXISTS app_users (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app              TEXT NOT NULL DEFAULT 'cic-youth',
  email            TEXT NOT NULL,
  name             TEXT,
  provider         TEXT NOT NULL DEFAULT 'email',
  category         TEXT,
  unsubscribed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per person per app per org (upsert target).
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_users_org_app_email
  ON app_users (organization_id, app, email);

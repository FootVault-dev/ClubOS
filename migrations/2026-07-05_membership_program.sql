-- Membership Program management (SIU workspace) — PLACEHOLDER scaffold.
-- Tiers (Bronze/Silver/Gold placeholders + dummy prices), members CRM, and a
-- deliverables/perks roadmap for fulfilment. No live payments wired yet — prices
-- and tiers are placeholders to brainstorm against.
-- ADDITIVE ONLY — safe on the live Supabase DB. Run BEFORE the Fly deploy.

CREATE TABLE IF NOT EXISTS membership_tiers (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,                    -- Bronze | Silver | Gold
  slug             TEXT NOT NULL,                    -- bronze | silver | gold
  tagline          TEXT,
  price_cents      INTEGER NOT NULL DEFAULT 0,       -- placeholder price
  billing_interval TEXT NOT NULL DEFAULT 'yearly',   -- monthly | yearly | lifetime
  color            TEXT,                             -- hex swatch
  benefits         JSONB NOT NULL DEFAULT '[]'::jsonb,-- string[] of perks
  active           BOOLEAN NOT NULL DEFAULT true,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_membership_tiers_org ON membership_tiers (organization_id, sort_order);

CREATE TABLE IF NOT EXISTS members (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  tier_id          INTEGER REFERENCES membership_tiers(id) ON DELETE SET NULL,
  tier_name        TEXT,                             -- denormalised so history survives
  status           TEXT NOT NULL DEFAULT 'active',   -- active | pending | lapsed | cancelled
  billing_interval TEXT,                             -- monthly | yearly | lifetime
  price_cents      INTEGER,                          -- what they pay (snapshot)
  payment_status   TEXT NOT NULL DEFAULT 'unpaid',   -- paid | unpaid | comped
  joined_at        DATE,
  renews_at        DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_members_org ON members (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS membership_deliverables (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  tiers            JSONB NOT NULL DEFAULT '[]'::jsonb,-- string[] of tier slugs it applies to
  cadence          TEXT,                             -- one_off | monthly | quarterly | annual | on_signup | birthday
  status           TEXT NOT NULL DEFAULT 'idea',      -- idea | planned | active | fulfilled
  owner            TEXT,
  notes            TEXT,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_membership_deliverables_org ON membership_deliverables (organization_id, sort_order);

-- USG Studio — Phase 1 data foundation
-- ADDITIVE ONLY — safe on the live Supabase DB. Run BEFORE the Fly deploy.
--
-- The data spine for "USG Studio": brand-aware, AI-generated proposal pages with
-- their own view analytics ("Signal" layer). This increment is data only —
-- no routes, services, or UI (those land in later increments).
--
--   • org_brand_context     — the "Brand Pack" as data (one row per brand org):
--                             voice, messaging, lexicon, banned terms, CTA rules,
--                             theme ref, and how the brand maps to live ClubOS data.
--                             Replaces the hardcoded voice strings in server/ai.ts.
--   • studio_documents      — a generated artifact (the proposal page). token = the
--                             unguessable public share link (same mechanic as
--                             esign_signers.token). content_json = the validated
--                             { meta, blocks[] } page doc (see shared/studio-blocks.ts).
--   • studio_document_versions — immutable snapshot per publish/edit (rollback +
--                             don't-clobber concurrent edits). Unique per (doc, versionInt).
--   • studio_analytics_sessions — one row per viewing session of a proposal.
--                             Engaged (active) time, scroll depth, coarse geo only
--                             (NO raw IP). Internal/preview views flagged out.
--   • studio_analytics_events  — granular events within a session (section dwell,
--                             scroll velocity, CTA clicks, heartbeats).
--
-- No new enums / no CHECK constraints on the string-status columns (validated in the
-- app + shared/studio-blocks.ts) to avoid prod enum-drift. All FKs cascade from the
-- owning org / document so a deleted org or doc cleans up after itself.

-- ── 1. org_brand_context — the Brand Pack, as data (one per brand org) ─────────
CREATE TABLE IF NOT EXISTS org_brand_context (
  id                   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id      INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  brand_id             TEXT NOT NULL,                         -- slug, e.g. 'mfl'
  voice_json           JSONB,                                 -- tone / adjectives / dials / sentence rules
  messaging_json       JSONB,                                 -- positioning, key messages, taglines, do-not-claim
  lexicon_json         JSONB,                                 -- approved / careful / banned terms → replacement
  banned_terms         JSONB NOT NULL DEFAULT '[]'::jsonb,    -- string[]
  cta_conventions_json JSONB,                                 -- how this brand phrases / routes CTAs
  theme_ref            TEXT,                                  -- points at the brand theme / token set
  data_bindings_json   JSONB,                                 -- reg URL patterns, current-term source, etc.
  version              TEXT NOT NULL DEFAULT 'v1.0.0',
  created_at           TIMESTAMP NOT NULL DEFAULT now(),
  updated_at           TIMESTAMP NOT NULL DEFAULT now()
);

-- ── 2. studio_documents — a generated proposal page ───────────────────────────
CREATE TABLE IF NOT EXISTS studio_documents (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,                    -- unguessable public share link (crypto.randomBytes → base64url)
  slug            TEXT,
  brand_id        TEXT NOT NULL,
  format          TEXT NOT NULL DEFAULT 'proposal',
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',           -- draft | published | archived
  content_json    JSONB NOT NULL,                          -- validated { meta, blocks[] } (shared/studio-blocks.ts)
  schema_version  INTEGER NOT NULL DEFAULT 1,
  content_hash    TEXT,
  source_tag      TEXT,                                    -- the ?source= attribution slug
  created_by      INTEGER NOT NULL,                        -- users.id of the staff creator
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now(),
  published_at    TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_studio_documents_org ON studio_documents (organization_id, status);

-- ── 3. studio_document_versions — immutable snapshot per publish / edit ────────
CREATE TABLE IF NOT EXISTS studio_document_versions (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
  version_int  INTEGER NOT NULL,
  content_json JSONB NOT NULL,
  edit_ops     JSONB,                                      -- what changed vs the prior version (optional)
  label        TEXT,
  created_by   INTEGER NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE studio_document_versions
    ADD CONSTRAINT studio_document_versions_doc_version_unique UNIQUE (document_id, version_int);
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_studio_document_versions_doc ON studio_document_versions (document_id, version_int);

-- ── 4. studio_analytics_sessions — one row per viewing session ────────────────
-- Privacy: coarse geo only. We never store a raw IP; `country` is derived (or a
-- salted hash) at ingest. `is_internal` flags staff / owner preview views so they
-- can be excluded from prospect analytics. `engaged_ms` = ACTIVE time, not tab-open.
CREATE TABLE IF NOT EXISTS studio_analytics_sessions (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id    INTEGER NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
  session_id     TEXT NOT NULL,                            -- client sessionStorage uuid
  visitor_id     TEXT,                                     -- persistent localStorage id (counts return visits)
  first_seen_at  TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMP NOT NULL DEFAULT now(),
  engaged_ms     INTEGER NOT NULL DEFAULT 0,               -- engaged / active time only
  max_scroll_pct INTEGER NOT NULL DEFAULT 0,
  device         TEXT,                                     -- mobile | tablet | desktop
  user_agent     TEXT,
  referrer       TEXT,
  source_tag     TEXT,
  utm_json       JSONB,
  country        TEXT,                                     -- coarse geo only — no raw IP stored
  is_internal    BOOLEAN NOT NULL DEFAULT false,           -- staff / owner preview — excluded from prospect analytics
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_analytics_sessions_doc ON studio_analytics_sessions (document_id);
CREATE INDEX IF NOT EXISTS idx_studio_analytics_sessions_doc_visitor ON studio_analytics_sessions (document_id, visitor_id);

-- ── 5. studio_analytics_events — granular events within a session ─────────────
CREATE TABLE IF NOT EXISTS studio_analytics_events (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     INTEGER NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  type            TEXT NOT NULL,                           -- pageview|section_enter|section_exit|scroll|click|cta_click|heartbeat|reached_end|visible|hidden
  block_id        TEXT,                                    -- which content block (section hotspots / dwell)
  scroll_pct      INTEGER,
  scroll_velocity INTEGER,                                 -- px/s — skim vs read
  dwell_ms        INTEGER,                                 -- time in a section on section_exit
  meta_json       JSONB,                                   -- click target / href, etc.
  client_ts       BIGINT,                                  -- client event time (epoch ms)
  created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_analytics_events_doc_session ON studio_analytics_events (document_id, session_id);
CREATE INDEX IF NOT EXISTS idx_studio_analytics_events_doc_type ON studio_analytics_events (document_id, type);

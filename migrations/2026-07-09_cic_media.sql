-- CIC Media Library — staff (Max) upload photos/videos, organise by team +
-- custom categories ("like our Google Drive"), and it feeds a public catalog
-- API a storefront will read later. Greenfield module, no prior media/gallery
-- tables. Generic multi-brand shape (organization_id everywhere); CIC (org 5)
-- first. Additive only. Run on Supabase prod BEFORE the Fly deploy.
--
-- Storage: originals are PRIVATE (Supabase bucket "clubos-media"); once
-- published, a watermarked preview + thumb are generated into the PUBLIC
-- bucket "clubos-media-previews". See script/setup-cic-media-storage.ts for
-- bucket creation (NOT run as part of this migration).

-- Custom buckets Max defines to sort content beyond just team (e.g. "Match
-- Action", "Team Photos", "Portraits").
CREATE TABLE IF NOT EXISTS media_categories (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_categories_org_slug_unique ON media_categories (organization_id, slug);

-- A shoot/collection — usually one per team per day, but can be a custom
-- grouping too. age_group/club_name are denormalised snapshots from the
-- source team so the gallery still reads sensibly if the team is later
-- renamed or removed. cover_asset_id FK is added below, once media_assets
-- exists.
CREATE TABLE IF NOT EXISTS media_galleries (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tournament_id integer REFERENCES tournaments(id) ON DELETE SET NULL,
  team_id integer REFERENCES tournament_teams(id) ON DELETE SET NULL,
  age_group text,
  club_name text,
  title text NOT NULL,
  slug text NOT NULL,
  cover_asset_id integer,
  shoot_date date,
  status text NOT NULL DEFAULT 'draft',          -- 'draft' | 'published' | 'hidden'
  asset_count integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_galleries_org_slug_unique ON media_galleries (organization_id, slug);
CREATE INDEX IF NOT EXISTS media_galleries_org_status_idx ON media_galleries (organization_id, status, sort_order);
CREATE INDEX IF NOT EXISTS media_galleries_tournament_idx ON media_galleries (tournament_id);
CREATE INDEX IF NOT EXISTS media_galleries_team_idx ON media_galleries (team_id);

-- One row per uploaded file. kind='video' skips the sharp preview pipeline
-- (preview_key/thumb_key stay null — video thumbnails are a later phase).
-- bib_number is public-safe (storefront search-by-bib); player_name is
-- INTERNAL ONLY and must never be returned by the public catalog API.
CREATE TABLE IF NOT EXISTS media_assets (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  gallery_id integer REFERENCES media_galleries(id) ON DELETE SET NULL,
  category_id integer REFERENCES media_categories(id) ON DELETE SET NULL,
  team_id integer REFERENCES tournament_teams(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'photo',             -- 'photo' | 'video'
  storage_key text NOT NULL,                      -- PRIVATE original (clubos-media bucket)
  preview_key text,                                -- watermarked preview, PUBLIC (clubos-media-previews)
  thumb_key text,                                  -- small thumb, PUBLIC (clubos-media-previews)
  original_filename text,
  content_type text,
  size_bytes bigint,
  width integer,
  height integer,
  duration_sec integer,
  bib_number integer,
  player_name text,                                -- INTERNAL ONLY — never in the public API
  taken_at timestamptz,
  price_cents integer,
  status text NOT NULL DEFAULT 'draft',            -- 'draft' | 'published'
  sort_order integer NOT NULL DEFAULT 0,
  uploaded_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_org_gallery_status_idx ON media_assets (organization_id, gallery_id, status);
CREATE INDEX IF NOT EXISTS media_assets_gallery_bib_idx ON media_assets (gallery_id, bib_number);
CREATE INDEX IF NOT EXISTS media_assets_category_idx ON media_assets (category_id);
CREATE INDEX IF NOT EXISTS media_assets_team_idx ON media_assets (team_id);

-- Now that media_assets exists, wire the gallery's cover-photo FK. Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS, so guard the rerun with a DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_galleries_cover_asset_fk'
  ) THEN
    ALTER TABLE media_galleries
      ADD CONSTRAINT media_galleries_cover_asset_fk
      FOREIGN KEY (cover_asset_id) REFERENCES media_assets(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STAFF VIDEOS — the in-house Loom (2026-07-20). ADDITIVE ONLY.
--
-- Apply:  npx tsx --env-file=.env script/apply-staff-videos.ts --dry-run
--         (drop --dry-run to commit). Run BEFORE the Fly deploy.
-- Never `db:push` against prod — it drops drifted columns.
--
-- Three tables:
--   staff_videos          one row per recording/upload. `token` is the public
--                         share id (/v/{token}) — random, non-enumerable, the
--                         invoice-pages doctrine. `stream_uid` is the Cloudflare
--                         Stream asset; a TRIM swaps stream_uid in place (share
--                         links survive trims) and remembers prev_stream_uid.
--   staff_video_events    append-only view/play/milestone stream, keyed by an
--                         anonymous viewer cookie. Staff opens carry is_staff
--                         and are excluded from headline counts (house rule).
--   staff_video_comments  comments AND emoji reactions (emoji-only row = a
--                         reaction, optionally timestamped Loom-style).
--
-- No CHECK constraints on enum-ish columns (status/visibility/source) — the
-- app validates; a stale CHECK is how the MFL checkout once 500'd.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staff_videos (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id),
  created_by       INTEGER NOT NULL REFERENCES users(id),
  token            VARCHAR(24) NOT NULL,
  title            TEXT NOT NULL DEFAULT 'Untitled video',
  description      TEXT,
  stream_uid       VARCHAR(64),
  prev_stream_uid  VARCHAR(64),
  status           VARCHAR(20) NOT NULL DEFAULT 'uploading',   -- uploading | processing | ready | error
  source           VARCHAR(16) NOT NULL DEFAULT 'recording',   -- recording | upload | clip
  visibility       VARCHAR(16) NOT NULL DEFAULT 'link',        -- link | staff | private
  allow_download   BOOLEAN NOT NULL DEFAULT TRUE,
  allow_comments   BOOLEAN NOT NULL DEFAULT TRUE,
  duration_seconds DOUBLE PRECISION,
  width            INTEGER,
  height           INTEGER,
  size_bytes       BIGINT,
  thumbnail_url    TEXT,
  playback_hls_url TEXT,
  download_url     TEXT,
  captions_status  VARCHAR(20),                                -- NULL | inprogress | ready | error
  view_count       INTEGER NOT NULL DEFAULT 0,
  clipped_from_id  INTEGER REFERENCES staff_videos(id),
  deleted_at       TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_videos_token_key ON staff_videos (token);
CREATE INDEX IF NOT EXISTS staff_videos_org_idx   ON staff_videos (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS staff_videos_owner_idx ON staff_videos (created_by);

CREATE TABLE IF NOT EXISTS staff_video_events (
  id               SERIAL PRIMARY KEY,
  video_id         INTEGER NOT NULL REFERENCES staff_videos(id) ON DELETE CASCADE,
  kind             VARCHAR(16) NOT NULL,                       -- view | play | milestone
  viewer_key       VARCHAR(64),
  percent          INTEGER,
  position_seconds DOUBLE PRECISION,
  is_staff         BOOLEAN NOT NULL DEFAULT FALSE,
  device           VARCHAR(16),
  referrer         TEXT,
  user_agent       TEXT,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_video_events_video_idx  ON staff_video_events (video_id, kind, created_at);
CREATE INDEX IF NOT EXISTS staff_video_events_viewer_idx ON staff_video_events (video_id, viewer_key);

CREATE TABLE IF NOT EXISTS staff_video_comments (
  id             SERIAL PRIMARY KEY,
  video_id       INTEGER NOT NULL REFERENCES staff_videos(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id),
  author_name    VARCHAR(120),
  body           TEXT,
  emoji          VARCHAR(16),
  at_seconds     DOUBLE PRECISION,
  is_staff       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staff_video_comments_video_idx ON staff_video_comments (video_id, created_at);

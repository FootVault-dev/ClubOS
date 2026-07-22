-- ─────────────────────────────────────────────────────────────────────────────
-- Staff Chat — the in-house Slack (replaces the WhatsApp staff groups).
--
-- Additive-only, idempotent, NO enums, NO CHECK constraints (house doctrine:
-- enum/CHECK drift against the live Supabase DB has bitten before — values are
-- validated app-side in shared/staff-chat.ts). Run BEFORE the Fly deploy:
--   npx tsx --env-file=.env script/apply-staff-chat-schema.ts [--apply]
--
-- Distinct from chat_conversations / chat_messages (visitor live-chat widget).
-- Unread = per-membership pointer (last_read_at), never per-message receipts.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staff_channels (
  id              integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  kind            text NOT NULL DEFAULT 'channel',      -- 'channel' | 'dm'
  name            text,                                 -- channels only, normalized
  topic           text,
  is_private      boolean NOT NULL DEFAULT false,
  is_default      boolean NOT NULL DEFAULT false,       -- auto-join all active staff
  post_policy     text NOT NULL DEFAULT 'anyone',       -- 'anyone' | 'leadership'
  dm_key          text,                                 -- DMs: sorted ids "4:17:23"
  created_by      integer,
  archived_at     timestamp,
  last_message_at timestamp,
  created_at      timestamp NOT NULL DEFAULT now()
);

-- Same participants → same DM, forever (NULLs exempt, so channels don't clash).
CREATE UNIQUE INDEX IF NOT EXISTS staff_channels_dm_key_unq
  ON staff_channels (dm_key) WHERE dm_key IS NOT NULL;

-- One LIVE channel per name (archived names are reusable).
CREATE UNIQUE INDEX IF NOT EXISTS staff_channels_live_name_unq
  ON staff_channels (lower(name))
  WHERE kind = 'channel' AND archived_at IS NULL AND name IS NOT NULL;

CREATE INDEX IF NOT EXISTS staff_channels_kind_idx
  ON staff_channels (kind, last_message_at);

CREATE TABLE IF NOT EXISTS staff_channel_members (
  id              integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id      integer NOT NULL REFERENCES staff_channels(id) ON DELETE CASCADE,
  user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member',       -- 'owner' | 'member'
  notify_level    text NOT NULL DEFAULT 'mentions',     -- 'all' | 'mentions' | 'muted'
  last_read_at    timestamp,                            -- THE unread pointer
  last_emailed_at timestamp,                            -- away-email debounce
  joined_at       timestamp NOT NULL DEFAULT now(),
  left_at         timestamp                             -- leave keeps the row
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_channel_members_unq
  ON staff_channel_members (channel_id, user_id);
CREATE INDEX IF NOT EXISTS staff_channel_members_user_idx
  ON staff_channel_members (user_id);

CREATE TABLE IF NOT EXISTS staff_messages (
  id                integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  channel_id        integer NOT NULL REFERENCES staff_channels(id) ON DELETE CASCADE,
  author_id         integer NOT NULL,
  body              text NOT NULL DEFAULT '',
  attachments       jsonb,                              -- StaffChatAttachment[]
  client_message_id text,                               -- idempotent retry-safe sends
  requires_ack      boolean NOT NULL DEFAULT false,
  edited_at         timestamp,
  deleted_at        timestamp,                          -- soft delete, body blanked
  created_at        timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_messages_channel_idx
  ON staff_messages (channel_id, id);

-- Retry-safe sends: the same client_message_id from the same author in the same
-- channel is ONE message no matter how many times the request is retried.
CREATE UNIQUE INDEX IF NOT EXISTS staff_messages_client_unq
  ON staff_messages (channel_id, author_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

-- Full-text search over message bodies (Postgres FTS — Zulip runs this at far
-- greater scale; no external search engine).
CREATE INDEX IF NOT EXISTS staff_messages_fts_idx
  ON staff_messages USING gin (to_tsvector('english', body));

CREATE TABLE IF NOT EXISTS staff_message_mentions (
  id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id integer NOT NULL REFERENCES staff_messages(id) ON DELETE CASCADE,
  channel_id integer NOT NULL,
  user_id    integer NOT NULL,
  kind       text NOT NULL DEFAULT 'user',              -- 'user' | 'channel'
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_message_mentions_unq
  ON staff_message_mentions (message_id, user_id);
CREATE INDEX IF NOT EXISTS staff_message_mentions_user_idx
  ON staff_message_mentions (user_id, channel_id, created_at);

CREATE TABLE IF NOT EXISTS staff_message_reactions (
  id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id integer NOT NULL REFERENCES staff_messages(id) ON DELETE CASCADE,
  user_id    integer NOT NULL,
  emoji      text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_message_reactions_unq
  ON staff_message_reactions (message_id, user_id, emoji);
CREATE INDEX IF NOT EXISTS staff_message_reactions_msg_idx
  ON staff_message_reactions (message_id);

CREATE TABLE IF NOT EXISTS staff_message_acks (
  id         integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id integer NOT NULL REFERENCES staff_messages(id) ON DELETE CASCADE,
  user_id    integer NOT NULL,
  acked_at   timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_message_acks_unq
  ON staff_message_acks (message_id, user_id);
CREATE INDEX IF NOT EXISTS staff_message_acks_msg_idx
  ON staff_message_acks (message_id);

-- One heartbeat row per user (server-side away-detection ONLY — no green dots).
CREATE TABLE IF NOT EXISTS staff_chat_presence (
  user_id      integer PRIMARY KEY,
  last_seen_at timestamp NOT NULL DEFAULT now()
);

-- Seed the two default channels every staff member lands in. Idempotent via the
-- live-name unique index. #announcements is leadership-post-only + default;
-- #general is open. No other channels are invented — Daniel creates the rest.
INSERT INTO staff_channels (kind, name, topic, is_default, post_policy)
SELECT 'channel', 'announcements', 'Club-wide announcements — leadership posts, everyone reads', true, 'leadership'
WHERE NOT EXISTS (
  SELECT 1 FROM staff_channels
  WHERE kind = 'channel' AND archived_at IS NULL AND lower(name) = 'announcements'
);

INSERT INTO staff_channels (kind, name, topic, is_default, post_policy)
SELECT 'channel', 'general', 'Anything and everything — the staff room', true, 'anyone'
WHERE NOT EXISTS (
  SELECT 1 FROM staff_channels
  WHERE kind = 'channel' AND archived_at IS NULL AND lower(name) = 'general'
);

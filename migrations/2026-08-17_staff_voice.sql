-- Staff Voice — calls, group calls, voice channels and meetings inside Staff Chat.
--
-- FOUR SURFACES, ONE ENGINE. A 1:1 call, a group call, an always-on voice
-- channel and a scheduled meeting differ only in how the room is created and
-- who gets rung. They are one table with a `mode`, not four features:
--
--   'direct'  — a DM channel. Both members are invited, and it rings.
--   'group'   — a channel. Selected members are invited, and it rings.
--   'channel' — a persistent voice room on a channel. Nobody is rung; people
--               drop in and out and the room exists only while occupied.
--   'meeting' — a titled, optionally scheduled room. May have no channel.
--
-- WHAT IS DERIVED, NEVER STORED (the rule this whole schema turns on):
--   * live?        → ended_at IS NULL. There is no is_live column.
--   * who is in it → participants WHERE left_at IS NULL. No counter column;
--                    a counter and the rows it counts drift the first time a
--                    phone dies mid-call.
--   * ringing?     → invited, not joined, not declined, and the call is younger
--                    than the ring timeout. No 'ringing' status column, because
--                    a status column has to be un-set by something and the thing
--                    that would un-set it is a phone that just went into a tunnel.
--   * missed       → invited, never joined, call now ended.
--   * duration     → started_at → ended_at.
--
-- WHAT BLANK MEANS:
--   participants.joined_at IS NULL   — invited, hasn't answered yet. NOT declined.
--   participants.declined_at IS NULL — hasn't declined. NOT the same as missed.
--   calls.ended_at IS NULL           — still live.
--   calls.channel_id IS NULL         — an ad-hoc meeting belonging to no channel.

-- ─────────────────────────────────────────────────────────────────────────────
-- The call
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_calls (
  id            serial PRIMARY KEY,
  -- 'direct' | 'group' | 'channel' | 'meeting'. Validated in the app, not a
  -- CHECK: a stale CHECK constraint is how the MFL checkout 500'd, and adding
  -- a fifth mode must never need a migration.
  mode          text NOT NULL DEFAULT 'direct',
  -- NULL only for an ad-hoc meeting. Cascade matches staff_messages: deleting a
  -- channel takes its call history with it.
  channel_id    integer REFERENCES staff_channels(id) ON DELETE CASCADE,
  -- The LiveKit room. SERVER-GENERATED AND UNGUESSABLE — a client that could
  -- name its own room could join a room it was never invited to, because the
  -- room name is the only thing the media server checks.
  room_name     text NOT NULL UNIQUE,
  title         text,
  -- RESTRICT, not CASCADE: deleting a staff account must never erase the record
  -- that a call happened. Same reasoning as served_by_user_id on payments.
  started_by    integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Retry-safe start. A double-tapped call button sends the same id twice and
  -- gets the same call back, instead of opening a second room and ringing
  -- everybody a second time.
  client_call_id text,
  scheduled_for timestamptz,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  -- Who or what ended it: 'host' | 'empty' | 'unanswered' | 'system'.
  ended_reason  text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 🔴 THE INVARIANT THAT MATTERS. Two people tapping call in the same DM at the
-- same second is not a rare edge case — it is what happens when a call drops and
-- both sides immediately redial. Without this, both win, two rooms open, and the
-- two of them sit in separate rooms listening to silence. Postgres decides, not
-- a check-then-insert in the app that a race walks straight through.
-- NULL channel_id (ad-hoc meetings) are distinct in Postgres, so unlimited
-- meetings can be live at once, which is correct.
CREATE UNIQUE INDEX IF NOT EXISTS staff_calls_one_live_per_channel
  ON staff_calls (channel_id) WHERE ended_at IS NULL;

-- The idempotency key is per starter, and only while the call is live: the same
-- person calling the same channel again tomorrow is a real second call.
CREATE UNIQUE INDEX IF NOT EXISTS staff_calls_client_id_unq
  ON staff_calls (started_by, client_call_id) WHERE client_call_id IS NOT NULL AND ended_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_calls_channel_idx ON staff_calls (channel_id, started_at DESC);
CREATE INDEX IF NOT EXISTS staff_calls_live_idx    ON staff_calls (started_at DESC) WHERE ended_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Who was invited, and what they did about it
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_call_participants (
  id          serial PRIMARY KEY,
  call_id     integer NOT NULL REFERENCES staff_calls(id) ON DELETE CASCADE,
  -- RESTRICT for the same reason as started_by: "who was on that call" is a
  -- question an employment dispute may ask a year later.
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Invited = we rang them. A person who walks into a voice channel uninvited
  -- is still a participant; they just have invited_at NULL and joined_at set.
  invited_at  timestamptz,
  joined_at   timestamptz,
  left_at     timestamptz,
  declined_at timestamptz,
  -- Set by the media server's webhook, never by the client. A phone that dies
  -- mid-call never sends "I left" — the server notices the media stop.
  left_reason text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per person per call. Rejoining after a dropout updates this row rather
-- than forking their history of the call.
CREATE UNIQUE INDEX IF NOT EXISTS staff_call_participants_unq
  ON staff_call_participants (call_id, user_id);
CREATE INDEX IF NOT EXISTS staff_call_participants_user_idx
  ON staff_call_participants (user_id, created_at DESC);
-- Powers "who is in this room right now" without a counter column.
CREATE INDEX IF NOT EXISTS staff_call_participants_live_idx
  ON staff_call_participants (call_id) WHERE joined_at IS NOT NULL AND left_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only event log
-- ─────────────────────────────────────────────────────────────────────────────
-- Voice fails in ways screenshots cannot capture: one person hears nothing, a
-- phone rings for four seconds and stops, a call ends by itself. Without a log
-- of what the server actually did, every one of those is unfalsifiable. Rows are
-- only ever inserted.
CREATE TABLE IF NOT EXISTS staff_call_events (
  id       serial PRIMARY KEY,
  call_id  integer NOT NULL REFERENCES staff_calls(id) ON DELETE CASCADE,
  -- NULL for events the server generated with nobody acting (room_finished).
  user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  -- 'created'|'invited'|'ringing'|'joined'|'left'|'declined'|'missed'|'ended'
  -- |'push_sent'|'push_failed'|'webhook'
  kind     text NOT NULL,
  detail   jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS staff_call_events_call_idx ON staff_call_events (call_id, at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Voice channels
-- ─────────────────────────────────────────────────────────────────────────────
-- An always-on voice room attached to a text channel. Opt-in per channel, off by
-- default: turning every channel into a voice room would put a "join voice"
-- button on #announcements.
ALTER TABLE staff_channels ADD COLUMN IF NOT EXISTS voice_enabled boolean NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────────
-- VoIP push tokens
-- ─────────────────────────────────────────────────────────────────────────────
-- 🔴 An iOS PushKit token is NOT the APNs token the device already registered —
-- it is a second, different token for the same device, and sending a VoIP push
-- to the ordinary token silently does nothing. One device, one row, two tokens.
-- Nullable because Android has no equivalent and every existing row predates it.
ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS voip_token text;

CREATE UNIQUE INDEX IF NOT EXISTS device_push_tokens_voip_unq
  ON device_push_tokens (voip_token) WHERE voip_token IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- New tables default to RLS OFF and a Supabase anon key is public by design.
-- These tables record who spoke to whom and when. The app connects as
-- postgres/service-role and bypasses RLS, so enabling it costs nothing here and
-- closes the leaked-key path. Run scripts/security/rls_guard.mjs after applying.
ALTER TABLE staff_calls              ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_call_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_call_events        ENABLE ROW LEVEL SECURITY;

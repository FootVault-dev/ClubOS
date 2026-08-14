-- Staff Chat v2 — threads, forwarding, and a searchable file/link index.
--
-- Requested by Daniel 2026-08-15 relaying Travis's feedback. Travis ran Kerkyra
-- United on Slack; threads, forwarding and a Files browser are how he works.
--
-- ⚠️ Threads reverse a documented v1 decision (shared/staff-chat.ts:7 and the
-- 2026-07-22 deep-research synthesis): Google Chat shipped topic-threading and
-- had to remove it because conversations vanished into side-rooms nobody read.
-- Daniel has overridden that deliberately. The failure mode is mitigated in the
-- application layer — a thread reply still appears in the channel — not here.

-- ── Threads ──────────────────────────────────────────────────────────────────
-- 🔴 ONE LEVEL ONLY. A reply may never itself be replied to; that is enforced in
-- the API (a parent that already has a parent is refused) rather than by a CHECK,
-- because the rule needs a lookup. Slack's own "thread of a thread" confusion is
-- what this avoids.
--
-- ON DELETE CASCADE: a thread has no meaning without its root message, and the
-- root is soft-deleted in normal use (body blanked, row kept), so a real cascade
-- only fires on a genuine hard delete.
ALTER TABLE staff_messages
  ADD COLUMN IF NOT EXISTS parent_message_id integer
    REFERENCES staff_messages(id) ON DELETE CASCADE;

-- The thread panel reads every reply to one root in order.
CREATE INDEX IF NOT EXISTS staff_messages_parent_idx
  ON staff_messages (parent_message_id, created_at)
  WHERE parent_message_id IS NOT NULL;

-- ── Forwarding ───────────────────────────────────────────────────────────────
-- A forward is a NEW message that points back at what it quoted, so the UI can
-- render provenance ("Forwarded from #ajax-camps · Travis, 8 Jul"). A forward
-- that looks like an original is how quotes get misattributed.
--
-- ON DELETE SET NULL, not CASCADE: deleting the original must never delete the
-- forward. The forward is somebody else's message in somebody else's channel.
ALTER TABLE staff_messages
  ADD COLUMN IF NOT EXISTS forwarded_from_message_id integer
    REFERENCES staff_messages(id) ON DELETE SET NULL;

-- ── Links ────────────────────────────────────────────────────────────────────
-- Extracted ON WRITE, never on read: scanning message bodies for URLs across a
-- growing history would not stay fast, and the Files/Links browser is meant to
-- be the quick way to find something somebody shared months ago.
CREATE TABLE IF NOT EXISTS staff_message_links (
  id          integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  message_id  integer NOT NULL REFERENCES staff_messages(id) ON DELETE CASCADE,
  channel_id  integer NOT NULL REFERENCES staff_channels(id) ON DELETE CASCADE,
  author_id   integer NOT NULL,
  url         text NOT NULL,
  host        text,
  created_at  timestamp NOT NULL DEFAULT now()
);

-- One row per distinct URL per message — pasting the same link twice in one
-- message should not fill the browser with duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS staff_message_links_unq
  ON staff_message_links (message_id, url);
CREATE INDEX IF NOT EXISTS staff_message_links_channel_idx
  ON staff_message_links (channel_id, created_at DESC);

-- The Files browser reads attachments straight off staff_messages — the data is
-- already there and duplicating it would create a second source of truth that
-- drifts. This partial index makes "every message with a file" cheap.
CREATE INDEX IF NOT EXISTS staff_messages_attachments_idx
  ON staff_messages (channel_id, created_at DESC)
  WHERE attachments IS NOT NULL;

-- New tables default to RLS OFF and a Supabase anon key is public by design.
-- Staff chat links name internal channels and people; the app connects as
-- postgres/service-role and bypasses RLS, so this costs nothing and closes the
-- leaked-key path. (See reference_supabase_rls_hardening.)
ALTER TABLE staff_message_links ENABLE ROW LEVEL SECURITY;

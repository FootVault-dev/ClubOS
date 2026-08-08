-- ─────────────────────────────────────────────────────────────────────────────
-- CHAT CHANNEL ICONS — an emoji or a custom image per channel.
--
-- Slack and WhatsApp both let a room carry its own mark, and it is the fastest
-- way to find a channel in a long list. Two nullable columns rather than one
-- polymorphic "icon" column, because they are genuinely different things: an
-- emoji renders as text at any size and costs nothing, an image is a URL into
-- object storage.
--
-- Doctrine:
--   * Both NULLABLE with no default. A channel with neither falls back to the
--     initial-letter mark the clients already draw — nothing needs backfilling
--     and no channel is forced to carry an invented icon.
--   * They are ALTERNATIVES, not a stack: setting one clears the other in the
--     API. Storing both would make "which wins?" a client-by-client decision,
--     which is how two surfaces end up disagreeing about the same channel.
--   * No CHECK on the emoji column. Emoji are ZWJ sequences, skin-tone
--     modifiers and regional-indicator pairs; any regex tight enough to be
--     meaningful will reject something real, and a stale CHECK is how the MFL
--     checkout 500'd. Validation is in the route, where it can return a useful
--     message.
--   * Additive only. No existing column is touched.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

ALTER TABLE staff_channels
  ADD COLUMN IF NOT EXISTS icon_emoji text,
  ADD COLUMN IF NOT EXISTS icon_url   text;

COMMIT;

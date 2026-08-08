-- ─────────────────────────────────────────────────────────────────────────────
-- NOTIFICATIONS — per-person preferences, and push tokens that know who owns them.
--
-- Two changes, one purpose: let ClubOS notify a PERSON rather than an audience.
--
-- 1. `notification_preferences` — one row per user. Every column is NOT NULL
--    with a default that matches shared/notifications.ts DEFAULT_PREFERENCES,
--    and a MISSING ROW IS VALID: it means "has never opened settings", and the
--    server answers with the same defaults. So there is no backfill, and a
--    staff member created tomorrow works immediately. Deleting a row is a
--    legitimate "reset to defaults".
--
-- 2. `device_push_tokens.user_id` — the gap that actually blocked staff push.
--    🔴 That table was built for ANONYMOUS CIC Youth fan broadcasts: a token, a
--    platform, a device name, and nothing identifying whose phone it is. You
--    cannot send "Zach was mentioned" to a table that cannot tell you which row
--    is Zach. The column is NULLABLE precisely because the CIC fan rows have no
--    user and never will — a NOT NULL here would require inventing an owner for
--    every existing fan device.
--
-- Doctrine followed (house rules):
--   * Additive only. No existing column is altered, dropped or re-defaulted —
--     the live CIC Youth broadcast path must behave identically after this.
--   * Vocabulary columns ('both'|'push'|'email'|'none') are validated TEXT in
--     shared/notifications.ts, NOT pg enums and NOT CHECK gates — a stale CHECK
--     is how the MFL checkout 500'd. Adding a delivery mode later must not need
--     a migration.
--   * Hours are plain integers 0–23 in NZ time, compared as calendar parts.
--     Never a timestamp, never round-tripped through a JS Date (midnight UTC is
--     the previous day in New Zealand).
--   * `last_daily_digest_at` / `last_weekly_digest_at` exist so the digest sweep
--     is idempotent — it runs every 15 minutes and must never send twice.
--   * RLS on both new/changed tables (rls_guard.mjs).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Master switches. Off here beats any per-event setting below.
  push_enabled         boolean NOT NULL DEFAULT true,
  email_enabled        boolean NOT NULL DEFAULT true,

  -- Per-event delivery: 'both' | 'push' | 'email' | 'none'.
  chat_dm              text    NOT NULL DEFAULT 'both',
  chat_mention         text    NOT NULL DEFAULT 'both',
  -- A channel the member set to "all" is high-volume by nature: push, never
  -- email, or one busy afternoon fills an inbox and they mute everything.
  chat_channel         text    NOT NULL DEFAULT 'push',
  task_assigned        text    NOT NULL DEFAULT 'both',
  -- A due date is not urgent enough to buzz a phone.
  task_due             text    NOT NULL DEFAULT 'email',

  -- Show the message text on the lock screen. Defaults ON (WhatsApp/Slack
  -- both do) but is a real choice: staff chat can carry a child's name or a
  -- parent's phone number, and a phone on a table shows it to whoever is there.
  show_preview         boolean NOT NULL DEFAULT true,

  -- Per-person quiet hours, defaulting to the club-wide 20:00–08:00 NZ that
  -- staff chat already enforced for everyone.
  quiet_hours_enabled  boolean NOT NULL DEFAULT true,
  quiet_hours_start    integer NOT NULL DEFAULT 20,
  quiet_hours_end      integer NOT NULL DEFAULT 8,

  -- Opt-in summaries. Off by default — an unasked-for recurring email is the
  -- fastest way to teach someone to ignore mail from us.
  daily_digest         boolean NOT NULL DEFAULT false,
  daily_digest_hour    integer NOT NULL DEFAULT 8,
  weekly_digest        boolean NOT NULL DEFAULT false,
  weekly_digest_day    integer NOT NULL DEFAULT 1,  -- ISO: 1 = Monday … 7 = Sunday
  weekly_digest_hour   integer NOT NULL DEFAULT 8,

  -- Idempotency for the digest sweep. Compared on the NZ calendar day.
  last_daily_digest_at  timestamptz,
  last_weekly_digest_at timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Shape guards only — deliberately NOT a vocabulary CHECK on the mode columns.
-- An hour outside 0–23 is a bug in any timezone; a new delivery mode is a
-- feature, and must never require a migration to ship.
ALTER TABLE notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_hours_ck;
ALTER TABLE notification_preferences
  ADD CONSTRAINT notification_preferences_hours_ck CHECK (
    quiet_hours_start  BETWEEN 0 AND 23 AND
    quiet_hours_end    BETWEEN 0 AND 23 AND
    daily_digest_hour  BETWEEN 0 AND 23 AND
    weekly_digest_hour BETWEEN 0 AND 23 AND
    weekly_digest_day  BETWEEN 1 AND 7
  );

-- ── Push tokens learn who they belong to ─────────────────────────────────────
-- NULL = an anonymous CIC Youth fan device (every existing row). Set = a signed
-- in staff member's phone. ON DELETE CASCADE: a deleted user's token is not
-- just useless, it must never be reachable by a later notification.
ALTER TABLE device_push_tokens
  ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id) ON DELETE CASCADE;

-- The staff-push hot path: "every live device belonging to these people".
CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx
  ON device_push_tokens (app, user_id)
  WHERE disabled = false;

-- ── Row level security ───────────────────────────────────────────────────────
-- The app connects as postgres/service-role (rolbypassrls), so this changes
-- nothing for ClubOS itself — it is the second wall that catches a leaked key.
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;

COMMIT;

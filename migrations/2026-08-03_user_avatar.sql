-- Staff profile picture.
--
-- Additive, nullable, NO default, no CHECK. Each of those is deliberate:
--   • nullable  — "hasn't set a photo" is a real state; the UI shows initials.
--   • no default — writing a placeholder path would be indistinguishable from
--     a person having actually chosen that picture.
--   • no CHECK  — the "must start with /objects/" rule is enforced in the
--     PATCH /api/auth/me handler, where a rejection can explain itself. A
--     CHECK constraint here would 500 a save with an opaque database error,
--     and a stale CHECK is exactly what took the MFL checkout down.
--
-- Safe to run before the code deploy: nothing reads this column until then.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;

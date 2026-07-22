-- CIC Referee Scoring — referees score their CIC games from their phones.
-- ADDITIVE ONLY. Run on Supabase prod BEFORE the Fly deploy. DO NOT db:push.
--
--   Rehearse:  npx tsx --env-file=.env script/apply-cic-referee-scoring.ts --dry-run
--   Apply:     npx tsx --env-file=.env script/apply-cic-referee-scoring.ts
--
-- Referees are a SEPARATE account type from ClubOS staff `users`. They must
-- never hold a staff session: many /api/admin/* routes carry no org check (e.g.
-- /api/admin/contacts returns the whole cross-club contacts DB to any logged-in
-- session), so a referee credential must only ever reach the CIC referee scoring
-- endpoints. Nothing here touches the users / user_organizations tables.

-- Referee accounts. Public signup writes a 'pending' row; a CIC staffer approves
-- it (status -> 'approved') before the account can log in. No enum/CHECK on
-- status — validated app-side in shared/referees.ts, same convention as hiring.
CREATE TABLE IF NOT EXISTS cic_referees (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  full_name        text NOT NULL,
  email            text NOT NULL,
  phone            text NOT NULL,
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'pending', -- pending | approved | suspended | declined
  approved_by      integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamp,
  last_login_at    timestamp,
  created_at       timestamp NOT NULL DEFAULT now()
);

-- One account per email within a workspace (CIC only today). Case-insensitive so
-- "Sam@x.com" and "sam@x.com" can't both sign up — a friendly 409 on the second.
CREATE UNIQUE INDEX IF NOT EXISTS cic_referees_org_email_unq
  ON cic_referees (organization_id, lower(email));
CREATE INDEX IF NOT EXISTS cic_referees_status_idx
  ON cic_referees (organization_id, status);

-- Which referee is (soft) assigned to which game — drives the ref's default
-- "My games" view. Any approved ref can still score any CIC game (flexibility as
-- fixtures shift); assignment is organisation + accountability, not a hard lock.
CREATE TABLE IF NOT EXISTS cic_referee_assignments (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  referee_id   integer NOT NULL REFERENCES cic_referees(id) ON DELETE CASCADE,
  game_id      integer NOT NULL REFERENCES tournament_games(id) ON DELETE CASCADE,
  assigned_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cic_referee_assignments_unq
  ON cic_referee_assignments (referee_id, game_id);
CREATE INDEX IF NOT EXISTS cic_referee_assignments_game_idx
  ON cic_referee_assignments (game_id);

-- Accountability: which referee last saved a score on each game, and when. Set
-- server-side on every referee write, so the office always knows who touched a
-- game. FK ON DELETE SET NULL — removing a referee must never erase the history
-- that a game was scored.
ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS last_scored_by_referee_id integer REFERENCES cic_referees(id) ON DELETE SET NULL;
ALTER TABLE tournament_games
  ADD COLUMN IF NOT EXISTS last_scored_at timestamp;

-- MFL Referee Scoring — clone of the CIC referee system (see
-- migrations/2026-07-11_cic_referee_scoring.sql + 2026-07-12_match_timer.sql)
-- for Mini Football Leagues. ADDITIVE ONLY. Run on Supabase prod BEFORE the
-- Fly deploy. DO NOT db:push.
--
--   Rehearse:  npx tsx --env-file=.env script/apply-mfl-referee.ts --dry-run
--   Apply:     npx tsx --env-file=.env script/apply-mfl-referee.ts
--
-- Referees are a SEPARATE account type from ClubOS staff `users` — and from
-- `league_game_referees` (a ClubOS user assigned as ref, used by the older
-- session-based /api/league/games/:id/score path). They must never hold a
-- staff session: many /api/admin/* routes carry no org check (e.g.
-- /api/admin/contacts returns the whole cross-club contacts DB to any logged-
-- in session), so a referee credential must only ever reach the MFL referee
-- scoring endpoints. Nothing here touches the users / user_organizations
-- tables.

-- Referee accounts. Public signup writes a 'pending' row; an MFL staffer
-- approves it (status -> 'approved') before the account can log in. No
-- enum/CHECK on status — validated app-side in shared/league-referees.ts.
CREATE TABLE IF NOT EXISTS league_referees (
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

-- One account per email within a workspace (MFL only today). Case-insensitive
-- so "Sam@x.com" and "sam@x.com" can't both sign up — a friendly 409 on the
-- second.
CREATE UNIQUE INDEX IF NOT EXISTS league_referees_org_email_unq
  ON league_referees (organization_id, lower(email));
CREATE INDEX IF NOT EXISTS league_referees_status_idx
  ON league_referees (organization_id, status);

-- Which referee is (soft) assigned to which game — drives the ref's default
-- "My games" view. Any approved ref can still score any MFL game (flexibility
-- as fixtures shift); assignment is organisation + accountability, not a hard
-- lock.
CREATE TABLE IF NOT EXISTS league_referee_assignments (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  referee_id   integer NOT NULL REFERENCES league_referees(id) ON DELETE CASCADE,
  game_id      integer NOT NULL REFERENCES league_games(id) ON DELETE CASCADE,
  assigned_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS league_referee_assignments_unq
  ON league_referee_assignments (referee_id, game_id);
CREATE INDEX IF NOT EXISTS league_referee_assignments_game_idx
  ON league_referee_assignments (game_id);

-- Goals — unlike CIC's tournament_goals, MFL has no player-roster table, so
-- the scorer is free text. team_id is the CREDITED team.
CREATE TABLE IF NOT EXISTS league_goals (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id      integer NOT NULL REFERENCES league_games(id) ON DELETE CASCADE,
  team_id      integer REFERENCES league_teams(id) ON DELETE SET NULL,
  player_name  text NOT NULL,
  minute       integer,
  is_own_goal  boolean NOT NULL DEFAULT false,
  is_penalty   boolean NOT NULL DEFAULT false,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS league_goals_game_idx ON league_goals (game_id);

-- Disciplinary cards — same free-text-player shape as league_goals.
CREATE TABLE IF NOT EXISTS league_cards (
  id           integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  game_id      integer NOT NULL REFERENCES league_games(id) ON DELETE CASCADE,
  team_id      integer REFERENCES league_teams(id) ON DELETE SET NULL,
  player_name  text NOT NULL,
  card_type    text NOT NULL, -- 'yellow' | 'red'
  minute       integer,
  created_at   timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS league_cards_game_idx ON league_cards (game_id);

-- Photos/highlights for an MFL competition — a staged gallery (unpublished
-- rows let an admin queue images before they go live).
CREATE TABLE IF NOT EXISTS league_media (
  id               integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id  integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competition_id   integer REFERENCES league_competitions(id) ON DELETE SET NULL,
  url              text NOT NULL,
  caption          text,
  taken_at         date,
  sort_order       integer NOT NULL DEFAULT 0,
  published        boolean NOT NULL DEFAULT true,
  created_at       timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS league_media_org_published_idx
  ON league_media (organization_id, published);

-- Accountability: which referee last saved a score on each game, and when. Set
-- server-side on every referee write, so the office always knows who touched
-- a game. FK ON DELETE SET NULL — removing a referee must never erase the
-- history that a game was scored.
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS last_scored_by_referee_id integer REFERENCES league_referees(id) ON DELETE SET NULL;
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS last_scored_at timestamp;

-- Live match timer state (Score Game) — the two-half clock the referee runs.
-- Phases: 'pre' -> 'first_half' -> 'half_time' -> 'second_half' -> 'finished'.
-- The live clock is DERIVED, never stored ticking (see
-- server/league-referee-routes.ts applyLeagueTimerAction). Leagues have no
-- brackets and no is_live column: status='in_progress' plays that role.
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS timer_phase text NOT NULL DEFAULT 'pre';
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS timer_running boolean NOT NULL DEFAULT false;
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS timer_started_at timestamp;
ALTER TABLE league_games
  ADD COLUMN IF NOT EXISTS timer_base_seconds integer NOT NULL DEFAULT 0;

-- Half length + break, per competition (tournaments' equivalent is
-- game_duration_minutes / break_between_minutes) — leagues run their own
-- match lengths.
ALTER TABLE league_competitions
  ADD COLUMN IF NOT EXISTS half_length_minutes integer NOT NULL DEFAULT 20;
ALTER TABLE league_competitions
  ADD COLUMN IF NOT EXISTS break_minutes integer NOT NULL DEFAULT 5;

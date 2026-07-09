-- ─────────────────────────────────────────────────────────────────────────────
-- Club squads — every team the club fields, and who is in it.
--
-- Christchurch United runs teams from U9 through to the First Team. Until now
-- ClubOS had no idea any of them existed: `league_teams` is MFL's (a captain
-- buys a slot in a social league), `tournament_teams` is CIC's (a visiting club
-- enters a tournament), and neither models "the club's own U14 side and the
-- eleven children in it".
--
-- This is the spine everything else hangs off:
--   • registrations already tell us a child paid for a PROGRAMME. A squad tells
--     us which TEAM they actually play for.
--   • roles (player / coach / manager) become the basis for permissions in the
--     app, and for who a coach is allowed to see.
--   • the NZF/Mainland registration sync needs `team` and `role` per registrant
--     (outputs/sporty-api-brief/BRIEF.md) — this supplies both.
--
-- Design notes:
--   • A squad member is a `contacts` row, not a new person table. Players and
--     coaches already live there; forking them would fork the club's database.
--   • `season_year` is on the squad, not the member — a squad IS a season's
--     team. "U14 2026" and "U14 2027" are different squads with different rosters.
--   • Roles are free TEXT, validated in the app (shared/squads.ts). This DB has
--     a history of enum drift, and the role list will grow (physio, analyst…).
--   • `left_at` retires a member without deleting the history. Nothing is ever
--     hard-deleted from a roster — a child who leaves mid-season still played.
--
-- ADDITIVE ONLY. Run BEFORE the Fly deploy:
--   npx tsx --env-file=.env script/apply-club-squads.ts
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS club_squads (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  integer NOT NULL,
  name             text NOT NULL,               -- "U14 Boys", "First Team", "NXT (U20)"
  slug             text,                        -- optional stable handle
  -- NZF age grade (season_year − birth_year). NULL for the First Team / seniors.
  age_grade        integer,
  season_year      integer NOT NULL,
  -- Where they play: "Southern League", "Mainland U14 Div 1", "Academy internal".
  competition      text,
  -- Free text so the club can order squads its own way (U9 → First Team).
  display_order    integer NOT NULL DEFAULT 0,
  -- 'youth' | 'academy' | 'senior' — a grouping for the UI, not a rule.
  band             text,
  notes            text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One squad of a given name per org per season. "U14 Boys 2026" cannot exist twice.
CREATE UNIQUE INDEX IF NOT EXISTS club_squads_org_season_name_key
  ON club_squads (organization_id, season_year, lower(name));
CREATE INDEX IF NOT EXISTS club_squads_org_season_idx
  ON club_squads (organization_id, season_year, display_order);

CREATE TABLE IF NOT EXISTS club_squad_members (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  squad_id     integer NOT NULL REFERENCES club_squads(id) ON DELETE CASCADE,
  -- The person. Players AND coaches are contacts; we do not fork the database.
  contact_id   integer NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- player | head_coach | assistant_coach | goalkeeper_coach | manager |
  -- physio | team_official   (validated in shared/squads.ts, not by a CHECK)
  role         text NOT NULL DEFAULT 'player',
  squad_number integer,
  position     text,                            -- GK | DF | MF | FW
  joined_at    date,
  -- Set when someone leaves. The row is NEVER deleted: a child who left in
  -- August still played until August, and the audit has to show it.
  left_at      date,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A person holds one role in a squad at a time. (A coach who also plays gets a
-- second row with a different role — hence role is in the key.)
CREATE UNIQUE INDEX IF NOT EXISTS club_squad_members_unique
  ON club_squad_members (squad_id, contact_id, role);
CREATE INDEX IF NOT EXISTS club_squad_members_squad_idx  ON club_squad_members (squad_id, role);
CREATE INDEX IF NOT EXISTS club_squad_members_contact_idx ON club_squad_members (contact_id);
-- Squad numbers are unique among ACTIVE players in a squad. Partial, so a
-- departed player's number frees up and NULL numbers never collide.
CREATE UNIQUE INDEX IF NOT EXISTS club_squad_members_number_key
  ON club_squad_members (squad_id, squad_number)
  WHERE squad_number IS NOT NULL AND left_at IS NULL AND role = 'player';

// Additive migration: Friendly Manager COMPETITIONS history (tournaments,
// social leagues, festivals 2021-2025). Sibling of apply-fm-history.ts.
// Org-segmented: CIC → 5, social leagues → 3 (MFL), festivals/other → 1 (CUFC).
// Usage:  npx tsx script/apply-fm-competitions.ts --dry-run | (apply)
import "dotenv/config";
import pg from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS fm_competition_history (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL,
  fm_comp_id integer NOT NULL,
  name text NOT NULL,
  start_date date,
  end_date date,
  season_year integer,
  segment text NOT NULL,
  source text NOT NULL DEFAULT 'friendly_manager',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_comp_hist_comp_unq ON fm_competition_history (fm_comp_id);

CREATE TABLE IF NOT EXISTS fm_competition_teams (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL,
  fm_comp_id integer NOT NULL,
  fm_division_id integer,
  division_name text,
  team_name text NOT NULL,
  club_name text,
  manager_name text,
  manager_phone text,
  manager_email text,
  num_players integer,
  source text NOT NULL DEFAULT 'friendly_manager',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_comp_teams_unq
  ON fm_competition_teams (fm_comp_id, (coalesce(fm_division_id, -1)), team_name);
CREATE INDEX IF NOT EXISTS fm_comp_teams_club_idx ON fm_competition_teams (club_name);

CREATE TABLE IF NOT EXISTS fm_competition_games (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL,
  fm_comp_id integer NOT NULL,
  fm_division_id integer,
  fm_round_id integer,
  pool text,
  game_date date,
  game_time text,
  venue text,
  home_team text,
  away_team text,
  home_score integer,
  away_score integer,
  status text NOT NULL DEFAULT 'unscored',
  external_key text NOT NULL,
  source text NOT NULL DEFAULT 'friendly_manager',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_comp_games_key_unq ON fm_competition_games (external_key);
CREATE INDEX IF NOT EXISTS fm_comp_games_comp_idx ON fm_competition_games (fm_comp_id);

CREATE TABLE IF NOT EXISTS fm_competition_placings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL,
  fm_comp_id integer NOT NULL,
  fm_division_id integer,
  place integer NOT NULL,
  team_name text NOT NULL,
  club_name text,
  source text NOT NULL DEFAULT 'friendly_manager',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_comp_placings_unq
  ON fm_competition_placings (fm_comp_id, (coalesce(fm_division_id, -1)), place, team_name);
`;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DDL);
    const check = await client.query(
      `select table_name, count(*) cols from information_schema.columns
       where table_name in ('fm_competition_history','fm_competition_teams','fm_competition_games','fm_competition_placings')
       group by 1 order by 1`
    );
    console.log("Tables in transaction:", JSON.stringify(check.rows));
    if (dryRun) { await client.query("ROLLBACK"); console.log("DRY RUN — rolled back."); }
    else { await client.query("COMMIT"); console.log("APPLIED."); }
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

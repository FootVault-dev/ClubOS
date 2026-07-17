// Additive migration: SportNinja history tables (source='sportninja').
// Mirrors the fm_*_history / mfl_customer_history doctrine — raw SQL, additive,
// never touches the live league_* system. Everything is source-tagged for
// one-statement reversal and unique-keyed for idempotent re-import.
//
// Usage:  npx tsx script/apply-sn-history.ts --dry-run   (rehearse inside a rolled-back txn)
//         npx tsx script/apply-sn-history.ts             (apply to the DB in DATABASE_URL)
import "dotenv/config";
import pg from "pg";

const DDL = `
-- Seasons / competitions (37) --------------------------------------------------
CREATE TABLE IF NOT EXISTS sn_seasons (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sn_schedule_id text NOT NULL UNIQUE,
  sn_org_id text,
  organization_name text,
  name text NOT NULL,
  starts_on date,
  ends_on date,
  is_archive boolean,
  is_tournament boolean,
  games_count integer,
  teams_count integer,
  source text NOT NULL DEFAULT 'sportninja',
  raw_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Teams (220 unique across seasons) --------------------------------------------
CREATE TABLE IF NOT EXISTS sn_teams (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sn_team_id text NOT NULL UNIQUE,
  name text NOT NULL,
  sn_org_id text,
  organization_name text,
  source text NOT NULL DEFAULT 'sportninja',
  raw_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Roster: player x team x season (1,785 spots ~ 950 people) ---------------------
CREATE TABLE IF NOT EXISTS sn_roster (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id integer REFERENCES contacts(id),
  sn_player_id text,
  first_name text,
  last_name text,
  email text,
  birth_date date,
  jersey_number text,
  position text,
  sn_team_id text,
  team_name text,
  sn_schedule_id text,
  competition_name text,
  organization_name text,
  source text NOT NULL DEFAULT 'sportninja',
  external_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sn_roster_contact_idx ON sn_roster (contact_id);
CREATE INDEX IF NOT EXISTS sn_roster_player_idx ON sn_roster (sn_player_id);
CREATE INDEX IF NOT EXISTS sn_roster_email_idx ON sn_roster (lower(email));

-- Games (1,112 fixtures, 985 with goal events) ---------------------------------
CREATE TABLE IF NOT EXISTS sn_games (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sn_game_id text NOT NULL UNIQUE,
  sn_schedule_id text,
  competition_name text,
  organization_name text,
  home_team text,
  visitor_team text,
  sn_home_team_id text,
  sn_visitor_team_id text,
  home_score integer,
  visitor_score integer,
  starts_at timestamptz,
  status text,
  venue text,
  goals_count integer,
  source text NOT NULL DEFAULT 'sportninja',
  raw_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sn_games_schedule_idx ON sn_games (sn_schedule_id);

-- Standings (309 final-table rows) ---------------------------------------------
CREATE TABLE IF NOT EXISTS sn_standings (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sn_schedule_id text,
  competition_name text,
  sn_team_id text,
  team_name text,
  rank integer,
  games_played integer,
  wins integer,
  draws integer,
  losses integer,
  goals_for integer,
  goals_against integer,
  goal_difference integer,
  points integer,
  source text NOT NULL DEFAULT 'sportninja',
  raw_json jsonb,
  external_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Registration payments (125 txns, $19,663, Mar-Jul 2026) ----------------------
CREATE TABLE IF NOT EXISTS sn_payments (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id integer REFERENCES contacts(id),
  competition_name text,
  team_name text,
  player_name text,
  player_email text,
  payment_type text,
  paid_on date,
  amount_cents integer,
  tax_cents integer,
  currency text DEFAULT 'NZD',
  payment_status text,
  provider text,
  provider_txn_id text,
  source text NOT NULL DEFAULT 'sportninja',
  external_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Registrations (team + player registration rows) ------------------------------
CREATE TABLE IF NOT EXISTS sn_registrations (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text,
  competition_name text,
  team_name text,
  registrant_name text,
  registrant_email text,
  registration_status text,
  contact_id integer REFERENCES contacts(id),
  source text NOT NULL DEFAULT 'sportninja',
  raw_json jsonb,
  external_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
      `select table_name, count(*) as cols from information_schema.columns
       where table_name in ('sn_seasons','sn_teams','sn_roster','sn_games','sn_standings',
                            'sn_payments','sn_registrations') group by 1 order by 1`
    );
    console.log("SportNinja tables present in transaction:");
    for (const r of check.rows) console.log(`  ${r.table_name} (${r.cols} cols)`);
    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("\nDRY RUN — rolled back. Nothing changed.");
    } else {
      await client.query("COMMIT");
      console.log("\nAPPLIED.");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Additive migration: Season Ticket Rewards (loyalty). Idempotent.
// Run BEFORE deploying the Season Ticket code.
//   npx tsx script/apply-reward-season.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS reward_season_members (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer NOT NULL,
        contact_id integer,
        name text NOT NULL,
        email text NOT NULL,
        phone text,
        xp integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      );`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_season_org_email_unq ON reward_season_members (organization_id, email);`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS reward_season_events (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        member_id integer NOT NULL REFERENCES reward_season_members(id) ON DELETE CASCADE,
        xp integer NOT NULL DEFAULT 0,
        registration_id integer,
        team_name text,
        created_at timestamp NOT NULL DEFAULT now()
      );`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_season_events_reg_unq ON reward_season_events (registration_id);`);

    await c.query(`
      CREATE TABLE IF NOT EXISTS reward_season_rewards (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        member_id integer NOT NULL REFERENCES reward_season_members(id) ON DELETE CASCADE,
        tier text NOT NULL,
        reward_type text NOT NULL,
        voucher_code text,
        discount_id integer,
        status text NOT NULL DEFAULT 'issued',
        created_at timestamp NOT NULL DEFAULT now()
      );`);
    await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_season_rewards_member_tier_unq ON reward_season_rewards (member_id, tier);`);

    const n = (await c.query(`SELECT COUNT(*)::int AS n FROM reward_season_members`)).rows[0].n;
    console.log(`✓ Season Ticket tables ready. members=${n}`);
  } finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

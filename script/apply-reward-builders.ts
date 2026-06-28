// Additive migration: League Builders (referral rewards). Creates reward_builders
// + reward_builder_events. Idempotent. Run BEFORE deploying the Builders code.
//   npx tsx script/apply-reward-builders.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS reward_builders (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer NOT NULL,
        contact_id integer,
        name text NOT NULL,
        email text NOT NULL,
        phone text,
        builder_code text NOT NULL,
        discount_id integer,
        invite_token text NOT NULL,
        points integer NOT NULL DEFAULT 0,
        credit_earned_cents integer NOT NULL DEFAULT 0,
        credit_used_cents integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_builders_code_unq ON reward_builders (builder_code);`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_builders_invite_unq ON reward_builders (invite_token);`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_builders_org_email_unq ON reward_builders (organization_id, email);`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS reward_builder_events (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        builder_id integer NOT NULL REFERENCES reward_builders(id) ON DELETE CASCADE,
        type text NOT NULL,
        points integer NOT NULL DEFAULT 0,
        commission_cents integer NOT NULL DEFAULT 0,
        registration_id integer,
        referred_email text,
        referred_team_name text,
        tier_at_earning text,
        note text,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS reward_builder_events_reg_unq ON reward_builder_events (registration_id);`);

    const a = await client.query(`SELECT COUNT(*)::int AS n FROM reward_builders`);
    const b = await client.query(`SELECT COUNT(*)::int AS n FROM reward_builder_events`);
    console.log(`✓ League Builders tables ready. builders=${a.rows[0].n} events=${b.rows[0].n}`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

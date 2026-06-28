// Additive migration: Referee Rewards bonus tokens. Idempotent.
//   npx tsx script/apply-reward-ref.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS reward_ref_bonus (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer NOT NULL,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tokens integer NOT NULL DEFAULT 0,
        note text,
        created_at timestamp NOT NULL DEFAULT now()
      );`);
    const n = (await c.query(`SELECT COUNT(*)::int AS n FROM reward_ref_bonus`)).rows[0].n;
    console.log(`✓ reward_ref_bonus ready. rows=${n}`);
  } finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

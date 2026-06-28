// Additive migration: all-in-one support inbox. Idempotent.
//   npx tsx script/apply-inbox.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS inbox_messages (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer NOT NULL,
        channel text NOT NULL,
        name text,
        email text,
        phone text,
        subject text,
        body text NOT NULL,
        status text NOT NULL DEFAULT 'new',
        source_url text,
        handled_by_user_id integer,
        created_at timestamp NOT NULL DEFAULT now()
      );`);
    await c.query(`CREATE INDEX IF NOT EXISTS inbox_messages_org_status_idx ON inbox_messages (organization_id, status);`);
    const n = (await c.query(`SELECT COUNT(*)::int AS n FROM inbox_messages`)).rows[0].n;
    console.log(`✓ inbox_messages ready. rows=${n}`);
  } finally { c.release(); await pool.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });

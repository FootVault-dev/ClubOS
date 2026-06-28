// Additive migration: email suppression list for the mailer (unsubscribes).
// Idempotent — safe to re-run. Run BEFORE deploying the mailer code.
//   npx tsx script/apply-email-unsubscribes.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_unsubscribes (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer,
        email text NOT NULL,
        source text,
        created_at timestamp NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_unsub_org_email_unq
        ON email_unsubscribes (organization_id, email);
    `);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM email_unsubscribes`);
    console.log(`✓ email_unsubscribes ready (rows: ${rows[0].n})`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

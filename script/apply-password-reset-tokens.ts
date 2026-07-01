// Additive migration: self-service password reset tokens.
// Idempotent — safe to re-run. Run BEFORE deploying the forgot-password code.
//   npx tsx script/apply-password-reset-tokens.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Upgrade columns to timestamptz if an earlier run created them tz-naive.
    // Existing naive values are interpreted as UTC. No-op once already tz-aware.
    await client.query(`ALTER TABLE password_reset_tokens ALTER COLUMN expires_at TYPE timestamptz USING expires_at AT TIME ZONE 'UTC';`);
    await client.query(`ALTER TABLE password_reset_tokens ALTER COLUMN used_at    TYPE timestamptz USING used_at    AT TIME ZONE 'UTC';`);
    await client.query(`ALTER TABLE password_reset_tokens ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_unq
        ON password_reset_tokens (token_hash);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
        ON password_reset_tokens (user_id);
    `);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM password_reset_tokens`);
    console.log(`✓ password_reset_tokens ready (rows: ${rows[0].n})`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

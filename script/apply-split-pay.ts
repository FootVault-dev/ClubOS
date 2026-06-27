// Additive migration for Split Pay (split a team fee across the squad).
// Purely additive (CREATE TABLE / INDEX IF NOT EXISTS) — safe to re-run, never
// drops or alters existing data. Run BEFORE deploying the app build.
//   npx tsx --env-file=.env script/apply-split-pay.ts
//
// Creates two new tables mirroring shared/schema.ts:
//   split_sessions — one row per split (a fixed team fee divided N ways)
//   split_members  — one row per payer (own card, own share, lock-then-charge)
// See [[project_mfl_registration]] / reference_clubos_prod_db_drift: prod DB has
// drift, so we migrate additively by hand and NEVER run db:push --force.

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── split_sessions ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS split_sessions (
        id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id     integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        registration_id     integer REFERENCES registrations(id) ON DELETE SET NULL,
        program_id          integer REFERENCES programs(id) ON DELETE SET NULL,
        league_division_id  integer REFERENCES league_divisions(id) ON DELETE SET NULL,
        team_name           text,
        total_cents         integer NOT NULL,
        currency            text NOT NULL DEFAULT 'NZD',
        status              text NOT NULL DEFAULT 'open',
        target_count        integer,
        share_locked_cents  integer,
        organiser_token     text NOT NULL,
        share_code          text NOT NULL,
        locked_at           timestamp,
        settled_at          timestamp,
        deadline_at         timestamp,
        expires_at          timestamp,
        created_at          timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS split_sessions_share_code_unique ON split_sessions (share_code)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS split_sessions_registration_id_unique ON split_sessions (registration_id)`);

    // ── split_members ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS split_members (
        id                       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        split_session_id         integer NOT NULL REFERENCES split_sessions(id) ON DELETE CASCADE,
        name                     text,
        email                    text NOT NULL,
        phone                    text,
        role                     text NOT NULL DEFAULT 'member',
        status                   text NOT NULL DEFAULT 'joined',
        stripe_customer_id       text,
        stripe_setup_intent_id   text,
        stripe_payment_method_id text,
        charged_cents            integer,
        stripe_payment_intent_id text,
        paid_at                  timestamp,
        stripe_refund_id         text,
        stripe_refund_status     text,
        member_token             text NOT NULL,
        joined_at                timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS split_members_session_email_unique ON split_members (split_session_id, email)`);

    // Split Pay rollout flag on programs (default off — feature appears only where enabled).
    await client.query(`ALTER TABLE programs ADD COLUMN IF NOT EXISTS split_enabled boolean DEFAULT false`);

    await client.query("COMMIT");

    // Verify.
    const { rows } = await client.query(`
      SELECT table_name, count(*)::int AS cols
      FROM information_schema.columns
      WHERE table_name IN ('split_sessions','split_members')
      GROUP BY table_name ORDER BY table_name
    `);
    console.log("Split Pay migration applied ✓");
    for (const r of rows) console.log(`  ${r.table_name}: ${r.cols} columns`);
    if (rows.length !== 2) throw new Error("Expected 2 split tables present after migration");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

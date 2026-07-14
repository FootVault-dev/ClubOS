// Additive migration: Friendly Manager history tables (CUFC, org 1).
// Mirrors the mfl_customer_history pattern (raw SQL, not Drizzle-managed).
// Usage:  npx tsx script/apply-fm-history.ts --dry-run   (rehearse, rolled back)
//         npx tsx script/apply-fm-history.ts             (apply)
import "dotenv/config";
import pg from "pg";

const DDL = `
CREATE TABLE IF NOT EXISTS fm_registration_history (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL DEFAULT 1,
  contact_id integer REFERENCES contacts(id),
  fm_person_id text NOT NULL,
  term_id integer NOT NULL,
  term_name text NOT NULL,
  season_year integer,
  programme_group text NOT NULL,
  position text,
  source text NOT NULL DEFAULT 'friendly_manager',
  raw_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_reg_hist_person_term_group_unq
  ON fm_registration_history (fm_person_id, term_id, programme_group);
CREATE INDEX IF NOT EXISTS fm_reg_hist_contact_idx ON fm_registration_history (contact_id);
CREATE INDEX IF NOT EXISTS fm_reg_hist_term_idx ON fm_registration_history (term_id);

CREATE TABLE IF NOT EXISTS fm_payment_history (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL DEFAULT 1,
  contact_id integer REFERENCES contacts(id),
  first_name text,
  last_name text,
  fee_number text,
  fee_description text,
  term_name text,
  season_year integer,
  programme text,
  method text,
  method_raw text,
  paid_on date NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'NZD',
  note_reference text,
  source text NOT NULL DEFAULT 'friendly_manager',
  external_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fm_pay_hist_external_key_unq
  ON fm_payment_history (external_key);
CREATE INDEX IF NOT EXISTS fm_pay_hist_contact_idx ON fm_payment_history (contact_id);
CREATE INDEX IF NOT EXISTS fm_pay_hist_paid_on_idx ON fm_payment_history (paid_on);
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
       where table_name in ('fm_registration_history','fm_payment_history') group by 1 order by 1`
    );
    console.log("Tables present in transaction:", JSON.stringify(check.rows));
    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("DRY RUN — rolled back. Nothing changed.");
    } else {
      await client.query("COMMIT");
      console.log("APPLIED.");
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

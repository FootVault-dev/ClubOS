// Additive migration: mfl_customer_history — the home for imported historical
// MFL purchases (Shopify now; Friendly Manager + SportNinja later) so ClubOS can
// show each customer's full journey (when / how much / what they signed up for),
// lifetime value, and loyalty — WITHOUT polluting the live `registrations` table
// (whose program_id is NOT NULL and which drives live revenue/mailer/registration
// views). People still land in the real `contacts` table; this table is the
// source-tagged purchase ledger the CLV + loyalty trackers read alongside live
// registrations.
//
// Idempotent — safe to re-run. Run BEFORE deploying the tracker code.
//   npx tsx script/apply-mfl-customer-history.ts   (writes to DATABASE_URL in .env)
import "dotenv/config";
import { Pool } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS mfl_customer_history (
        id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        organization_id integer NOT NULL DEFAULT 3,
        contact_id integer REFERENCES contacts(id),
        source text NOT NULL DEFAULT 'shopify',       -- shopify | friendly_manager | sportninja | manual
        external_id text,                             -- source order id (Shopify order id)
        external_ref text,                            -- human ref (Shopify order name, e.g. "#2314")
        external_line_id text,                        -- source line-item id (idempotency key)
        category text,                                -- mini_football | social_leagues | summer_7aside | fill_ins | manual
        product_title text,                           -- e.g. "Mini Football Summer Leagues (Term 4)"
        variant text,                                 -- e.g. "9-a-side - Tuesday" (night/format)
        season_label text,                            -- normalised season/term label (best-effort)
        team_name text,
        purchased_at timestamptz NOT NULL,
        amount_cents integer NOT NULL DEFAULT 0,
        currency text NOT NULL DEFAULT 'NZD',
        quantity integer NOT NULL DEFAULT 1,
        financial_status text,                        -- paid | refunded | partially_refunded | pending | voided
        buyer_first_name text,
        buyer_last_name text,
        buyer_email text,
        buyer_phone text,
        notes text,
        raw_json jsonb,
        added_by_user_id integer REFERENCES users(id), -- set for manual (Plan-B) additions
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    // Idempotency: one row per source line item. Manual additions have no
    // external_line_id, so the uniqueness only applies to imported rows.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS mfl_cust_hist_source_line_unq
        ON mfl_customer_history (source, external_line_id)
        WHERE external_line_id IS NOT NULL;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS mfl_cust_hist_contact_idx ON mfl_customer_history (contact_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS mfl_cust_hist_org_idx ON mfl_customer_history (organization_id);`);
    await client.query(`CREATE INDEX IF NOT EXISTS mfl_cust_hist_email_idx ON mfl_customer_history (lower(buyer_email));`);
    const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM mfl_customer_history`);
    console.log(`✓ mfl_customer_history ready (rows: ${rows[0].n})`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

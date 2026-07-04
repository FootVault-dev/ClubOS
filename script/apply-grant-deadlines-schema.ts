// Additive migration: the grant funding CALENDAR (grant_funder_deadlines).
// One row per application window (dated round / rolling / EOFY-surplus / notable).
// Idempotent — safe to re-run. Additive only (no drops) per the prod-DB-drift rule.
// Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-grant-deadlines-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
CREATE TABLE IF NOT EXISTS grant_funder_deadlines (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  funder_id integer REFERENCES grant_funders(id) ON DELETE SET NULL,
  funder_name text NOT NULL,
  label text,
  kind text,
  opens_on text,
  closes_on text,
  decision_on text,
  event_year integer,
  amount_hint text,
  confidence text,
  relevance text,
  pro_sport_excluded boolean,
  source_url text,
  note text,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grant_deadlines_org ON grant_funder_deadlines(organization_id);
`;

(async () => {
  await pool.query(SQL);
  console.log("✅ grant_funder_deadlines table + index applied (idempotent).");
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

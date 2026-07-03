// Additive migration for the GRANT FUNDING tracker (USG workspace):
// funder directory + application tracker. Idempotent — safe to re-run.
// Additive only (no drops) per the prod-DB-drift rule. Run BEFORE deploying.
//
// Usage: npx tsx --env-file=.env script/apply-grants-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grant_application_status') THEN
    CREATE TYPE grant_application_status AS ENUM ('planning','drafting','submitted','approved','declined','paid','acquitted','withdrawn');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS grant_funders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  funder_type text,
  geography text,
  what_they_fund text,
  priority_score integer,
  typical_grant text,
  max_grant text,
  application_windows text,
  eligibility text,
  relationship_requirements text,
  pro_sport_excluded boolean,
  contact_name text,
  contact_email text,
  contact_phone text,
  website text,
  segment text,
  notes text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grant_funders_org ON grant_funders(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_grant_funders_org_name ON grant_funders(organization_id, lower(name));

CREATE TABLE IF NOT EXISTS grant_applications (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  funder_id integer REFERENCES grant_funders(id) ON DELETE SET NULL,
  funder_name text NOT NULL,
  project_title text NOT NULL,
  purpose text,
  brand_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  amount_requested_cents integer NOT NULL DEFAULT 0,
  amount_approved_cents integer,
  status grant_application_status NOT NULL DEFAULT 'planning',
  round text,
  owner text,
  reference_number text,
  submitted_at timestamp,
  decision_at timestamp,
  paid_at timestamp,
  acquittal_due_at timestamp,
  acquitted_at timestamp,
  docs_url text,
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_grant_applications_org ON grant_applications(organization_id);
`;

(async () => {
  await pool.query(SQL);
  console.log("✅ grant_funders + grant_applications tables + enum + indexes applied (idempotent).");
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

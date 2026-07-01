// Additive migration for the sponsorship PROSPECTS database (raw scraped leads,
// separate from sponsorship_deals). Idempotent — safe to re-run. Additive only
// (no drops) per the prod-DB-drift rule. Run BEFORE deploying the new tab.
//
// Usage: npx tsx --env-file=.env script/apply-sponsorship-prospects-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sponsorship_prospect_status') THEN
    CREATE TYPE sponsorship_prospect_status AS ENUM ('new','reviewing','shortlisted','promoted','dismissed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sponsorship_prospects (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company text NOT NULL,
  website text,
  sector text,
  location text,
  brand_tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  segment text,
  category text,
  tier text,
  fit_score integer,
  spend_capacity_score integer,
  reachability_score integer,
  capacity_estimate text,
  already_backs_sport boolean,
  sport_evidence text,
  why_fit text,
  brief text,
  contact_name text,
  contact_email text,
  email_confidence text,
  contact_phone text,
  decision_maker_name text,
  decision_maker_role text,
  decision_maker_linkedin text,
  linkedin_url text,
  sources text[] NOT NULL DEFAULT ARRAY[]::text[],
  grade_rationale text,
  detail text,
  status sponsorship_prospect_status NOT NULL DEFAULT 'new',
  promoted_deal_id integer REFERENCES sponsorship_deals(id) ON DELETE SET NULL,
  owner_id integer REFERENCES users(id),
  notes text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sponsorship_prospects_org ON sponsorship_prospects(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sponsorship_prospects_org_company ON sponsorship_prospects(organization_id, lower(company));
`;

(async () => {
  await pool.query(SQL);
  console.log("✅ sponsorship_prospects table + enum + indexes applied (idempotent).");
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

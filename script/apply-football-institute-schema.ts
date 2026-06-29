// One-off migration for the Football Institute applications (CUFC workspace).
// Purely additive — CREATE TABLE IF NOT EXISTS only. Wrapped in a single
// transaction so any failure rolls everything back.
//
// Usage: npx tsx --env-file=.env script/apply-football-institute-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS football_institute_applications (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  applicant_name text NOT NULL,
  year_level text,
  position text,
  current_school text,
  current_club text,
  parent_name text,
  email text NOT NULL,
  phone text,
  student_email text,
  video_url text,
  message text,
  intake_year integer,
  status text NOT NULL DEFAULT 'new',
  source text NOT NULL DEFAULT 'website',
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS football_institute_applications_org_idx
  ON football_institute_applications (organization_id);

CREATE INDEX IF NOT EXISTS football_institute_applications_status_idx
  ON football_institute_applications (organization_id, status);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying Football Institute migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");

    const check = await client.query(`
      SELECT 1 FROM information_schema.tables WHERE table_name = 'football_institute_applications'
    `);
    if (check.rows.length !== 1) {
      throw new Error("football_institute_applications table not found after migration");
    }
    console.log("  ✓ football_institute_applications");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});

// One-off migration for the CIC Vendors roster (tournament workspace).
// Purely additive — CREATE TABLE IF NOT EXISTS only. Wrapped in a single
// transaction so any failure rolls everything back. Safe against the drifted
// prod DB (never alters existing columns).
//
// Usage: npx tsx --env-file=.env script/apply-cic-vendors-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS cic_vendors (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'meal',
  is_ours boolean NOT NULL DEFAULT false,
  contact_name text,
  contact_email text,
  contact_phone text,
  contract_status text NOT NULL DEFAULT 'none',
  notes text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cic_vendors_org_idx
  ON cic_vendors (organization_id);

CREATE TABLE IF NOT EXISTS cic_vendor_bookings (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id integer NOT NULL REFERENCES cic_vendors(id) ON DELETE CASCADE,
  booking_date date NOT NULL,
  slot integer,
  notes text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cic_vendor_bookings_org_date_idx
  ON cic_vendor_bookings (organization_id, booking_date);

CREATE UNIQUE INDEX IF NOT EXISTS cic_vendor_bookings_uniq
  ON cic_vendor_bookings (vendor_id, booking_date);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying CIC vendors migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");
    for (const t of ["cic_vendors", "cic_vendor_bookings"]) {
      const check = await client.query(`SELECT to_regclass('public.${t}') AS t`);
      if (!check.rows[0]?.t) throw new Error(`${t} table not found after migration`);
      console.log(`  ✓ ${t}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});

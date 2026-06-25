// One-off migration for the CIC Food Truck roster (tournament workspace).
// Purely additive — CREATE TABLE IF NOT EXISTS only. Wrapped in a single
// transaction so any failure rolls everything back.
//
// Usage: npx tsx --env-file=.env script/apply-food-truck-schema.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS food_truck_shifts (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_date date NOT NULL,
  position text NOT NULL,
  staff_name text NOT NULL,
  time_label text,
  notes text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS food_truck_shifts_org_idx
  ON food_truck_shifts (organization_id);

CREATE INDEX IF NOT EXISTS food_truck_shifts_org_date_idx
  ON food_truck_shifts (organization_id, shift_date);

COMMIT;
`;

async function main() {
  const client = await pool.connect();
  try {
    console.log("Connected. Applying food truck roster migration in one transaction...");
    await client.query(SQL);
    console.log("✅ Migration applied.");

    const check = await client.query(`SELECT to_regclass('public.food_truck_shifts') AS t`);
    if (!check.rows[0]?.t) {
      throw new Error("food_truck_shifts table not found after migration");
    }
    console.log("  ✓ food_truck_shifts");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});

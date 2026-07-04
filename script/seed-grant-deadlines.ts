// Seed the grant calendar (grant_funder_deadlines) + add-only new funders,
// from the verified research (outputs/grant-funding/clubos-seed.json).
// - Funders: ON CONFLICT (org, lower(name)) DO NOTHING — never overwrites edits.
// - Deadlines: the table is entirely seed-driven (no user CRUD), so we CLEAR the
//   org's rows and re-insert — clean + idempotent. Links funder_id by name match.
//
// Usage:
//   ORG_ID=7 SEED_FILE=/abs/path/clubos-seed.json npx tsx --env-file=.env script/seed-grant-deadlines.ts

import { Pool } from "pg";
import { readFileSync } from "fs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
if (!process.env.SEED_FILE) throw new Error("SEED_FILE (absolute path to clubos-seed.json) must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function resolveOrgId(): Promise<number> {
  if (process.env.ORG_ID) return parseInt(process.env.ORG_ID);
  const r = await pool.query("SELECT id FROM organizations WHERE slug = 'united-sports-group'");
  if (r.rows[0]) return r.rows[0].id;
  throw new Error("Could not resolve org — set ORG_ID");
}

(async () => {
  const orgId = await resolveOrgId();
  const data = JSON.parse(readFileSync(process.env.SEED_FILE!, "utf-8"));
  console.log(`Seeding org #${orgId}: ${data.funders.length} funders (add-only), ${data.deadlines.length} deadlines`);

  // 1) Add-only new funders
  let fIns = 0, fSkip = 0;
  for (const f of data.funders) {
    const r = await pool.query(
      `INSERT INTO grant_funders
        (organization_id, name, funder_type, geography, what_they_fund, priority_score,
         typical_grant, max_grant, application_windows, eligibility, relationship_requirements,
         pro_sport_excluded, contact_name, contact_email, contact_phone, website, segment, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (organization_id, lower(name)) DO NOTHING RETURNING id`,
      [orgId, f.name, f.funderType, f.geography, f.whatTheyFund, f.priorityScore,
       f.typicalGrant, f.maxGrant, f.applicationWindows, f.eligibility, f.relationshipRequirements,
       f.proSportExcluded, f.contactName, f.contactEmail, f.contactPhone, f.website, f.segment, f.notes]
    );
    if (r.rows.length) fIns++; else fSkip++;
  }
  console.log(`  funders: ${fIns} added, ${fSkip} already present`);

  // 2) funder name → id map for this org (for FK linking)
  const fm = await pool.query("SELECT id, lower(name) AS lname FROM grant_funders WHERE organization_id=$1", [orgId]);
  const byName = new Map<string, number>(fm.rows.map((r: any) => [r.lname, r.id]));

  // 3) Deadlines are seed-driven — clear + re-insert (idempotent)
  await pool.query("DELETE FROM grant_funder_deadlines WHERE organization_id=$1", [orgId]);
  let dIns = 0;
  for (const d of data.deadlines) {
    const funderId = byName.get(String(d.funderName || "").toLowerCase()) ?? null;
    await pool.query(
      `INSERT INTO grant_funder_deadlines
        (organization_id, funder_id, funder_name, label, kind, opens_on, closes_on, decision_on,
         event_year, amount_hint, confidence, relevance, pro_sport_excluded, source_url, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [orgId, funderId, d.funderName, d.label, d.kind, d.opensOn, d.closesOn, d.decisionOn,
       d.eventYear, d.amountHint, d.confidence, d.relevance, d.proSportExcluded, d.sourceUrl, d.note]
    );
    dIns++;
  }
  console.log(`  deadlines: ${dIns} inserted (org cleared first)`);
  console.log("✅ Done.");
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

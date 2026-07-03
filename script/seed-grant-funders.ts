// Seed the grant_funders directory from the researched funder database
// (outputs/grant-funding/funders.jsonl — 22 NZ/Canterbury funders, built
// 2026-07-01). Idempotent: ON CONFLICT (organization_id, lower(name))
// DO NOTHING — safe to re-run. Run AFTER apply-grants-schema.ts.
//
// Usage:
//   ORG_ID=7 npx tsx --env-file=.env script/seed-grant-funders.ts
//   (defaults to the united-sports-group org if ORG_ID unset)

import { Pool } from "pg";
import { readFileSync } from "fs";
import path from "path";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DATA_FILE = path.resolve(process.cwd(), process.env.FUNDERS_FILE || "../../outputs/grant-funding/funders.jsonl");

// Class-4 trusts that bar professional sport (SIU ineligible) — flagged from
// the eligibility research text at seed time so the UI can badge them.
const PRO_SPORT_RX = /professional sport|professional sports|pro sport|excludes? professional/i;

async function resolveOrgId(): Promise<number> {
  if (process.env.ORG_ID) return parseInt(process.env.ORG_ID);
  const r = await pool.query("SELECT id FROM organizations WHERE slug = 'united-sports-group'");
  if (r.rows[0]) return r.rows[0].id;
  const all = await pool.query("SELECT id, slug, name FROM organizations ORDER BY id");
  console.error("Could not resolve org. Set ORG_ID. Available orgs:");
  for (const o of all.rows) console.error(`  ${o.id}  ${o.slug}  ${o.name}`);
  process.exit(1);
}

(async () => {
  const orgId = await resolveOrgId();
  const lines = readFileSync(DATA_FILE, "utf-8").split("\n").filter((l) => l.trim());
  console.log(`Loaded ${lines.length} funders from ${DATA_FILE} for org #${orgId}`);

  let inserted = 0, skipped = 0;
  for (const line of lines) {
    const F = JSON.parse(line);
    const contact = F.contact || {};
    const eligibilityText = String(F.eligibility_for_us || "");
    const r = await pool.query(
      `INSERT INTO grant_funders
        (organization_id, name, funder_type, geography, what_they_fund, priority_score,
         typical_grant, max_grant, application_windows, eligibility, relationship_requirements,
         pro_sport_excluded, contact_name, contact_email, contact_phone, website, segment, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (organization_id, lower(name)) DO NOTHING
       RETURNING id`,
      [
        orgId,
        F.funder,
        F.type || null,
        F.geography || null,
        F.what_they_fund || null,
        F.priority_score ?? null,
        F.typical_grant_nzd || null,
        F.max_grant_nzd || null,
        F.application_windows || null,
        eligibilityText || null,
        F.relationship_requirements || null,
        PRO_SPORT_RX.test(eligibilityText),
        contact.name || null,
        contact.email || null,
        contact.phone || null,
        F.website || null,
        F._segment || null,
        F.notes || null,
      ]
    );
    if (r.rows.length) inserted++; else skipped++;
  }
  console.log(`✅ Done: ${inserted} inserted, ${skipped} already present.`);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

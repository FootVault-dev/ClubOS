// Apply multi-channel enrichment (from the enrich-contacts workflow output) into
// the live sponsorship_prospects table (org 7) + the workspace prospects.jsonl.
// Additive/idempotent: merges enriched contacts into detail JSON, fills null flat
// contact fields (never overwrites existing good data).
//
// Usage: npx tsx --env-file=.env script/apply-prospect-enrichment.ts <enrichment-output.json>

import { Pool } from "pg";
import { readFileSync, writeFileSync } from "fs";

const OUT = process.argv[2];
if (!OUT) throw new Error("usage: apply-prospect-enrichment.ts <enrichment-output.json>");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const ORG = 7;
const JSONL = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/sponsorship-leads/prospects.jsonl";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function bestContact(contacts: any[]) {
  const withEmail = contacts.filter((c) => c && c.email);
  return withEmail[0] || contacts[0] || {};
}

(async () => {
  let raw: any = JSON.parse(readFileSync(OUT, "utf-8"));
  raw = raw.result ?? raw;
  const results: any[] = raw.results || [];

  const lines = readFileSync(JSONL, "utf-8").split("\n").filter((l) => l.trim());
  const leads = lines.map((l) => JSON.parse(l));
  const byCompany = new Map(leads.map((L: any) => [String(L.company || "").toLowerCase(), L]));

  let updated = 0, contactsTotal = 0;
  for (const r of results) {
    const company = r.company;
    if (!company) continue;
    const contacts = (r.contacts || []).filter((c: any) => c && (c.name || c.email || c.phone || c.instagram || c.linkedin || c.facebook));
    contactsTotal += contacts.length;
    const general = r.general || {};

    const L: any = byCompany.get(String(company).toLowerCase());
    if (L) { L.enriched_contacts = contacts; L.enriched_general = general; L.enriched = true; }

    const sel = await pool.query(
      "SELECT id, detail, contact_email, contact_phone, decision_maker_name FROM sponsorship_prospects WHERE organization_id=$1 AND lower(company)=lower($2) LIMIT 1",
      [ORG, company]
    );
    if (!sel.rows[0]) continue;
    const row = sel.rows[0];
    let detail: any = {};
    try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch {}
    detail.contacts = contacts;
    detail.general = general;
    detail.enriched = true;
    // also feed the field the live drawer already renders, so extra people show immediately
    if (contacts.length) {
      detail.decision_makers = contacts.map((c: any) => ({ name: c.name, role: c.role, linkedin: c.linkedin, source: c.source }));
    }
    const bc = bestContact(contacts);
    await pool.query(
      "UPDATE sponsorship_prospects SET detail=$1, contact_email=COALESCE(contact_email,$2), contact_phone=COALESCE(contact_phone,$3), decision_maker_name=COALESCE(decision_maker_name,$4), updated_at=now() WHERE id=$5",
      [JSON.stringify(detail), bc.email || null, bc.phone || bc.mobile || general.main_phone || null, bc.name || null, row.id]
    );
    updated++;
  }

  writeFileSync(JSONL, leads.map((L) => JSON.stringify(L)).join("\n") + "\n");
  console.log(`Enrichment applied: ${updated} prospects updated in prod (org ${ORG}), ${contactsTotal} contacts total, jsonl synced.`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

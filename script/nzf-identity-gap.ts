// How many of our people could actually be registered with NZ Football today,
// and what exactly is missing from the rest.
//
//   npx tsx --env-file=.env script/nzf-identity-gap.ts
//   npx tsx --env-file=.env script/nzf-identity-gap.ts --org 1 --csv gap.csv
//
// Read-only. Never writes, never guesses.
//
// This is the counter for the backfill campaign. It reads the STRUCTURED
// columns on purpose: a legacy free-text "European" is exactly the value NZ
// Football rejects, so counting it as present would report the gap as closed
// when it is not. That distinction is the whole reason Sporty refused a
// 495-person import on 28 July 2026.

import { writeFileSync } from "node:fs";
import pg from "pg";
import { nzfIdentityGap } from "../shared/nzf-identity";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const orgFilter = arg("--org");
const csvPath = arg("--csv");

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — run with --env-file=.env");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // The structured columns arrive with 2026-07-28_nzf_structured_identity.sql.
  // Say so plainly rather than surfacing a raw Postgres error.
  const probe = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name = 'nationality_code'`,
  );
  if (probe.rowCount === 0) {
    console.error(
      "\nThe structured NZF columns don't exist yet.\n" +
      "Apply the migration first:\n" +
      "  npx tsx --env-file=.env script/apply-nzf-identity.ts --dry-run   (rehearse)\n" +
      "  npx tsx --env-file=.env script/apply-nzf-identity.ts             (apply)\n",
    );
    await pool.end();
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
            c.nationality_code, c.country_of_birth_code, c.ethnicity_group_id,
            c.address_street, c.address_suburb, c.address_city,
            c.address_region, c.address_postcode, c.address_country,
            c.ethnicity  AS legacy_ethnicity,
            c.nationality AS legacy_nationality,
            c.country_of_birth AS legacy_country_of_birth,
            c.address     AS legacy_address,
            c.identity_captured_source,
            c.identity_deferred_at, c.identity_deferred_reason,
            (u.first_name || ' ' || u.last_name) AS deferred_by
       FROM contacts c
       LEFT JOIN users u ON u.id = c.identity_deferred_by_user_id
      WHERE c.type = 'player'
        ${orgFilter ? `AND EXISTS (
              SELECT 1 FROM registrations r
               JOIN programs p ON p.id = r.program_id
              WHERE r.contact_id = c.id AND p.organization_id = $1)` : ""}
      ORDER BY c.last_name, c.first_name`,
    orgFilter ? [Number(orgFilter)] : [],
  );

  const counts = { total: rows.length, complete: 0, countryOfBirth: 0, nationality: 0, ethnicity: 0, address: 0 };
  // How many have SOMETHING in the legacy free-text fields — i.e. the people a
  // backfill can chase with a partial answer already on file, versus those we
  // have to ask from scratch.
  let legacyOnly = 0;
  const deferred: any[] = [];
  const incomplete: any[] = [];

  for (const r of rows) {
    const gap = nzfIdentityGap({
      countryOfBirthCode: r.country_of_birth_code,
      nationalityCode: r.nationality_code,
      ethnicityGroupId: r.ethnicity_group_id,
      addressStreet: r.address_street,
      addressSuburb: r.address_suburb,
      addressCity: r.address_city,
      addressRegion: r.address_region,
      addressPostcode: r.address_postcode,
      addressCountry: r.address_country,
    });
    const missing = Object.entries(gap).filter(([, v]) => v).map(([k]) => k);
    if (missing.length === 0) { counts.complete++; continue; }
    counts.countryOfBirth += gap.countryOfBirth ? 1 : 0;
    counts.nationality += gap.nationality ? 1 : 0;
    counts.ethnicity += gap.ethnicity ? 1 : 0;
    counts.address += gap.address ? 1 : 0;
    const hasLegacy = !!(r.legacy_ethnicity || r.legacy_nationality || r.legacy_country_of_birth || r.legacy_address);
    if (hasLegacy) legacyOnly++;
    if (r.identity_deferred_at) {
      deferred.push({
        name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
        when: String(r.identity_deferred_at).slice(0, 10),
        reason: r.identity_deferred_reason ?? "",
        by: r.deferred_by ?? "",
      });
    }
    incomplete.push({
      id: r.id,
      name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      dob: r.date_of_birth ? String(r.date_of_birth).slice(0, 10) : "",
      missing: missing.join("|"),
      deferredAt: r.identity_deferred_at ? String(r.identity_deferred_at).slice(0, 10) : "",
      deferredReason: r.identity_deferred_reason ?? "",
      deferredBy: r.deferred_by ?? "",
      legacyEthnicity: r.legacy_ethnicity ?? "",
      legacyNationality: r.legacy_nationality ?? "",
      legacyCountryOfBirth: r.legacy_country_of_birth ?? "",
      legacyAddress: r.legacy_address ?? "",
    });
  }

  const pct = (n: number) => (counts.total ? ((n / counts.total) * 100).toFixed(1) : "0.0");
  console.log(`\nNZ Football identity readiness${orgFilter ? ` — org ${orgFilter}` : ""}`);
  console.log(`  players                       ${counts.total}`);
  console.log(`  registerable today            ${counts.complete}  (${pct(counts.complete)}%)`);
  console.log(`  incomplete                    ${counts.total - counts.complete}`);
  console.log(`\n  missing country of birth      ${counts.countryOfBirth}`);
  console.log(`  missing nationality           ${counts.nationality}`);
  console.log(`  missing ethnic group          ${counts.ethnicity}`);
  console.log(`  missing/partial address       ${counts.address}`);
  // The follow-up list: people a staff member promised to come back to. These
  // are qualitatively different from the rest — somebody made a commitment.
  if (deferred.length) {
    console.log(`\n  ── FOLLOW-UP LIST (${deferred.length}) — staff deferred these at the counter ──`);
    for (const d of deferred.slice(0, 40)) {
      console.log(`     ${d.when}  ${d.name.padEnd(26)} ${d.reason}${d.by ? `  (${d.by})` : ""}`);
    }
    if (deferred.length > 40) console.log(`     …and ${deferred.length - 40} more (use --csv for the lot)`);
  } else {
    console.log(`\n  Follow-up list: empty — nobody has been deferred at the counter.`);
  }
  console.log(`\n  of the incomplete, ${legacyOnly} have legacy free-text values on file.`);
  console.log(`  Those are a starting point for a conversation, NOT an answer —`);
  console.log(`  "European" is ambiguous to NZF and a one-line address has no region.`);

  if (csvPath) {
    const cols = Object.keys(incomplete[0] ?? { id: "" });
    const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    writeFileSync(csvPath, [cols.join(","), ...incomplete.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"), "utf8");
    console.log(`\n⚠️  Wrote ${incomplete.length} rows to ${csvPath} — contains children's names and DOBs. Do not commit it.`);
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

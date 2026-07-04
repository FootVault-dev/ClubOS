// READ-ONLY verification of the global-search fuzzy matching against real prod
// data. No writes, no server boot. Temp script — delete after.
// Usage: npx tsx --env-file=.env script/_verify-search.ts
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function sample(label: string, sql: string) {
  const r = await pool.query(sql);
  console.log(`\n▓ ${label}: ${r.rows.length} rows`);
  for (const row of r.rows) console.log("   ", JSON.stringify(row));
}

// Mimic one entity's search query (proposals/prospects/grant_funders/contacts).
async function fuzzy(table: string, cols: string[], labelSql: string, q: string, orgFilter = "") {
  const ilike = cols.map(c => `${c}::text ILIKE $1`).join(" OR ");
  const sim = `GREATEST(${cols.map(c => `similarity(lower(coalesce(${c}::text,'')), lower($2))`).join(", ")})`;
  const sqlText = `SELECT id, (${labelSql}) AS label, round(${sim}::numeric,3) AS score
    FROM ${table} WHERE ((${ilike}) OR (${sim} >= 0.2)) ${orgFilter}
    ORDER BY score DESC NULLS LAST LIMIT 5`;
  const r = await pool.query(sqlText, [`%${q}%`, q]);
  console.log(`\n🔎 ${table}  q="${q}"  →  ${r.rows.length} hits`);
  for (const row of r.rows) console.log(`    [${row.score}] ${row.label}  (#${row.id})`);
}

(async () => {
  // pg_trgm present?
  const ext = await pool.query("SELECT extname FROM pg_extension WHERE extname='pg_trgm'");
  console.log("pg_trgm:", ext.rowCount ? "ENABLED" : "MISSING");

  // Show a few real values so we can craft realistic typo queries.
  await sample("grant_funders (sample names)", "SELECT id, name FROM grant_funders LIMIT 5");
  await sample("sponsorship_prospects (sample companies)", "SELECT id, company FROM sponsorship_prospects LIMIT 5");
  await sample("contacts (sample last names)", "SELECT id, first_name, last_name FROM contacts WHERE last_name IS NOT NULL LIMIT 5");
  await sample("proposals seed check", "SELECT count(*) AS n FROM proposals");
  await sample("proposal_categories seeded", "SELECT name, color FROM proposal_categories ORDER BY sort_order");

  // Fuzzy tests — exact, partial, and DELIBERATE TYPO / wrong-case to prove tolerance.
  await fuzzy("grant_funders", ["name","contact_name","what_they_fund"], "name", "trust");
  await fuzzy("sponsorship_prospects", ["company","contact_name","sector"], "company", "canterbry"); // typo of Canterbury
  await fuzzy("contacts", ["first_name","last_name","email"], "(first_name||' '||last_name)", "smtih"); // typo of Smith
  await fuzzy("contacts", ["first_name","last_name","email"], "(first_name||' '||last_name)", "SMITH"); // wrong case

  await pool.end();
})().catch(e => { console.error("❌", e); process.exit(1); });

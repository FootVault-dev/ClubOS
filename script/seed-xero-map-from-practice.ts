// Seed the mapping from what Olga and Natalia have been doing by hand.
//
//   npx tsx --env-file=.env script/seed-xero-map-from-practice.ts [--commit]
//
// 🔴 Every row here is EVIDENCE, not an opinion: each was read out of their own
// coded Stripe payouts by `script/_derive-payout-mapping.ts` across 25 payouts.
// The `evidence` column records how much money proved each pairing, so a figure
// can be traced back rather than taken on trust.
//
// 🔴 `confirmed_by` stays NULL. Reproducing what someone does by hand is not the
// same as them agreeing it is right — 301 Field Hire in particular is an EXPENSE
// account taking income, which is theirs to keep or change, not ours to correct.

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const COMMIT = process.argv.includes("--commit");

// programme slug → the account they code it to, and what proved it.
const BY_PROGRAM: { slug: string; category: string; account: string; tax: string; evidence: string }[] = [
  { slug: "u4-u8",           category: "academy_term", account: "200/05", tax: "OUTPUT2", evidence: "$3,456 across their coded payouts (FUNiño — First Kicks)" },
  { slug: "technification",  category: "academy_term", account: "200/07", tax: "OUTPUT2", evidence: "$495 (Technification)" },
  { slug: "fundamentals",    category: "academy_camp", account: "203",    tax: "OUTPUT2", evidence: "$566 (FUNdamentals Holiday Camp)" },
  { slug: "worldcup",        category: "academy_camp", account: "203",    tax: "OUTPUT2", evidence: "$1,000 (World Cup Holiday Camp)" },
];

// Everything with no programme of its own.
const BY_CATEGORY: { category: string; account: string | null; tax: string | null; evidence: string }[] = [
  { category: "league_team",   account: "203/02", tax: "OUTPUT2", evidence: "$783 (Mini Football Leagues, Terms 3 and 4)" },
  { category: "league_player", account: "203/02", tax: "OUTPUT2", evidence: "same account as a team entry — they do not separate the two" },
  { category: "academy_term",  account: "200",    tax: "OUTPUT2", evidence: "fallback for any academy programme with no row of its own" },
  { category: "academy_camp",  account: "203",    tax: "OUTPUT2", evidence: "fallback for any camp" },
  { category: "academy_other", account: "200/07", tax: "OUTPUT2", evidence: "Other Programmes" },
  { category: "facility_hire", account: "301",    tax: "INPUT2",  evidence: "$975 — ⚠️ 301 is an EXPENSE account and they tag it GST on Expenses. Reproduced as-is; 275 Field Hire Income may be intended." },
  { category: "invoice",       account: "200/11", tax: "OUTPUT2", evidence: "$108.40 (a card-paid invoice)" },
  { category: "shop",          account: "200/11", tax: "OUTPUT2", evidence: "$40 (CIC photo sales)" },
  // Not evidenced by their work, so left blank rather than guessed.
  { category: "tournament_team",   account: null, tax: null, evidence: "no hand-coded example yet; 218/01 CIC 7's entries is the likely home" },
  { category: "tournament_player", account: null, tax: null, evidence: "no hand-coded example yet" },
  { category: "club_event",        account: null, tax: null, evidence: "the Club Dinner has not paid out yet" },
  { category: "membership",        account: null, tax: null, evidence: "no hand-coded example yet" },
  { category: "print",             account: null, tax: null, evidence: "no hand-coded example yet" },
  { category: "gymnastics",        account: null, tax: null, evidence: "United Gymnastics has its OWN Stripe account, so it never appears in this payout" },
  { category: "unallocated",       account: null, tax: null, evidence: "deliberately blank — an uncoded charge must stop a payout, not land somewhere plausible" },
];

(async () => {
  const org = 1;
  await db.execute(sql`BEGIN`);
  try {
    for (const r of BY_CATEGORY) {
      await db.execute(sql`
        INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code, xero_tax_type, evidence)
        VALUES (${org}, ${r.category}, NULL, ${r.account}, ${r.tax}, ${r.evidence})
        ON CONFLICT (organization_id, category) WHERE program_id IS NULL
        DO UPDATE SET xero_account_code = EXCLUDED.xero_account_code, xero_tax_type = EXCLUDED.xero_tax_type,
                      evidence = EXCLUDED.evidence, updated_at = now()`);
      console.log(`  ${r.category.padEnd(18)} → ${(r.account ?? "— blank —").padEnd(8)} ${r.tax ?? ""}`);
    }
    console.log();
    for (const r of BY_PROGRAM) {
      const p = await db.execute(sql`SELECT id, name FROM programs WHERE slug = ${r.slug} LIMIT 1`);
      const row: any = (p.rows as any[])[0];
      if (!row) { console.log(`  ⚠️  no programme with slug "${r.slug}" — skipped, never guessed`); continue; }
      await db.execute(sql`
        INSERT INTO xero_account_map (organization_id, category, program_id, xero_account_code, xero_tax_type, evidence)
        VALUES (${org}, ${r.category}, ${row.id}, ${r.account}, ${r.tax}, ${r.evidence})
        ON CONFLICT (organization_id, category, program_id) WHERE program_id IS NOT NULL
        DO UPDATE SET xero_account_code = EXCLUDED.xero_account_code, xero_tax_type = EXCLUDED.xero_tax_type,
                      evidence = EXCLUDED.evidence, updated_at = now()`);
      console.log(`  ${String(row.name).slice(0, 30).padEnd(32)} → ${r.account}  (programme ${row.id})`);
    }
    const n = await db.execute(sql`SELECT count(*) FILTER (WHERE xero_account_code IS NOT NULL)::int mapped, count(*)::int total FROM xero_account_map WHERE organization_id=${org}`);
    const s: any = (n.rows as any[])[0];
    console.log(`\n${s.mapped} of ${s.total} rows carry an account. None is confirmed by a human yet.`);
    if (COMMIT) { await db.execute(sql`COMMIT`); console.log("\n🟢 COMMITTED"); }
    else { await db.execute(sql`ROLLBACK`); console.log("\n↩️  rolled back (dry run). Re-run with --commit."); }
  } catch (e: any) { await db.execute(sql`ROLLBACK`); console.error("FATAL", e?.message); process.exit(1); }
  process.exit(0);
})();

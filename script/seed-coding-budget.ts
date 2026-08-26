// Seed the chart of accounts from Victor's workbook.
//
//   npx tsx --env-file=.env script/seed-coding-budget.ts            (dry run)
//   npx tsx --env-file=.env script/seed-coding-budget.ts --commit
//
// Reads ONLY outputs/coding-budget/2026-08-26-victor-workbook/coding-budget.json,
// which is generated from the .xlsx by extract.py. No figure and no code is
// typed in here, so when Victor edits the workbook the path is: re-run
// extract.py, re-run this. Nothing to reconcile by hand.
//
// Idempotent on (organization_id, code). Re-running updates names, budgets and
// the suggested Xero mapping.
//
// 🔴 What re-running deliberately does NOT touch:
//
//   * `xero_account_code` — what Victor actually configured in Xero. The
//     workbook only ever carries a SUGGESTION; overwriting his real mapping
//     with a suggestion every time the sheet changes would undo his work.
//   * `gst_treatment` — a human decision, and the workbook has no column for it.
//   * Any coded transaction. Codes are updated, never deleted, so nothing can
//     be orphaned; a code the workbook drops is marked inactive instead.
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const ORG_ID = 7; // United Sports Group

const JSON_PATH = join(
  process.cwd(), "..", "..", "outputs", "coding-budget",
  "2026-08-26-victor-workbook", "coding-budget.json");

interface Account {
  code: string; parentCode: string | null; topCode: string; depth: number;
  name: string; kind: string; budgetExclCents: number | null;
  budgetInclCents: number | null; treatment: string;
  xeroAccount: string | null; xeroTracking: string | null; note: string | null;
}

async function main() {
  const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const accounts: Account[] = data.accounts;

  console.log(`\n  ${accounts.length} codes from ${data.source} — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  const problems: string[] = [];

  try {
    // ── Pass 1: every code in ONE statement, parent left null. Two passes
    //    because a parent must exist before a child can point at it, and the
    //    workbook is not sorted so that parents always come first.
    //
    //    Set-based, not row-by-row: this database is remote, and 882 codes as
    //    882 round trips took over nine minutes and had not finished. The whole
    //    seed is now three statements.
    const cols = <T,>(f: (a: Account) => T) => accounts.map(f);
    const upserted = await client.query(
      `insert into coding_accounts
         (organization_id, code, top_code, depth, name, kind, treatment,
          budget_excl_cents, budget_incl_cents, xero_account, xero_tracking, note)
       select $1, * from unnest(
         $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[],
         $8::int[], $9::int[], $10::text[], $11::text[], $12::text[])
       on conflict (organization_id, code) do update set
         name              = excluded.name,
         kind              = excluded.kind,
         treatment         = excluded.treatment,
         top_code          = excluded.top_code,
         depth             = excluded.depth,
         budget_excl_cents = excluded.budget_excl_cents,
         budget_incl_cents = excluded.budget_incl_cents,
         xero_account      = excluded.xero_account,
         xero_tracking     = excluded.xero_tracking,
         note              = excluded.note,
         active            = true,
         updated_at        = now()
       returning (xmax = 0) as is_new`,
      [ORG_ID, cols(a => a.code), cols(a => a.topCode), cols(a => a.depth),
       cols(a => a.name), cols(a => a.kind), cols(a => a.treatment),
       cols(a => a.budgetExclCents), cols(a => a.budgetInclCents),
       cols(a => a.xeroAccount), cols(a => a.xeroTracking), cols(a => a.note)]);
    const inserted = upserted.rows.filter(r => r.is_new).length;
    console.log(`  ${inserted} inserted, ${upserted.rowCount! - inserted} updated`);

    // ── Pass 2: wire the tree, also in one statement. The join resolves each
    //    child's parent by code within the same organisation.
    const linked = await client.query(
      `update coding_accounts child
          set parent_id = parent.id, updated_at = now()
         from unnest($2::text[], $3::text[]) as pair(code, parent_code)
         join coding_accounts parent
           on parent.organization_id = $1 and parent.code = pair.parent_code
        where child.organization_id = $1 and child.code = pair.code
          and child.parent_id is distinct from parent.id`,
      [ORG_ID,
       cols(a => a.code).filter((_, i) => accounts[i].parentCode != null),
       cols(a => a.parentCode).filter(p => p != null)]);
    console.log(`  ${linked.rowCount} parent link(s) wired or corrected`);

    // ── A code the workbook no longer carries is RETIRED, never deleted: a
    //    transaction may already be coded to it, and the club's history must
    //    survive a re-categorisation.
    const live = accounts.map(a => a.code);
    const retired = await client.query(
      `update coding_accounts set active = false, updated_at = now()
        where organization_id = $1 and code <> all($2) and active
        returning code`, [ORG_ID, live]);
    if (retired.rowCount) {
      console.log(`  ${retired.rowCount} code(s) retired: ${retired.rows.map(r => r.code).join(", ")}`);
    }

    // ── Verification, against what is actually in the database.
    const counts = await client.query(
      `select kind, count(*)::int n from coding_accounts
        where organization_id = $1 and active group by kind order by kind`, [ORG_ID]);
    for (const r of counts.rows) console.log(`  ${r.kind}: ${r.n} codes`);

    const tops = await client.query(
      `select count(*)::int n from coding_accounts
        where organization_id = $1 and depth = 1 and active`, [ORG_ID]);
    if (tops.rows[0].n !== 30) problems.push(`expected 30 top-level codes, found ${tops.rows[0].n}`);

    const postable = await client.query(
      `select count(*)::int n from coding_accounts
        where organization_id = $1 and postable and active`, [ORG_ID]);
    console.log(`  ${postable.rows[0].n} codes may receive a transaction`);

    const orphan = await client.query(
      `select count(*)::int n from coding_accounts
        where organization_id = $1 and depth > 1 and parent_id is null and active`, [ORG_ID]);
    if (orphan.rows[0].n) problems.push(`${orphan.rows[0].n} non-root code(s) have no parent`);

    // 🔴 The reserved block must not be postable. Codes 14–20 are held for
    //    income streams the board has not approved; posting to one now would
    //    create a category by accident.
    const reservedPostable = await client.query(
      `select code from coding_accounts
        where organization_id = $1 and top_code between '14' and '20' and postable`, [ORG_ID]);
    if (reservedPostable.rowCount) {
      problems.push(`reserved codes are postable: ${reservedPostable.rows.map(r => r.code).join(", ")}`);
    } else {
      console.log("  ✓ reserved codes 14–20 refuse transactions");
    }

    // 🔴 NULL budgets must have survived as NULL. If a default or a coercion
    //    turned them into zeros, "not budgeted" and "budgeted at nil" have been
    //    silently merged and the tab would report a $0 budget on 800 lines.
    const nulls = await client.query(
      `select count(*)::int n from coding_accounts
        where organization_id = $1 and budget_excl_cents is null and active`, [ORG_ID]);
    const zeros = await client.query(
      `select count(*)::int n from coding_accounts
        where organization_id = $1 and budget_excl_cents = 0 and active`, [ORG_ID]);
    const expectNull = accounts.filter(a => a.budgetExclCents == null).length;
    const expectZero = accounts.filter(a => a.budgetExclCents === 0).length;
    if (nulls.rows[0].n !== expectNull) {
      problems.push(`${nulls.rows[0].n} null budgets in the DB, ${expectNull} in the workbook`);
    }
    if (zeros.rows[0].n !== expectZero) {
      problems.push(`${zeros.rows[0].n} zero budgets in the DB, ${expectZero} in the workbook`);
    }
    console.log(`  ✓ ${nulls.rows[0].n} unbudgeted lines stayed NULL, ${zeros.rows[0].n} explicit zeros stayed 0`);

    // ── The reconciliation the workbook cannot do for itself. Reported, never
    //    corrected: these are Victor's numbers and the variance is the finding.
    // Every stream states its own total, so the club's budget is the sum of the
    // thirty top-level codes. Deeper figures are detail WITHIN a stream, never
    // an addition to it — see budgetFor() in shared/coding-budget.ts.
    const recomputed = await client.query(
      `select kind, sum(budget_excl_cents)::bigint ex, sum(budget_incl_cents)::bigint inc
         from coding_accounts
        where organization_id = $1 and active and depth = 1
        group by kind order by kind`, [ORG_ID]);

    const fmt = (c: number | string | null) =>
      c == null ? "—" : `$${(Number(c) / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}`;
    console.log("\n  Budget — recomputed from the codes vs the workbook's own total row:");
    for (const r of recomputed.rows) {
      const stated = data.statedTotals[r.kind];
      const dEx = Number(r.ex) - (stated?.exclCents ?? 0);
      const dIn = Number(r.inc) - (stated?.inclCents ?? 0);
      console.log(`    ${r.kind.padEnd(8)} excl ${fmt(r.ex).padStart(14)} vs stated ${fmt(stated?.exclCents).padStart(14)}  ${dEx === 0 ? "✓" : "Δ " + fmt(dEx)}`);
      console.log(`    ${"".padEnd(8)} incl ${fmt(r.inc).padStart(14)} vs stated ${fmt(stated?.inclCents).padStart(14)}  ${dIn === 0 ? "✓" : "Δ " + fmt(dIn)}`);
    }

    if (problems.length) {
      console.log(`\n  ${problems.length} PROBLEM(S):`);
      for (const p of problems) console.log(`    ✗ ${p}`);
      await client.query("ROLLBACK");
      console.log("\n  rolled back — nothing changed.\n");
      process.exit(1);
    }

    if (COMMIT) {
      await client.query("COMMIT");
      console.log("\n  ✓ committed.\n");
    } else {
      await client.query("ROLLBACK");
      console.log("\n  ✓ all checks passed — rolled back. Re-run with --commit to seed.\n");
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

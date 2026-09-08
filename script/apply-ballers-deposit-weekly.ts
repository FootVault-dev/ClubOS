/**
 * apply-ballers-deposit-weekly.ts — turn on "$20 now, then $10 a week for 8 weeks"
 * for the four Ballers Youth League programmes.
 *
 * Daniel, 2026-09-09: "add weekly payment option so they pay $20 now and then
 * $10 a week for 8 weeks starting from first week like we usually do it but this
 * time for individuals". "Like we usually do it" = the MFL league deposit_weekly
 * plan: deposit at checkout on a saved card, weekly subscription anchored to the
 * first week of the term, cancelled after the last week.
 *
 * Pure data — no deploy needed AFTER the class-book code that reads these
 * columns is live (prod ≥ the 2026-09-09 class deposit-weekly commit). Run it
 * BEFORE that deploy and the live page would offer the OLD weekly model (first
 * week charged today, no deposit) — so the script refuses unless the live
 * bundle carries the new plan copy.
 *
 *   npx tsx --env-file=.env script/apply-ballers-deposit-weekly.ts            # dry run
 *   npx tsx --env-file=.env script/apply-ballers-deposit-weekly.ts --commit
 */
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const DEPOSIT = 2000, WEEKLY = 1000, WEEKS = 8;               // $20 + 8 × $10 = $100
const SLUGS = ["ballers-u9", "ballers-u10", "ballers-u11", "ballers-u12"];
const MARKER = "then $";                                      // copy that only the new checkout renders

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  if (COMMIT) {
    const html = await (await fetch("https://join.minifootball.co.nz/ballers-u9/class-book")).text();
    const js = html.match(/\/assets\/index-[^"]+\.js/)?.[0];
    const bundle = js ? await (await fetch(`https://join.minifootball.co.nz${js}`)).text() : "";
    if (!bundle.includes("deposit_weekly") || !bundle.includes(MARKER)) {
      throw new Error("the live bundle does not carry the class deposit-weekly checkout yet — deploy first, then re-run");
    }
    console.log("  ok   live bundle carries the deposit-weekly checkout");
  }
  await c.query("begin");
  const progs = await c.query(
    `select p.id, p.slug, p.payment_plan, p.deposit_cents, p.num_weekly_payments,
            o.id as option_id, o.name as option_name, o.full_price_cents, o.allow_pay_weekly, o.weekly_price_cents
       from programs p join program_options o on o.program_id = p.id and o.is_active
      where p.organization_id = 3 and p.slug = any($1::text[]) order by p.id`, [SLUGS]);
  if (progs.rowCount !== 4) throw new Error(`expected 4 Ballers programme options, found ${progs.rowCount}`);
  for (const r of progs.rows) {
    if (DEPOSIT + WEEKS * WEEKLY !== r.full_price_cents) {
      throw new Error(`${r.slug}: $${DEPOSIT/100} + ${WEEKS} × $${WEEKLY/100} = $${(DEPOSIT+WEEKS*WEEKLY)/100} ≠ full price $${r.full_price_cents/100} — refusing to sell a plan that does not add up`);
    }
    console.log(`  ${r.slug}: plan ${r.payment_plan ?? "—"}/${r.deposit_cents ?? "—"}/${r.num_weekly_payments ?? "—"} weekly ${r.allow_pay_weekly}/${r.weekly_price_cents ?? "—"}  →  deposit_weekly / $${DEPOSIT/100} / ${WEEKS} · weekly on / $${WEEKLY/100}  (full $${r.full_price_cents/100})`);
  }
  const p = await c.query(`update programs set payment_plan='deposit_weekly', deposit_cents=$2, num_weekly_payments=$3 where organization_id=3 and slug = any($1::text[])`, [SLUGS, DEPOSIT, WEEKS]);
  const o = await c.query(`update program_options set allow_pay_weekly=true, weekly_price_cents=$2 where program_id in (select id from programs where organization_id=3 and slug = any($1::text[])) and is_active`, [SLUGS, WEEKLY]);
  console.log(`  ${p.rowCount} programmes, ${o.rowCount} options updated`);
  if (COMMIT) { await c.query("commit"); console.log("\n✓ committed"); }
  else { await c.query("rollback"); console.log("\n(dry run — rolled back; add --commit)"); }
} catch (e: any) {
  await c.query("rollback").catch(() => {});
  console.error("✗", e.message); process.exitCode = 1;
} finally { await c.end(); }

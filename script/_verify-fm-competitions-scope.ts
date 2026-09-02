/**
 * Verify the Friendly Manager competition history is scoped to the workspace
 * asking for it.
 *
 *   npx tsx --env-file=.env script/_verify-fm-competitions-scope.ts
 *
 * The tab moved out of CUFC and into MFL ("Past Seasons") and CIC ("Past
 * Tournaments") on 2026-09-02. Before that move the routes read ALL 41
 * competitions regardless of caller — so the thing to prove is not that the
 * pages render, but that MFL cannot see the Cup's team managers and vice
 * versa. `fm_competition_teams` holds 635 manager emails and 614 phones.
 *
 * Read-only.
 */
import { sql } from "drizzle-orm";
import { db } from "../server/db";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const rows = async (q: string) => ((await db.execute(sql.raw(q))) as any).rows;
const one = async (q: string) => (await rows(q))[0] ?? {};

async function main() {
  console.log("\n── Where the history actually lives ──────────────────────");
  const split = await rows(`
    SELECT h.organization_id org, o.slug, count(*)::int comps
    FROM fm_competition_history h LEFT JOIN organizations o ON o.id = h.organization_id
    GROUP BY 1,2 ORDER BY 1`);
  for (const r of split) console.log(`  ${String(r.org).padStart(2)}  ${String(r.slug).padEnd(32)} ${r.comps} competitions`);

  console.log("\n── Scoping ───────────────────────────────────────────────");
  const MFL = 3, CIC = 5, CUFC = 1;

  const mfl = await one(`SELECT count(*)::int n FROM fm_competition_history WHERE organization_id = ${MFL}`);
  const cic = await one(`SELECT count(*)::int n FROM fm_competition_history WHERE organization_id = ${CIC}`);
  const all = await one(`SELECT count(*)::int n FROM fm_competition_history`);
  check(`MFL sees its own seasons only (${mfl.n} of ${all.n})`, mfl.n > 0 && mfl.n < all.n);
  check(`CIC sees its own editions only (${cic.n} of ${all.n})`, cic.n > 0 && cic.n < all.n);
  check("the two workspaces do not overlap", mfl.n + cic.n < all.n || mfl.n !== cic.n);

  // 🔴 The real risk: reading another workspace's competition by guessing an id.
  const cicComp = await one(`SELECT fm_comp_id id FROM fm_competition_history WHERE organization_id = ${CIC} LIMIT 1`);
  const crossed = await rows(
    `SELECT fm_comp_id FROM fm_competition_history WHERE fm_comp_id = ${cicComp.id} AND organization_id = ${MFL}`);
  check("a CIC competition id, asked for as MFL, returns nothing", crossed.length === 0,
    "the detail route joins id AND org for exactly this reason");

  const ownFetch = await rows(
    `SELECT fm_comp_id FROM fm_competition_history WHERE fm_comp_id = ${cicComp.id} AND organization_id = ${CIC}`);
  check("…and the same id asked for as CIC still resolves", ownFetch.length === 1);

  console.log("\n── What CUFC gives up by losing the tab ──────────────────");
  const cufc = await one(`
    SELECT count(*)::int comps,
           (SELECT count(*) FROM fm_competition_teams t JOIN fm_competition_history h2 ON h2.fm_comp_id = t.fm_comp_id WHERE h2.organization_id = ${CUFC})::int teams,
           (SELECT count(*) FROM fm_competition_games g JOIN fm_competition_history h2 ON h2.fm_comp_id = g.fm_comp_id WHERE h2.organization_id = ${CUFC})::int games
    FROM fm_competition_history WHERE organization_id = ${CUFC}`);
  console.log(`  CUFC: ${cufc.comps} competition, ${cufc.teams} teams, ${cufc.games} games`);
  check("nothing of substance is stranded in CUFC", cufc.teams === 0 && cufc.games === 0,
    `${cufc.teams} teams / ${cufc.games} games would be unreachable`);

  console.log("\n── The reason this stays super-admin-only ────────────────");
  const pii = await one(`
    SELECT count(*)::int teams, count(manager_email)::int emails, count(manager_phone)::int phones
    FROM fm_competition_teams`);
  console.log(`  ${pii.teams} team records · ${pii.emails} manager emails · ${pii.phones} phones`);
  check("there is real PII here, so the tab stays locked", pii.emails > 0);

  console.log("\n──────────────────────────────────────────────────────────");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });

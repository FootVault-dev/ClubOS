// Flag CIC tournament teams by squad-list coverage (from the Drive submissions
// audit). Additive: adds tournament_teams.roster_status if missing, marks the
// teams with NO squad submitted as "missing" and everyone else "submitted".
// Re-runnable. Run BEFORE deploying (the schema now selects roster_status).
//
//   npx tsx script/flag-cic-rosters.ts
import "dotenv/config";
import { Pool } from "pg";

const CIC_ORG_ID = 5;
// Teams with NO squad folder in the Drive (verified manually against the folder
// listing 2026-07-01). Everything else has a submission.
const MISSING: Record<string, string[]> = {
  U9: ["90+ Football", "Elite Feet Academy", "Legends", "Halswell United AFC"],
  U14: ["Onslow/North Wellington TDP", "Halswell United AFC"],
};

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`ALTER TABLE tournament_teams ADD COLUMN IF NOT EXISTS roster_status text`);

  const tours = (await pool.query(
    `SELECT id, age_group FROM tournaments WHERE organization_id=$1`, [CIC_ORG_ID])).rows;
  const idByAge = new Map<string, number>();
  for (const t of tours) {
    const m = String(t.age_group || "").match(/U?\s*(\d+)/i);
    if (m) idByAge.set("U" + m[1], t.id);
  }

  // Default everyone (in CIC) to "submitted", then mark the misses.
  const tournIds = [...idByAge.values()];
  await pool.query(
    `UPDATE tournament_teams SET roster_status='submitted'
     WHERE tournament_id = ANY($1) AND lower(name) <> 'bye'`, [tournIds]);

  let flagged = 0;
  const notFound: string[] = [];
  for (const [age, names] of Object.entries(MISSING)) {
    const tid = idByAge.get(age);
    if (!tid) { notFound.push(`${age}: no tournament`); continue; }
    for (const name of names) {
      const r = await pool.query(
        `UPDATE tournament_teams SET roster_status='missing'
         WHERE tournament_id=$1 AND lower(trim(name))=lower(trim($2)) RETURNING id`, [tid, name]);
      if (r.rowCount) flagged += r.rowCount; else notFound.push(`${age}: "${name}"`);
    }
  }

  // Report
  console.log(`\nFlagged ${flagged} teams as MISSING. ${notFound.length ? "⚠ not matched: " + notFound.join("; ") : ""}\n`);
  const rep = (await pool.query(
    `SELECT t.age_group, tt.roster_status, count(*)::int n
     FROM tournament_teams tt JOIN tournaments t ON t.id=tt.tournament_id
     WHERE t.organization_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [CIC_ORG_ID])).rows;
  console.log("age   status      n");
  for (const r of rep) console.log(`${String(r.age_group).padEnd(5)} ${String(r.roster_status).padEnd(11)} ${r.n}`);
  const miss = (await pool.query(
    `SELECT t.age_group, tt.name FROM tournament_teams tt JOIN tournaments t ON t.id=tt.tournament_id
     WHERE t.organization_id=$1 AND tt.roster_status='missing' ORDER BY t.age_group, tt.name`, [CIC_ORG_ID])).rows;
  console.log("\nMISSING teams to chase:");
  for (const r of miss) console.log(`  ${r.age_group}  ${r.name}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

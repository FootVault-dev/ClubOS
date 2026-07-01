// Import extracted CIC player rosters (rosters/*.json from the vision-extraction
// agents) into tournament_players, then report per-team coverage + gaps.
//
// Merges age-folder + club-folder sources by ClubOS teamId, dedupes players
// (name+dob), skips players already in the DB. Safe: dry-run unless --commit.
//
//   npx tsx script/import-cic-rosters.ts <rosters-dir> [<clubos_teams.json>] [--commit]

import "dotenv/config";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const CIC_ORG_ID = 5;

function toDate(s: any): string | null {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const mo: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) { const k = mo[m[2].slice(0, 3).toLowerCase()]; if (k) return `${m[3]}-${k}-${m[1].padStart(2, "0")}`; }
  return null;
}
const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const dir = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!dir) { console.error("Usage: tsx script/import-cic-rosters.ts <rosters-dir> [clubos_teams.json] [--commit]"); process.exit(1); }
  const ctPath = process.argv.find((a, i) => i >= 3 && a.endsWith(".json") && !a.startsWith("--"));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ClubOS teams (age → [{teamId,name}]) — for name-fallback + gap report.
  const toursRes = await pool.query(`SELECT id, age_group FROM tournaments WHERE organization_id=$1`, [CIC_ORG_ID]);
  const ageById = new Map<number, string>();
  const ageNormKeyToId = new Map<string, number>();
  const teamAll: { teamId: number; name: string; age: string }[] = [];
  for (const t of toursRes.rows) {
    const age = "U" + String(t.age_group).replace(/\D/g, "");
    ageById.set(t.id, age);
    const teams = (await pool.query(`SELECT id, name FROM tournament_teams WHERE tournament_id=$1`, [t.id])).rows;
    for (const tm of teams) { teamAll.push({ teamId: tm.id, name: tm.name, age }); ageNormKeyToId.set(age + "|" + norm(tm.name), tm.id); }
  }
  const validTeamIds = new Set(teamAll.map(t => t.teamId));

  // Gather extracted players by teamId.
  const byTeam = new Map<number, { first: string; last: string; dob: string | null; shirt: number | null }[]>();
  const files = readdirSync(dir).filter(f => f.endsWith(".json"));
  const unresolved: string[] = [];
  for (const f of files) {
    let data: any;
    try { data = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch (e) { console.log(`⚠ ${f}: unparseable JSON`); continue; }
    for (const t of data.teams || []) {
      let tid: number | undefined = t.clubosTeamId && validTeamIds.has(t.clubosTeamId) ? t.clubosTeamId : undefined;
      if (!tid) {
        const age = t.age || data.scope;
        tid = ageNormKeyToId.get(age + "|" + norm(t.clubosName || ""));
      }
      if (!tid) { unresolved.push(`${f}: ${t.age || data.scope} "${t.clubosName}" (${(t.players || []).length} players)`); continue; }
      const arr = byTeam.get(tid) || [];
      for (const p of t.players || []) {
        const first = (p.firstName || "").trim(), last = (p.lastName || "").trim();
        if (!first && !last) continue;
        arr.push({ first, last, dob: toDate(p.dob), shirt: Number.isInteger(p.shirt) ? p.shirt : null });
      }
      byTeam.set(tid, arr);
    }
  }

  // Dedupe within team + against existing DB, then insert.
  let inserted = 0, skipped = 0;
  await pool.query("BEGIN");
  for (const [teamId, players] of byTeam) {
    const existing = (await pool.query(`SELECT first_name, last_name, date_of_birth FROM tournament_players WHERE team_id=$1`, [teamId])).rows;
    const seen = new Set(existing.map((e: any) => norm(e.first_name) + "|" + norm(e.last_name) + "|" + (e.date_of_birth ? String(e.date_of_birth).slice(0, 10) : "")));
    for (const p of players) {
      const key = norm(p.first) + "|" + norm(p.last) + "|" + (p.dob || "");
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      await pool.query(`INSERT INTO tournament_players (team_id, first_name, last_name, date_of_birth, shirt_number) VALUES ($1,$2,$3,$4,$5)`,
        [teamId, p.first || p.last, p.last || "", p.dob, p.shirt]);
      inserted++;
    }
    await pool.query(`UPDATE tournament_teams SET roster_status='submitted' WHERE id=$1 AND roster_status IS DISTINCT FROM 'missing'`, [teamId]);
  }
  if (commit) { await pool.query("COMMIT"); } else { await pool.query("ROLLBACK"); }

  // Coverage report (post-insert counts within the txn view were committed or rolled back;
  // recompute from what we would have / did import for the report).
  const counts = new Map<number, number>();
  for (const [teamId, players] of byTeam) counts.set(teamId, (counts.get(teamId) || 0) + players.length);
  console.log(`\n${commit ? "🟢 COMMITTED" : "🟡 DRY RUN"} — inserted ${inserted}, skipped(dupe) ${skipped}\n`);
  if (unresolved.length) { console.log(`⚠ UNRESOLVED team entries (${unresolved.length}):`); unresolved.forEach(u => console.log("   " + u)); console.log(""); }
  console.log("=== COVERAGE (extracted players per team) ===");
  const byAge: Record<string, { name: string; n: number }[]> = {};
  for (const t of teamAll) { (byAge[t.age] ||= []).push({ name: t.name, n: counts.get(t.teamId) || 0 }); }
  const gaps: string[] = [];
  for (const age of ["U9", "U10", "U11", "U12", "U13", "U14", "U15"]) {
    const rows = (byAge[age] || []).sort((a, b) => a.name.localeCompare(b.name));
    const withN = rows.filter(r => r.n > 0).length;
    console.log(`\n${age}: ${withN}/${rows.length} teams have players`);
    for (const r of rows) { const flag = r.n === 0 ? "  ❌ NO PLAYERS" : ""; console.log(`   ${String(r.n).padStart(3)}  ${r.name}${flag}`); if (r.n === 0 && r.name.toLowerCase() !== "bye") gaps.push(`${age}  ${r.name}`); }
  }
  console.log(`\n=== GAP LIST (${gaps.length} teams with 0 players — chase these) ===`);
  gaps.forEach(g => console.log("   " + g));
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });

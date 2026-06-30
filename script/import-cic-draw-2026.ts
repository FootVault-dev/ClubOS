// Import the REAL CIC 2026 draw (all 7 age groups) from the parsed draw JSON,
// replacing the placeholder/half-set-up data currently in the DB.
//
// For each age group it: updates the tournament (dates, location, pool count),
// wipes existing pools/teams/games/players/goals, then loads the exact draw —
// real pools + team placements, pool-play fixtures (verbatim game #, time,
// field, home/away), and finals fixtures (with A1/B2/"W G25" placeholders for
// U9 & U15; blank slots for U10–U14 which admins assign on the day).
//
// SAFE BY DEFAULT: runs everything in a transaction and ROLLS BACK unless you
// pass --commit. Always dry-run first and read the summary.
//
//   npx tsx script/import-cic-draw-2026.ts <path-to-cic_draw.json>            # dry run
//   npx tsx script/import-cic-draw-2026.ts <path-to-cic_draw.json> --commit   # persist

import "dotenv/config";
import { Pool, PoolClient } from "pg";
import { readFileSync } from "fs";

const CIC_ORG_ID = 5;
const LOCATION = "United Sports Centre, Christchurch";

interface TeamRow { seed: number; name: string }
interface PoolRow { name: string; teams: TeamRow[] }
interface PoolGame { gameNumber: number; round: number | null; pool: string; date: string | null; time: string | null; timeConf: string | null; field: string; home: string; away: string }
interface FinalGame { gameNumber: number; stage: string; stageDetail: string; date: string | null; time: string | null; field: string; homePlaceholder: string | null; awayPlaceholder: string | null }
interface AgeGroup { age: string; startDate: string | null; endDate: string | null; poolCount: number; pools: PoolRow[]; poolGames: PoolGame[]; finalsGames: FinalGame[] }

async function findOrCreateClub(c: PoolClient, name: string, cache: Map<string, number>): Promise<number> {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  const ex = await c.query(`SELECT id FROM clubs WHERE organization_id=$1 AND LOWER(name)=LOWER($2) LIMIT 1`, [CIC_ORG_ID, name]);
  let id: number;
  if (ex.rowCount && ex.rows[0]) id = ex.rows[0].id;
  else id = (await c.query(`INSERT INTO clubs (organization_id, name) VALUES ($1,$2) RETURNING id`, [CIC_ORG_ID, name])).rows[0].id;
  cache.set(key, id);
  return id;
}

async function importAgeGroup(c: PoolClient, ag: AgeGroup, clubCache: Map<string, number>) {
  const ageNum = ag.age.replace(/\D/g, "");
  // 1. find (or create) the tournament for this age group
  const tRes = await c.query(`SELECT id, name FROM tournaments WHERE organization_id=$1 AND age_group ILIKE $2 LIMIT 1`, [CIC_ORG_ID, `%${ageNum}%`]);
  let tournamentId: number, tName: string;
  if (tRes.rowCount && tRes.rows[0]) {
    tournamentId = tRes.rows[0].id; tName = tRes.rows[0].name;
  } else {
    const ins = await c.query(
      `INSERT INTO tournaments (organization_id, name, age_group, status) VALUES ($1,$2,$3,'active') RETURNING id, name`,
      [CIC_ORG_ID, `${ag.age} Christchurch International Cup 2026`, ag.age]);
    tournamentId = ins.rows[0].id; tName = ins.rows[0].name;
  }

  // 2. update tournament header
  await c.query(
    `UPDATE tournaments SET start_date=$1, end_date=$2, location=$3, num_groups=$4, teams_per_group=4, status='active' WHERE id=$5`,
    [ag.startDate, ag.endDate, LOCATION, ag.poolCount, tournamentId]);

  // 3. clean slate (children first to respect FKs)
  await c.query(`DELETE FROM tournament_goals WHERE game_id IN (SELECT id FROM tournament_games WHERE tournament_id=$1)`, [tournamentId]);
  await c.query(`DELETE FROM tournament_games WHERE tournament_id=$1`, [tournamentId]);
  await c.query(`DELETE FROM tournament_players WHERE team_id IN (SELECT id FROM tournament_teams WHERE tournament_id=$1)`, [tournamentId]);
  await c.query(`DELETE FROM tournament_teams WHERE tournament_id=$1`, [tournamentId]);
  await c.query(`DELETE FROM tournament_groups WHERE tournament_id=$1`, [tournamentId]);

  // 4. pools
  const groupIdByPool = new Map<string, number>();
  for (let i = 0; i < ag.pools.length; i++) {
    const p = ag.pools[i];
    const gid = (await c.query(`INSERT INTO tournament_groups (tournament_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, [tournamentId, p.name, i])).rows[0].id;
    groupIdByPool.set(p.name, gid);
  }

  // 5. teams
  const teamIdByName = new Map<string, number>();
  for (const p of ag.pools) {
    const gid = groupIdByPool.get(p.name)!;
    for (const t of p.teams) {
      const isBye = t.name.trim().toLowerCase() === "bye";
      const clubId = isBye ? null : await findOrCreateClub(c, t.name, clubCache);
      const tid = (await c.query(
        `INSERT INTO tournament_teams (tournament_id, club_id, name, club_name, group_id, seed_number) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tournamentId, clubId, t.name, t.name, gid, t.seed])).rows[0].id;
      teamIdByName.set(t.name, tid);
    }
  }

  // 6. pool games (resolve home/away names → team ids)
  const unresolved: string[] = [];
  let poolGamesInserted = 0;
  for (const g of ag.poolGames) {
    const hid = teamIdByName.get(g.home); const aid = teamIdByName.get(g.away);
    if (g.home && hid === undefined) unresolved.push(`${ag.age} G${g.gameNumber} home="${g.home}"`);
    if (g.away && aid === undefined) unresolved.push(`${ag.age} G${g.gameNumber} away="${g.away}"`);
    await c.query(
      `INSERT INTO tournament_games (tournament_id, group_id, home_team_id, away_team_id, home_team_placeholder, away_team_placeholder, game_number, round_number, stage, stage_detail, game_date, start_time, field, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'group',$9,$10,$11,$12,'scheduled')`,
      [tournamentId, groupIdByPool.get(g.pool) ?? null, hid ?? null, aid ?? null,
       hid ? null : g.home || null, aid ? null : g.away || null,
       g.gameNumber, g.round, g.pool, g.date, g.time, g.field]);
    poolGamesInserted++;
  }

  // 7. finals games (placeholders for U9/U15, blank slots for U10–U14)
  let finalsInserted = 0;
  for (const g of ag.finalsGames) {
    await c.query(
      `INSERT INTO tournament_games (tournament_id, group_id, home_team_id, away_team_id, home_team_placeholder, away_team_placeholder, game_number, round_number, stage, stage_detail, game_date, start_time, field, status)
       VALUES ($1,NULL,NULL,NULL,$2,$3,$4,NULL,$5,$6,$7,$8,$9,'scheduled')`,
      [tournamentId, g.homePlaceholder, g.awayPlaceholder, g.gameNumber, g.stage, g.stageDetail, g.date, g.time, g.field]);
    finalsInserted++;
  }

  return { tournamentId, tName, teams: teamIdByName.size, pools: ag.pools.length, poolGames: poolGamesInserted, finals: finalsInserted, unresolved };
}

async function main() {
  const jsonPath = process.argv[2];
  const commit = process.argv.includes("--commit");
  if (!jsonPath) { console.error("Usage: tsx script/import-cic-draw-2026.ts <cic_draw.json> [--commit]"); process.exit(1); }
  const data: AgeGroup[] = JSON.parse(readFileSync(jsonPath, "utf8"));

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  const clubCache = new Map<string, number>();
  const allUnresolved: string[] = [];
  try {
    await c.query("BEGIN");
    console.log(`\n${commit ? "🟢 COMMIT MODE" : "🟡 DRY RUN (will roll back)"}\n`);
    console.log(`${"Tournament".padEnd(46)} ${"Pools".padEnd(6)} ${"Teams".padEnd(6)} ${"Pool".padEnd(6)} ${"Finals"}`);
    console.log("-".repeat(78));
    for (const ag of data) {
      const r = await importAgeGroup(c, ag, clubCache);
      allUnresolved.push(...r.unresolved);
      console.log(`[${String(r.tournamentId).padStart(2)}] ${r.tName.padEnd(41)} ${String(r.pools).padEnd(6)} ${String(r.teams).padEnd(6)} ${String(r.poolGames).padEnd(6)} ${r.finals}`);
    }
    console.log("-".repeat(78));
    if (allUnresolved.length) {
      console.log(`\n⚠ ${allUnresolved.length} UNRESOLVED team references:`);
      for (const u of allUnresolved) console.log(`   ${u}`);
    } else {
      console.log(`\n✓ All pool-game team names resolved to teams.`);
    }
    if (commit && allUnresolved.length === 0) { await c.query("COMMIT"); console.log("\n✅ COMMITTED to database.\n"); }
    else if (commit) { await c.query("ROLLBACK"); console.log("\n⛔ Rolled back — fix unresolved refs before committing.\n"); }
    else { await c.query("ROLLBACK"); console.log("\n↩  Dry run complete — rolled back. Re-run with --commit to persist.\n"); }
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(e => { console.error(e); process.exit(1); });

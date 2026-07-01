// Create two TEST tournaments (org 5) for war-gaming the full flow live on the
// app + website: a 16-team grade (A1 v B2 bracket) and a 20-team grade (Isaac's
// rule — 5 winners + 3 best 2nds → Cup; 2 remaining 2nds + all 3rds + best 4th →
// Plate; remaining 4ths → placement RR). Idempotent: wipes prior TEST16/TEST20
// first. Remove later with: DELETE FROM tournaments WHERE age_group IN ('TEST16','TEST20').
//   npx tsx script/create-test-tournaments.ts

import "dotenv/config";
import { Pool, PoolClient } from "pg";
import { buildCICSchedule } from "../server/tournament-schedule";

const ORG = 5;
const TODAY = "2026-07-02";
const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];

async function wipe(c: PoolClient, age: string) {
  const t = await c.query(`SELECT id FROM tournaments WHERE organization_id=$1 AND age_group=$2`, [ORG, age]);
  for (const r of t.rows) {
    await c.query(`DELETE FROM tournament_goals WHERE game_id IN (SELECT id FROM tournament_games WHERE tournament_id=$1)`, [r.id]);
    await c.query(`DELETE FROM tournament_games WHERE tournament_id=$1`, [r.id]);
    await c.query(`DELETE FROM tournament_players WHERE team_id IN (SELECT id FROM tournament_teams WHERE tournament_id=$1)`, [r.id]);
    await c.query(`DELETE FROM tournament_teams WHERE tournament_id=$1`, [r.id]);
    await c.query(`DELETE FROM tournament_groups WHERE tournament_id=$1`, [r.id]);
    await c.query(`DELETE FROM tournaments WHERE id=$1`, [r.id]);
  }
}

async function scaffold(c: PoolClient, name: string, age: string, poolCount: number) {
  const t = (await c.query(
    `INSERT INTO tournaments (organization_id, name, age_group, start_date, end_date, location, num_groups, teams_per_group, status)
     VALUES ($1,$2,$3,$4,$5,'United Sports Centre (TEST)',$6,4,'active') RETURNING id`,
    [ORG, name, age, TODAY, "2026-07-04", poolCount])).rows[0].id;
  const groupByLetter = new Map<string, number>();
  const teamByPoolSeed = new Map<string, number>();
  const teams: any[] = [];
  for (let i = 0; i < poolCount; i++) {
    const letter = String.fromCharCode(65 + i);
    const gid = (await c.query(`INSERT INTO tournament_groups (tournament_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, [t, `Pool ${letter}`, i])).rows[0].id;
    groupByLetter.set(letter, gid);
    for (let s = 1; s <= 4; s++) {
      const nm = `${NATO[i]} ${s}`;
      const tid = (await c.query(`INSERT INTO tournament_teams (tournament_id, group_id, name, club_name, seed_number, roster_status) VALUES ($1,$2,$3,$3,$4,'submitted') RETURNING id`, [t, gid, nm, s])).rows[0].id;
      teamByPoolSeed.set(`${letter}${s}`, tid);
      teams.push({ id: tid, tournamentId: t, groupId: gid, name: nm, seedNumber: s });
    }
  }
  return { t, groupByLetter, teamByPoolSeed, teams };
}

async function insertGame(c: PoolClient, g: any) {
  await c.query(
    `INSERT INTO tournament_games (tournament_id, group_id, home_team_id, away_team_id, home_team_placeholder, away_team_placeholder, game_number, round_number, stage, stage_detail, game_date, start_time, field, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'scheduled')`,
    [g.tournamentId, g.groupId ?? null, g.homeTeamId ?? null, g.awayTeamId ?? null, g.homeTeamPlaceholder ?? null, g.awayTeamPlaceholder ?? null,
     g.gameNumber, g.roundNumber ?? null, g.stage, g.stageDetail, g.gameDate ?? TODAY, g.startTime ?? null, g.field ?? "T1"]);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await wipe(c, "TEST16"); await wipe(c, "TEST20");

    // ---- 16-team test (reuse the real CIC 48-game builder: A1 v B2 bracket) ----
    const s16 = await scaffold(c, "🧪 TEST — 16-Team Grade", "TEST16", 4);
    const groups16 = [...s16.groupByLetter.entries()].map(([l, id], i) => ({ id, tournamentId: s16.t, name: `Pool ${l}`, sortOrder: i }));
    const games16 = buildCICSchedule({ tournamentId: s16.t, startDate: TODAY, groups: groups16 as any, teams: s16.teams as any });
    for (const g of games16) await insertGame(c, g);

    // ---- 20-team test (5 pools; Isaac's cross-pool rule) ----
    const s20 = await scaffold(c, "🧪 TEST — 20-Team Grade", "TEST20", 5);
    const tm = (l: string, s: number) => s20.teamByPoolSeed.get(`${l}${s}`)!;
    const ROUNDS: [number, number][][] = [[[1, 2], [3, 4]], [[1, 3], [2, 4]], [[1, 4], [2, 3]]];
    let gn = 1;
    for (let r = 0; r < 3; r++) for (const L of ["A", "B", "C", "D", "E"]) for (const [hs, as_] of ROUNDS[r]) {
      await insertGame(c, { tournamentId: s20.t, groupId: s20.groupByLetter.get(L), homeTeamId: tm(L, hs), awayTeamId: tm(L, as_), gameNumber: gn++, roundNumber: r + 1, stage: "group", stageDetail: `Pool ${L}`, field: r < 2 ? "T1" : "T2", gameDate: r < 2 ? TODAY : "2026-07-03" });
    }
    // knockout — placeholders resolve via the engine (R#=cross-pool, W/L G#=result)
    const KO: [number, string, string, string, string][] = [
      [31, "knockout", "QF 1 CUP", "R1#1", "R2#3"], [32, "knockout", "QF 2 CUP", "R1#4", "R1#5"],
      [33, "knockout", "QF 3 CUP", "R1#2", "R2#2"], [34, "knockout", "QF 4 CUP", "R1#3", "R2#1"],
      [35, "knockout", "QF 1 PLATE", "R2#4", "R4#1"], [36, "knockout", "QF 2 PLATE", "R3#2", "R3#3"],
      [37, "knockout", "QF 3 PLATE", "R2#5", "R3#5"], [38, "knockout", "QF 4 PLATE", "R3#1", "R3#4"],
      [39, "knockout", "PLACEMENT RR", "R4#2", "R4#3"], [40, "knockout", "PLACEMENT RR", "R4#4", "R4#5"],
      [41, "knockout", "PLACEMENT RR", "R4#2", "R4#4"], [42, "knockout", "PLACEMENT RR", "R4#3", "R4#5"],
      [43, "knockout", "PLACEMENT RR", "R4#2", "R4#5"], [44, "knockout", "PLACEMENT RR", "R4#3", "R4#4"],
      [45, "knockout", "SF 1 CUP", "W G31", "W G34"], [46, "knockout", "SF 2 CUP", "W G32", "W G33"],
      [47, "knockout", "SF 1 PLATE", "W G35", "W G38"], [48, "knockout", "SF 2 PLATE", "W G36", "W G37"],
      [49, "knockout", "CUP 3RD PLACE", "L G45", "L G46"], [50, "final", "CUP FINAL", "W G45", "W G46"],
      [51, "knockout", "PLATE 3RD PLACE", "L G47", "L G48"], [52, "final", "PLATE FINAL", "W G47", "W G48"],
    ];
    for (const [g, stage, detail, hp, ap] of KO)
      await insertGame(c, { tournamentId: s20.t, gameNumber: g, stage, stageDetail: detail, homeTeamPlaceholder: hp, awayTeamPlaceholder: ap, field: "T1", gameDate: "2026-07-04" });

    await c.query("COMMIT");
    console.log(`✅ Created test tournaments:`);
    console.log(`   16-team (TEST16) id=${s16.t}: 16 teams, ${games16.length} games`);
    console.log(`   20-team (TEST20) id=${s20.t}: 20 teams, ${30 + KO.length} games`);
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });

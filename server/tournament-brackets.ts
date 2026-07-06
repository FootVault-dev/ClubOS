// Playoff / knockout auto-advancement for CIC tournaments.
//
// Pool-stage games carry no placeholders. Knockout games carry text
// placeholders that say where each slot's team comes from:
//   • "A1".."E4"   → finishing position in a pool (letter = pool, digit = rank)
//   • "R2#3"       → CROSS-POOL: the 3rd-best 2nd-placed team across all pools
//                    (rank 1-4 = pool finishing position, #n = nth-best at that
//                    rank, ranked by pts→GD→GF). Used by the 20-team grades
//                    (5 winners + 3 best 2nds → Cup; 2 remaining 2nds + all
//                    5 thirds + best 4th → Plate; remaining 4ths → placement RR 17-20).
//   • "W G27"      → winner of game number 27
//   • "L G30"      → loser  of game number 30
//
// EARLY (partial) resolution — a slot is filled at the EARLIEST moment its team
// is mathematically confirmed, not only when every game is played:
//   - a pool position resolves as soon as it is CLINCHED (the team's points
//     floor beats every rival's points ceiling, so its finishing place cannot
//     change no matter the remaining results),
//   - a cross-pool seed resolves once EVERY pool's contributing position is
//     clinched AND those teams have finished all their games (so GD/GF, and thus
//     the cross-pool order, are final),
//   - a W/L reference resolves once that game is final (penalties break a draw).
//
// BYE handling (19-team grades with a "Bye" team, e.g. U14 Pool E): bye games
// grant 0 goals / 0 points to BOTH sides (they are excluded from the standings),
// and a "Bye" team is NEVER ranked into a Cup or Plate seed — it only occupies
// the pre-assigned 17th–20th placement slots. Bye games are also ignored when
// judging whether a pool is finished.
//
// It runs a fixpoint so quarters → semis → finals cascade in one call, and it
// ONLY ever touches slots that have a placeholder. Games with a fixed team and
// no placeholder (e.g. a hand-assigned Bye placement slot) are never modified.
// Re-running is safe and idempotent — it always recomputes from current results.

import { storage } from "./storage";

const POOL_RE = /^([A-E])\s*([1-9])$/i;
const RANK_RE = /^R\s*([1-4])\s*#\s*([1-9])$/i;
const WL_RE = /^([WL])\s*G\s*0*(\d+)$/i;
const PTS_WIN = 3;

export async function resolveTournamentBrackets(tournamentId: number): Promise<number> {
  const games = await storage.getTournamentGames(tournamentId);
  if (games.length === 0) return 0;
  const groups = await storage.getTournamentGroups(tournamentId);
  const teams = await storage.getTournamentTeams(tournamentId);

  // "Bye" teams are excluded from all seeding — they only sit in pre-assigned
  // placement slots. Games involving a Bye grant nothing to anyone.
  const byeTeamIds = new Set<number>(
    teams.filter(t => /^\s*bye\s*$/i.test(t.name || "")).map(t => t.id),
  );
  const isByeGame = (g: (typeof games)[number]) =>
    (g.homeTeamId != null && byeTeamIds.has(g.homeTeamId)) ||
    (g.awayTeamId != null && byeTeamIds.has(g.awayTeamId));

  // Pool letter ("A".."E") → groupId.
  const letterToGroupId = new Map<string, number>();
  for (const g of groups) {
    const m = /(?:pool|group)\s*([A-E])/i.exec(g.name) || /^([A-E])$/i.exec(g.name.trim());
    if (m) letterToGroupId.set(m[1].toUpperCase(), g.id);
  }

  // Standings, grouped by pool, best-first. getTournamentGroupStandings already
  // excludes bye games (so real teams get 0 from byes and the Bye is not listed).
  const standings = await storage.getTournamentGroupStandings(tournamentId);
  const standingsByGid = new Map<number, typeof standings>();
  for (const s of standings) {
    if (s.groupId == null || byeTeamIds.has(s.teamId)) continue;
    const arr = standingsByGid.get(s.groupId) || [];
    arr.push(s);
    standingsByGid.set(s.groupId, arr);
  }

  // Remaining (not-yet-final, non-bye) group games per team — for clinch maths.
  const remainingByTeam = new Map<number, number>();
  for (const g of games) {
    if (g.stage !== "group" || g.status === "final" || isByeGame(g)) continue;
    for (const tid of [g.homeTeamId, g.awayTeamId]) {
      if (tid != null && !byeTeamIds.has(tid)) remainingByTeam.set(tid, (remainingByTeam.get(tid) || 0) + 1);
    }
  }
  const remOf = (tid: number) => remainingByTeam.get(tid) || 0;

  // Per pool, which finishing positions are CLINCHED, and to whom. A team X is
  // "surely above" Y when X's points floor exceeds Y's points ceiling
  // (X.pts > Y.pts + 3·gamesLeft(Y)) — then X finishes above Y in every outcome,
  // regardless of goal difference. X's place is locked when every other team is
  // decisively above or below it (best possible place == worst possible place).
  const lockedPos = new Map<number, Map<number, number>>(); // gid → (rank → teamId)
  for (const [gid, table] of standingsByGid) {
    const posMap = new Map<number, number>();
    for (const x of table) {
      let aboveSure = 0, belowSure = 0;
      for (const y of table) {
        if (y.teamId === x.teamId) continue;
        if (y.pts > x.pts + PTS_WIN * remOf(x.teamId)) aboveSure++;
        else if (x.pts > y.pts + PTS_WIN * remOf(y.teamId)) belowSure++;
      }
      const best = aboveSure + 1;
      const worst = table.length - belowSure;
      if (best === worst) posMap.set(best, x.teamId);
    }
    lockedPos.set(gid, posMap);
  }

  // Game number → game (first wins; knockout game numbers are unique).
  const byNum = new Map<number, (typeof games)[number]>();
  for (const g of games) if (g.gameNumber != null && !byNum.has(g.gameNumber)) byNum.set(g.gameNumber, g);

  const rowOf = (gid: number, teamId: number) =>
    standingsByGid.get(gid)?.find(r => r.teamId === teamId);

  // Pool position — resolves as soon as that finishing place is clinched.
  function resolvePoolPos(letter: string, rank: number): number | null {
    const gid = letterToGroupId.get(letter.toUpperCase());
    if (gid == null) return null;
    return lockedPos.get(gid)?.get(rank) ?? null;
  }

  // Cross-pool: the nth-best team finishing `rank`-th across all pools. Resolves
  // once EVERY pool that HAS a rank-th place has it clinched AND that team has no
  // games left (final GD/GF), so the cross-pool order is exact. Pools with fewer
  // than `rank` real teams (e.g. a Bye-shrunk pool for rank 4) simply don't
  // contribute a team at that rank. Bye teams are never present here.
  function resolveCrossPool(rank: number, n: number): number | null {
    const atRank: typeof standings = [];
    let anyPool = false;
    for (const [gid, table] of standingsByGid) {
      if (table.length < rank) continue; // pool has no team at this finishing place
      anyPool = true;
      const tid = lockedPos.get(gid)?.get(rank);
      if (tid == null) return null;      // not clinched yet in this pool
      if (remOf(tid) > 0) return null;   // team still playing → GD/GF not final
      const row = rowOf(gid, tid);
      if (!row) return null;
      atRank.push(row);
    }
    if (!anyPool) return null;
    atRank.sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf);
    return atRank.length >= n ? atRank[n - 1].teamId : null;
  }

  function winnerLoser(gameNum: number, want: "W" | "L"): number | null {
    const g = byNum.get(gameNum);
    if (!g || g.status !== "final" || g.homeScore == null || g.awayScore == null) return null;
    if (!g.homeTeamId || !g.awayTeamId) return null;
    let winId: number, loseId: number;
    if (g.homeScore > g.awayScore) { winId = g.homeTeamId; loseId = g.awayTeamId; }
    else if (g.awayScore > g.homeScore) { winId = g.awayTeamId; loseId = g.homeTeamId; }
    else if (g.homePenalties != null && g.awayPenalties != null && g.homePenalties !== g.awayPenalties) {
      if (g.homePenalties > g.awayPenalties) { winId = g.homeTeamId; loseId = g.awayTeamId; }
      else { winId = g.awayTeamId; loseId = g.homeTeamId; }
    } else {
      return null; // drawn with no penalty result — undecided
    }
    return want === "W" ? winId : loseId;
  }

  function resolve(ph: string | null | undefined): number | null {
    if (!ph) return null;
    const s = ph.trim();
    let m = POOL_RE.exec(s);
    if (m) return resolvePoolPos(m[1], parseInt(m[2], 10));
    m = RANK_RE.exec(s);
    if (m) return resolveCrossPool(parseInt(m[1], 10), parseInt(m[2], 10));
    m = WL_RE.exec(s);
    if (m) return winnerLoser(parseInt(m[2], 10), m[1].toUpperCase() as "W" | "L");
    return null;
  }

  let updated = 0;
  // Fixpoint: pools → QFs, QFs → SFs, SFs → finals cascade in one call.
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    for (const g of games) {
      const updates: { homeTeamId?: number; awayTeamId?: number } = {};
      if (g.homeTeamPlaceholder) {
        const tid = resolve(g.homeTeamPlaceholder);
        if (tid && tid !== g.homeTeamId) updates.homeTeamId = tid;
      }
      if (g.awayTeamPlaceholder) {
        const tid = resolve(g.awayTeamPlaceholder);
        if (tid && tid !== g.awayTeamId) updates.awayTeamId = tid;
      }
      if (updates.homeTeamId || updates.awayTeamId) {
        await storage.updateTournamentGame(g.id, updates);
        if (updates.homeTeamId) g.homeTeamId = updates.homeTeamId;
        if (updates.awayTeamId) g.awayTeamId = updates.awayTeamId;
        updated += Object.keys(updates).length;
        changed++;
      }
    }
    if (changed === 0) break;
  }
  return updated;
}

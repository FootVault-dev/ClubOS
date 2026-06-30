// Playoff / knockout auto-advancement for CIC tournaments.
//
// Pool-stage games carry no placeholders. Knockout games carry text
// placeholders that say where each slot's team comes from:
//   • "A1".."E4"   → finishing position in a pool (letter = pool, digit = rank)
//   • "W G27"      → winner of game number 27
//   • "L G30"      → loser  of game number 30
//
// This resolver fills in the actual team IDs once the source is decided:
//   - a pool position resolves only when EVERY group game in that pool is final
//     (so the standings order is settled),
//   - a W/L reference resolves once that game is final (penalties break a draw).
//
// It runs a fixpoint so quarters → semis → finals cascade in one call, and it
// ONLY ever touches slots that have a placeholder. Games with no placeholder
// (e.g. the U10–U14 finals, which admins assign by hand) are never modified.
// Re-running is safe and idempotent — it always recomputes from current results,
// so correcting a score automatically re-flows the bracket downstream.

import { storage } from "./storage";

const POOL_RE = /^([A-E])\s*([1-9])$/i;
const WL_RE = /^([WL])\s*G\s*0*(\d+)$/i;

export async function resolveTournamentBrackets(tournamentId: number): Promise<number> {
  const games = await storage.getTournamentGames(tournamentId);
  if (games.length === 0) return 0;
  const groups = await storage.getTournamentGroups(tournamentId);

  // Pool letter ("A".."E") → groupId.
  const letterToGroupId = new Map<string, number>();
  for (const g of groups) {
    const m = /(?:pool|group)\s*([A-E])/i.exec(g.name) || /^([A-E])$/i.exec(g.name.trim());
    if (m) letterToGroupId.set(m[1].toUpperCase(), g.id);
  }

  // Pool completeness: a pool is "settled" only when all its group games are final.
  const poolProgress = new Map<number, { final: number; total: number }>();
  for (const g of games) {
    if (g.stage === "group" && g.groupId != null) {
      const e = poolProgress.get(g.groupId) || { final: 0, total: 0 };
      e.total++;
      if (g.status === "final") e.final++;
      poolProgress.set(g.groupId, e);
    }
  }

  // Current standings, grouped by groupId (already sorted best-first).
  const standings = await storage.getTournamentGroupStandings(tournamentId);
  const standingsByGid = new Map<number, typeof standings>();
  for (const s of standings) {
    if (s.groupId == null) continue;
    const arr = standingsByGid.get(s.groupId) || [];
    arr.push(s);
    standingsByGid.set(s.groupId, arr);
  }

  // Game number → game (same object refs as `games`, so in-memory updates are seen).
  const byNum = new Map<number, (typeof games)[number]>();
  for (const g of games) if (g.gameNumber != null) byNum.set(g.gameNumber, g);

  function resolvePoolPos(letter: string, rank: number): number | null {
    const gid = letterToGroupId.get(letter.toUpperCase());
    if (gid == null) return null;
    const prog = poolProgress.get(gid);
    if (!prog || prog.total === 0 || prog.final < prog.total) return null; // pool not settled yet
    const table = standingsByGid.get(gid);
    if (!table || table.length < rank) return null;
    return table[rank - 1].teamId;
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
    m = WL_RE.exec(s);
    if (m) return winnerLoser(parseInt(m[2], 10), m[1].toUpperCase() as "W" | "L");
    return null;
  }

  let updated = 0;
  // Fixpoint: QFs resolve from pools, SFs from QFs, finals from SFs. Cap passes.
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

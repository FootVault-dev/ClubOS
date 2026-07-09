/**
 * Seed the Play Predictor from Mainland Football's own data.
 *
 *   Fixtures — every 2026 Southern League game, with the match-centre id that
 *              lets a result be pulled back automatically after full time.
 *   Squad    — the union of Christchurch United's PUBLISHED TEAMSHEETS this
 *              season. This is the only trustworthy squad source: Transfermarkt
 *              and Sofascore both conflate CUFC's Southern League roster with
 *              South Island United's separate OFC Pro League roster (e.g. Rovu
 *              Boyers is an SIU signing, not a CUFC first-teamer). A teamsheet,
 *              by definition, lists players who actually played for CUFC.
 *
 * Idempotent: fixtures match on mf_match_id, players on (org, lower(name)).
 * Nothing is deleted; a player who stops appearing is left in place for an
 * admin to deactivate.
 *
 * Usage:
 *   npx tsx --env-file=.env script/seed-predictor-cufc.ts            # dry run
 *   npx tsx --env-file=.env script/seed-predictor-cufc.ts --write    # apply
 */
import pg from "pg";
import {
  fetchCufcFixtures,
  fetchCufcTeamsheet,
  type MfFixture,
  type MfTeamsheetPlayer,
} from "../server/mainland-football";
import { PREDICTOR_AUTO_CATEGORIES } from "../shared/predictor-scoring";

const WRITE = process.argv.includes("--write");
const SEASON_FROM = "2026-01-01T00:00:00";
const SEASON_TO = "2026-12-31T23:59:59";
const CUFC_ORG_SLUG = "christchurch-united";
/**
 * The picker should show the players who might actually take the field on
 * Saturday, not everyone who wore the shirt in March. A player qualifies by
 * appearing on any of the last N published teamsheets. Anyone dropped is
 * printed, never silently discarded — and an admin can reactivate them in the
 * ClubOS Play Predictor tab.
 */
const RECENT_TEAMSHEETS = 4;

interface SquadEntry extends MfTeamsheetPlayer { appearances: number; lastSeen: Date; recent: boolean }

async function buildSquad(fixtures: MfFixture[]): Promise<{ squad: SquadEntry[]; dropped: SquadEntry[] }> {
  const played = fixtures.filter((f) => f.played);
  const recentCutoff = played.slice(-RECENT_TEAMSHEETS)[0]?.kickoffAt ?? new Date(0);
  const byName = new Map<string, SquadEntry>();

  for (const f of played) {
    let sheet: MfTeamsheetPlayer[];
    try {
      sheet = await fetchCufcTeamsheet(f.id, f.cufcIsHome);
    } catch (e: any) {
      console.warn(`  ! teamsheet ${f.id} (${f.opponent}): ${e.message}`);
      continue;
    }
    for (const p of sheet) {
      const key = p.name.toLowerCase();
      const existing = byName.get(key);
      if (existing) {
        existing.appearances++;
        // The most recent teamsheet wins on shirt number and position — squad
        // numbers get reassigned mid-season.
        if (f.kickoffAt > existing.lastSeen) {
          existing.lastSeen = f.kickoffAt;
          existing.shirtNumber = p.shirtNumber ?? existing.shirtNumber;
          existing.isGoalkeeper = p.isGoalkeeper;
        }
      } else {
        byName.set(key, { ...p, appearances: 1, lastSeen: f.kickoffAt, recent: false });
      }
    }
    console.log(`  · ${f.kickoffAt.toISOString().slice(0, 10)} v ${f.opponent}: ${sheet.length} players`);
  }

  const all = [...byName.values()];
  for (const p of all) p.recent = p.lastSeen >= recentCutoff;

  // Squad numbers get reassigned mid-season, so two players can each have "worn
  // 10" across the year. The most recently-selected player keeps the number;
  // anyone else loses theirs rather than showing a number that is no longer his.
  const claimed = new Set<number>();
  for (const p of [...all].sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())) {
    if (p.shirtNumber == null) continue;
    if (claimed.has(p.shirtNumber)) p.shirtNumber = null;
    else claimed.add(p.shirtNumber);
  }

  const bySquadNumber = (a: SquadEntry, b: SquadEntry) =>
    (a.shirtNumber ?? 99) - (b.shirtNumber ?? 99) || a.name.localeCompare(b.name);

  return {
    squad: all.filter((p) => p.recent).sort(bySquadNumber),
    dropped: all.filter((p) => !p.recent).sort(bySquadNumber),
  };
}

async function main() {
  console.log(`Mainland Football → Play Predictor  (${WRITE ? "WRITE" : "dry run"})\n`);

  const fixtures = await fetchCufcFixtures(SEASON_FROM, SEASON_TO);
  const upcoming = fixtures.filter((f) => !f.played);
  console.log(`Fixtures: ${fixtures.length} total, ${fixtures.length - upcoming.length} played, ${upcoming.length} upcoming\n`);

  console.log("Reading teamsheets:");
  const { squad, dropped } = await buildSquad(fixtures);
  const show = (p: SquadEntry) => {
    const shirt = p.shirtNumber != null ? String(p.shirtNumber).padStart(2, " ") : " ?";
    console.log(`  ${shirt}  ${p.name.padEnd(28)} ${p.isGoalkeeper ? "GK " : "   "} ${String(p.appearances).padStart(2)} app  last ${p.lastSeen.toISOString().slice(0, 10)}`);
  };

  console.log(`\nSquad — on any of the last ${RECENT_TEAMSHEETS} teamsheets (${squad.length} players):\n`);
  squad.forEach(show);
  if (dropped.length) {
    console.log(`\nNot selected recently, left out of the picker (${dropped.length}):\n`);
    dropped.forEach(show);
  }

  console.log("\nUpcoming fixtures to seed:");
  for (const f of upcoming) {
    console.log(`  ${f.id}  ${f.kickoffAt.toISOString()}  ${f.cufcIsHome ? "H" : "A"}  v ${f.opponent}  (${f.venue ?? "venue TBC"})`);
  }

  if (!WRITE) {
    console.log("\nDry run — nothing written. Re-run with --write to apply.");
    return;
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const { rows: orgRows } = await client.query(`SELECT id FROM organizations WHERE slug = $1`, [CUFC_ORG_SLUG]);
    if (!orgRows[0]) throw new Error(`organization '${CUFC_ORG_SLUG}' not found`);
    const orgId: number = orgRows[0].id;

    await client.query("BEGIN");

    // ── Fixtures ────────────────────────────────────────────────────────────
    // Only seed games that haven't been played — a predictor for a finished
    // game is meaningless, and back-filling results would fabricate a leaderboard.
    let inserted = 0, updated = 0;
    for (const f of upcoming) {
      const { rows: existing } = await client.query(
        `SELECT id FROM predictor_fixtures WHERE organization_id = $1 AND mf_match_id = $2`,
        [orgId, f.id],
      );
      if (existing[0]) {
        await client.query(
          `UPDATE predictor_fixtures
             SET opponent = $1, home_away = $2, kickoff_at = $3, venue = $4, updated_at = now()
           WHERE id = $5 AND status = 'scheduled'`,
          [f.opponent, f.cufcIsHome ? "H" : "A", f.kickoffAt, f.venue, existing[0].id],
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO predictor_fixtures
             (organization_id, mf_match_id, external_id, opponent, home_away, kickoff_at, venue, status, categories)
           VALUES ($1, $2, $2, $3, $4, $5, $6, 'scheduled', $7::jsonb)`,
          [orgId, f.id, f.opponent, f.cufcIsHome ? "H" : "A", f.kickoffAt, f.venue,
           JSON.stringify(PREDICTOR_AUTO_CATEGORIES)],
        );
        inserted++;
      }
    }

    // ── Squad ───────────────────────────────────────────────────────────────
    let playersAdded = 0, playersUpdated = 0;
    for (const [i, p] of squad.entries()) {
      const position = p.isGoalkeeper ? "GK" : null; // the feed publishes no outfield positions
      const sort = p.shirtNumber ?? 90 + i;
      const { rows: existing } = await client.query(
        `SELECT id FROM predictor_squad WHERE organization_id = $1 AND lower(name) = lower($2)`,
        [orgId, p.name],
      );
      if (existing[0]) {
        await client.query(
          `UPDATE predictor_squad SET shirt_number = $1, position = $2, sort = $3, active = true WHERE id = $4`,
          [p.shirtNumber, position, sort, existing[0].id],
        );
        playersUpdated++;
      } else {
        await client.query(
          `INSERT INTO predictor_squad (organization_id, name, position, shirt_number, sort, active)
           VALUES ($1, $2, $3, $4, $5, true)`,
          [orgId, p.name, position, p.shirtNumber, sort],
        );
        playersAdded++;
      }
    }

    await client.query("COMMIT");
    console.log(`\n✓ fixtures: ${inserted} inserted, ${updated} updated`);
    console.log(`✓ squad:    ${playersAdded} added, ${playersUpdated} updated`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("✗ failed:", e.message); process.exit(1); });

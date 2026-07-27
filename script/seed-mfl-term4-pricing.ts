// MFL Term 4 pricing correction + youth hold — Daniel, 27 Jul 2026.
//
// Aligns the live Term 4 prices with the decision made in the MFL meeting the
// same day ("keep everything the same price, and then Tuesday cheaper … I'd
// probably do the cage league a little cheaper as well, the Thursday one"):
//
//   • Tuesday 7's   $600 → $400   (early bird → $320)
//   • Thursday 5's  $500 → $400   (early bird → $320)
//
// Both are the nights with no proven demand — Tuesday finished Term 3 with ZERO
// teams after multiple terms of trying, and Thursday's cage is brand new.
//
// Also pulls the Youth League off the public page until Isaac confirms the ages
// and nights. History (and the Term 4 promo video) says youth ran as TWO
// leagues — U12 Wednesday and U10 Friday — not the single night-TBC entry
// currently listed. A parent must never see a night that later moves, so the
// division is REMOVED rather than left up with a placeholder. It is only safe
// to delete because no team has registered to it; the script refuses otherwise.
//
// Dry run (default):  npx tsx script/seed-mfl-term4-pricing.ts
// Apply:              npx tsx script/seed-mfl-term4-pricing.ts --apply

import "dotenv/config";
import { Pool } from "pg";

const APPLY = process.argv.includes("--apply");
const ORG_ID = 3;
const COMP_NAME = "Mini Football Leagues — Term 4";

const REPRICE: { name: string; fromCents: number; toCents: number }[] = [
  { name: "Tuesday 7's", fromCents: 60000, toCents: 40000 },
  { name: "Thursday 5's", fromCents: 50000, toCents: 40000 },
];
const WITHDRAW = ["Youth League"];

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const comp = await client.query(
      `SELECT id FROM league_competitions WHERE organization_id=$1 AND name=$2`,
      [ORG_ID, COMP_NAME],
    );
    if (comp.rowCount !== 1) throw new Error(`Expected 1 "${COMP_NAME}" for org ${ORG_ID}, found ${comp.rowCount}`);
    const compId = comp.rows[0].id;
    console.log(`Competition #${compId} — ${COMP_NAME}\n`);

    // ── Reprice ──────────────────────────────────────────────────────────────
    for (const r of REPRICE) {
      const d = await client.query(
        `SELECT id, team_cost_cents FROM league_divisions WHERE competition_id=$1 AND name=$2`,
        [compId, r.name],
      );
      if (d.rowCount !== 1) throw new Error(`Expected 1 "${r.name}" in comp ${compId}, found ${d.rowCount}`);
      const row = d.rows[0];
      // Guard: only reprice from the price we believe is live, so a concurrent
      // edit in the workspace is never silently overwritten.
      if (row.team_cost_cents !== r.fromCents) {
        throw new Error(`"${r.name}" is ${money(row.team_cost_cents)}, expected ${money(r.fromCents)} — someone else changed it, aborting`);
      }
      await client.query(`UPDATE league_divisions SET team_cost_cents=$1 WHERE id=$2`, [r.toCents, row.id]);
      const eb = Math.round(r.toCents * 0.8);
      console.log(`  ✓ ${r.name.padEnd(14)} ${money(r.fromCents)} → ${money(r.toCents)}   (early bird ${money(eb)})`);
    }

    // ── Withdraw the youth league until ages/nights are confirmed ────────────
    for (const name of WITHDRAW) {
      const d = await client.query(
        `SELECT id FROM league_divisions WHERE competition_id=$1 AND name=$2`, [compId, name]);
      if (d.rowCount === 0) { console.log(`  – ${name}: already absent`); continue; }
      const divId = d.rows[0].id;
      const teams = await client.query(
        `SELECT count(*)::int AS n FROM league_teams WHERE division_id=$1`, [divId]);
      if (teams.rows[0].n > 0) {
        throw new Error(`"${name}" has ${teams.rows[0].n} team(s) registered — refusing to delete`);
      }
      await client.query(`DELETE FROM league_divisions WHERE id=$1`, [divId]);
      console.log(`  ✓ ${name}: withdrawn from the public page (0 teams, safe to remove)`);
    }

    // ── Show the resulting board ─────────────────────────────────────────────
    const after = await client.query(
      `SELECT name, day_of_week, max_teams, team_cost_cents FROM league_divisions
        WHERE competition_id=$1 ORDER BY sort_order`, [compId]);
    console.log(`\n  Live Term 4 board:`);
    let cap = 0;
    for (const d of after.rows) {
      cap += d.max_teams;
      console.log(`    ${d.name.padEnd(14)} ${String(d.day_of_week ?? "TBC").padEnd(10)} ${String(d.max_teams).padStart(2)} teams  ${money(d.team_cost_cents).padStart(8)}  → EB ${money(Math.round(d.team_cost_cents * 0.8))}`);
    }
    console.log(`    ${"".padEnd(14)} ${"".padEnd(10)} ${String(cap).padStart(2)} team capacity`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log(`\n✓ Applied.`);
    } else {
      await client.query("ROLLBACK");
      console.log(`\n🔍 DRY RUN — rolled back. Re-run with --apply to commit.`);
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Failed:", e.message || e); process.exit(1); });

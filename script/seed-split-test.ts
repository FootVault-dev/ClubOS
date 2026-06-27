// Seed an ISOLATED Split Pay test league (org 3) so staff can run a real, tiny
// end-to-end split with $1 charges WITHOUT touching real Term 3 data.
//
// Creates: a "Split Pay Test" competition + one "Test Night" division with a
// $3.75 team fee + an active league_team program at slug `split-test` with
// split_enabled = true. The live early-bird (20%, auto) brings $3.75 → $3.00, so
// splitting 3 ways = $1.00 each. Test teams land in THIS competition only (not
// real standings/capacity). Idempotent + strictly org-3 scoped.
//
// Run:  npx tsx script/seed-split-test.ts   (writes to DATABASE_URL in .env)

import "dotenv/config";
import { Pool } from "pg";

const ORG_ID = 3; // Mini Football Leagues
const COMP_NAME = "Split Pay Test — staff testing (DO NOT USE)";
const DIVISION_NAME = "Test Night";
const SLUG = "split-test";
const TEAM_FEE_CENTS = 375; // $3.75 → $3.00 after the live 20% early-bird → $1.00 × 3

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // 1) Competition (find-or-create by name within org 3).
    let compId: number;
    const compSel = await client.query(
      `SELECT id FROM league_competitions WHERE organization_id = $1 AND name = $2 LIMIT 1`,
      [ORG_ID, COMP_NAME],
    );
    if (compSel.rowCount && compSel.rowCount > 0) {
      compId = compSel.rows[0].id;
      await client.query(
        `UPDATE league_competitions SET start_date='2026-07-20', end_date='2026-09-24',
           enable_registration=true, registration_status='open', active=true, archived=false WHERE id=$1`,
        [compId],
      );
      console.log(`✓ Reusing test competition #${compId}`);
    } else {
      const ins = await client.query(
        `INSERT INTO league_competitions
           (organization_id, name, sport, start_date, end_date, registration_status,
            enable_registration, active)
         VALUES ($1,$2,'Football','2026-07-20','2026-09-24','open',true,true)
         RETURNING id`,
        [ORG_ID, COMP_NAME],
      );
      compId = ins.rows[0].id;
      console.log(`✓ Created test competition #${compId}`);
    }

    // 2) Division (find-or-create by name within the competition).
    let divId: number;
    const divSel = await client.query(
      `SELECT id FROM league_divisions WHERE competition_id = $1 AND name = $2 LIMIT 1`,
      [compId, DIVISION_NAME],
    );
    if (divSel.rowCount && divSel.rowCount > 0) {
      divId = divSel.rows[0].id;
      await client.query(`UPDATE league_divisions SET team_cost_cents=$1, max_teams=50 WHERE id=$2`, [TEAM_FEE_CENTS, divId]);
      console.log(`✓ Reusing test division #${divId} (fee $${(TEAM_FEE_CENTS / 100).toFixed(2)})`);
    } else {
      const ins = await client.query(
        `INSERT INTO league_divisions
           (competition_id, name, day_of_week, max_teams, team_cost_cents, player_cost_cents, sort_order)
         VALUES ($1,$2,'Saturday',50,$3,0,0) RETURNING id`,
        [compId, DIVISION_NAME, TEAM_FEE_CENTS],
      );
      divId = ins.rows[0].id;
      console.log(`✓ Created test division #${divId} (fee $${(TEAM_FEE_CENTS / 100).toFixed(2)})`);
    }

    // 3) Program (the public league_team registration page) at slug `split-test`,
    //    split_enabled = true so the "Split across my squad" option appears.
    let programId: number;
    const progSel = await client.query(
      `SELECT id FROM programs WHERE organization_id = $1 AND slug = $2 LIMIT 1`,
      [ORG_ID, SLUG],
    );
    if (progSel.rowCount && progSel.rowCount > 0) {
      programId = progSel.rows[0].id;
      await client.query(
        `UPDATE programs SET name=$1, type='league_team', league_competition_id=$2, is_active=true,
           split_enabled=true, deposit_cents=NULL, payment_plan='installment', late_fee_cents=0,
           early_bird_deadline=NULL, upsells_json='[]'::jsonb,
           hero_headline=$3, hero_subheadline=$4 WHERE id=$5`,
        [COMP_NAME, compId, "Split Pay — staff test", "Register a team and split the (tiny) fee across the squad.", programId],
      );
      console.log(`✓ Reusing program #${programId}`);
    } else {
      const ins = await client.query(
        `INSERT INTO programs
           (organization_id, name, slug, type, league_competition_id, is_active, split_enabled,
            payment_plan, num_weekly_payments, late_fee_cents, upsells_json, hero_headline, hero_subheadline)
         VALUES ($1,$2,$3,'league_team',$4,true,true,'installment',8,0,'[]'::jsonb,$5,$6) RETURNING id`,
        [ORG_ID, COMP_NAME, SLUG, compId, "Split Pay — staff test", "Register a team and split the (tiny) fee across the squad."],
      );
      programId = ins.rows[0].id;
      console.log(`✓ Created program #${programId} (slug ${SLUG}, split_enabled)`);
    }

    console.log(`\n🎉 Test page: https://join.minifootball.co.nz/league/${SLUG}`);
    console.log(`   Team fee $3.75 → $3.00 after early-bird → split 3 ways = $1.00 each.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Seed failed:", e); process.exit(1); });

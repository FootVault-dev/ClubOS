// One-time starter goal ladder for the United Sports Group work-management
// system, grounded in the documented strategy (close the ~$700k deficit →
// $350k 2027 → break even 2028; MFL 50→100 teams; CIC July; SIU launch).
// These are DRAFTS for Daniel to edit — the point is a live, demonstrable ladder
// for the staff meeting, not final wording.
// Idempotent: skips entirely if the org already has any non-archived goal.
//
// Usage: npx tsx --env-file=.env script/seed-usg-goal-ladder.ts

import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const org = (await pool.query("SELECT id FROM organizations WHERE slug='united-sports-group' LIMIT 1")).rows[0];
  if (!org) { console.log("no USG org — skip"); await pool.end(); return; }
  const orgId = org.id;

  const existing = (await pool.query("SELECT count(*)::int n FROM goals WHERE organization_id=$1 AND archived=false", [orgId])).rows[0].n;
  if (existing > 0) { console.log(`USG already has ${existing} goals — skipping seed.`); await pool.end(); return; }

  const depts = (await pool.query("SELECT id, slug FROM departments WHERE organization_id=$1", [orgId])).rows;
  const D = (slug: string) => depts.find((d: any) => d.slug === slug)?.id ?? null;

  const insGoal = async (level: string, parentId: number | null, title: string, description: string | null, deptSlug: string | null, brands: string[], period: string | null) => {
    const r = await pool.query(
      `INSERT INTO goals (organization_id, level, parent_id, title, description, department_id, brand_tags, rag_status, period, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'on_track',$8,0) RETURNING id`,
      [orgId, level, parentId, title, description, deptSlug ? D(deptSlug) : null, brands, period]
    );
    return r.rows[0].id as number;
  };
  const insMeasure = async (goalId: number, name: string, type: "lead" | "lag", target: string, unit: string | null) => {
    await pool.query(
      `INSERT INTO goal_measures (goal_id, name, measure_type, target_value, current_value, unit, sort_order)
       VALUES ($1,$2,$3,$4,'0',$5,0)`, [goalId, name, type, target, unit]
    );
  };

  // Vision
  const vision = await insGoal("vision", null,
    "Make United Sports Group financially self-sustaining and the best-run football organisation in New Zealand.",
    "Break even by 2028; world-class operations across every brand.", null, ["usg"], "3-year");

  // Season goals (2026) → priorities (Q3)
  const gDeficit = await insGoal("season", vision, "Cut the annual operating deficit from ~$700k to $350k", "The number every stream ladders up to.", "finance", ["usg", "sponsorship"], "2026");
  await insMeasure(gDeficit, "New sponsorship cash closed", "lead", "200000", "$");
  await insMeasure(gDeficit, "Annual operating deficit", "lag", "350000", "$");

  const gMfl = await insGoal("season", vision, "Grow Mini Football Leagues from 50 to 100+ teams", "Double the league — the flagship community-growth engine.", "football-ops", ["mfl"], "2026");
  await insMeasure(gMfl, "Teams registered", "lag", "100", "");

  const gCic = await insGoal("season", vision, "Deliver a sold-out, profitable CIC July tournament", null, "events", ["cic"], "2026");
  await insMeasure(gCic, "Teams entered", "lag", "120", "");

  const gSiu = await insGoal("season", vision, "Launch South Island United and keep OFC licensing on track", null, "commercial", ["siu"], "2026");

  const priorities: Array<[number, string, string | null, string]> = [
    [gDeficit, "Close 5 new cash sponsors this quarter", "commercial", "sponsorship"],
    [gMfl, "Fill Term 3 to capacity and launch the waitlist", "football-ops", "mfl"],
    [gCic, "Confirm all CIC vendors, sponsors and the draw", "events", "cic"],
    [gSiu, "Submit the OFC licensing evidence pack", "football-ops", "siu"],
  ];
  for (const [parent, title, deptSlug, brand] of priorities) {
    await insGoal("priority", parent, title, null, deptSlug, [brand], "2026-Q3");
  }
  const pCalls = (await pool.query("SELECT id FROM goals WHERE organization_id=$1 AND level='priority' AND title LIKE 'Close 5 new%' LIMIT 1", [orgId])).rows[0];
  if (pCalls) await insMeasure(pCalls.id, "Sponsor calls booked", "lead", "40", "");

  const counts = (await pool.query("SELECT level, count(*)::int n FROM goals WHERE organization_id=$1 GROUP BY level ORDER BY level", [orgId])).rows;
  console.log("✅ Seeded starter goal ladder:", counts);
  await pool.end();
})().catch((e) => { console.error("❌", e); process.exit(1); });

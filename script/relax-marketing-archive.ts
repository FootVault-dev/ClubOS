// Open the marketing archive to staff — safely.
//
// 🔴 THE TRAP THIS EXISTS TO AVOID. "Marketing and Social Media - Liam Higgins"
// (1,189 nodes of usable club assets) was locked for ONE reason: "First Team
// Payments 2023" buried inside it. That child has no gate of its own — it was
// only ever protected by INHERITING the parent's. The sweep that locks
// sensitive folders skips anything already gated, and an inherited gate looks
// identical to an owned one, so it skipped this.
//
// Relaxing the parent without first giving the child its OWN gate would have
// published three spreadsheets of player payments to every staff account.
// Lock the child first, prove it, then open the parent.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const child = await pool.query(
  `UPDATE drive_nodes SET required_tab='budget'
   WHERE (name ILIKE '%First Team Payments%' OR name ILIKE 'First team payments%')
     AND required_tab IS NULL RETURNING id, name`);
console.log(`\n  gave ${child.rows.length} payment node(s) their own gate:`);
for (const c of child.rows) console.log(`    ${c.name}`);

// Prove the child is now gated on its own, BEFORE relaxing the parent.
const proof = await pool.query(`
  SELECT n.name, n.required_tab FROM drive_nodes n
  WHERE n.name ILIKE '%First Team Payments 2023%'`);
const ownGate = proof.rows.every((r: any) => r.required_tab === 'budget');
if (!ownGate) { console.log("\n  child is NOT independently gated — refusing to open the parent\n"); await pool.end(); process.exit(1); }

const parent = await pool.query(
  `UPDATE drive_nodes SET required_tab=NULL
   WHERE parent_id=33 AND name ILIKE 'Marketing and Social Media%' RETURNING id, name`);
console.log(`\n  opened ${parent.rows.length} folder(s) to staff: ${parent.rows.map((r: any) => r.name).join(", ")}`);

// And prove the payments are STILL hidden afterwards.
const after = await pool.query(`
  SELECT n.name, coalesce(g.gates,'{}') AS gates FROM drive_nodes n
  JOIN drive_node_gates g ON g.id=n.id WHERE n.name ILIKE '%First Team Payments 2023%'`);
console.log(`\n  after opening the parent, the payments folder still resolves to: ${JSON.stringify(after.rows[0]?.gates)}\n`);
await pool.end();

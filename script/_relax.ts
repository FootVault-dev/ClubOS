import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
// Is the reason the marketing archive was locked now locked on its own?
const child = await p.query(`SELECT id, name, required_tab FROM drive_nodes WHERE name ILIKE '%First Team Payments%'`);
console.log("\nthe nested reason:");
for (const c of child.rows) console.log(`  ${c.name} — own gate: ${c.required_tab ?? "(none)"}`);
const parent = await p.query(`SELECT id, name FROM drive_nodes WHERE name ILIKE 'Marketing and Social Media%' AND parent_id = 33`);
console.log(`\nparent: ${parent.rows[0]?.name} (id ${parent.rows[0]?.id})`);
const under = await p.query(`
  WITH RECURSIVE d AS (SELECT id FROM drive_nodes WHERE id=$1
    UNION ALL SELECT n.id FROM drive_nodes n JOIN d ON n.parent_id=d.id)
  SELECT count(*)::int n FROM d`, [parent.rows[0]?.id]);
console.log(`  nodes underneath: ${under.rows[0].n}`);
await p.end();

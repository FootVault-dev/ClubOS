// What is locked, what is open, and how fast the gate resolves at real scale.
import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const r = await p.query(`
  SELECT n.id, n.name, n.required_tab,
         (SELECT count(*) FROM drive_nodes d WHERE d.parent_id = n.id) AS kids
  FROM drive_nodes n WHERE n.parent_id = 33 ORDER BY (n.required_tab IS NOT NULL) DESC, n.name`);
console.log("\nTop level of Club Drive:\n");
for (const x of r.rows) {
  console.log(`  ${x.required_tab ? "🔒" : "  "} ${String(x.name).slice(0, 44).padEnd(46)} ${String(x.kids).padStart(4)} items`);
}

const tot = await p.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE kind='file')::int AS f FROM drive_nodes`);
console.log(`\n  ${tot.rows[0].n} nodes (${tot.rows[0].f} files)`);

// The real query the page runs: gates for one page of rows, walking upward.
const page = await p.query(`SELECT id FROM drive_nodes ORDER BY id DESC LIMIT 60`);
const ids = page.rows.map((x: any) => x.id);
const t0 = Date.now();
const g = await p.query(`
  WITH RECURSIVE up AS (
    SELECT id AS start_id, id, parent_id, required_tab FROM drive_nodes WHERE id = ANY($1)
    UNION ALL
    SELECT u.start_id, n.id, n.parent_id, n.required_tab FROM drive_nodes n JOIN up u ON n.id = u.parent_id
  )
  SELECT start_id, coalesce(array_agg(required_tab) FILTER (WHERE required_tab IS NOT NULL),'{}') AS gates
  FROM up GROUP BY start_id`, [ids]);
console.log(`  gate resolution for 60 rows: ${Date.now() - t0}ms`);
const locked = g.rows.filter((x: any) => x.gates.length).length;
console.log(`  of those 60, ${locked} inherit a lock\n`);
await p.end();

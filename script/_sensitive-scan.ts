// Find folders at ANY depth whose names indicate contracts, money, identity or
// medical records — the classes that must not be browsable by every staffer.
import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const PAT = ['contract','salary','salaries','payment','payroll','wage','passport','visa',
             'medical','bank','tax','ird','confidential','private','personal','tenanc',
             'bond','disciplinary','safeguard','insurance','payslip','remuneration'];
const like = PAT.map((_, i) => `lower(n.name) LIKE $${i + 1}`).join(" OR ");
const r = await p.query(`
  SELECT n.id, n.name,
    (SELECT count(*) FROM drive_nodes d WHERE d.parent_id = n.id)::int kids,
    coalesce(g.gates,'{}') AS gates
  FROM drive_nodes n LEFT JOIN drive_node_gates g ON g.id = n.id
  WHERE n.kind='folder' AND n.trashed_at IS NULL AND (${like})
  ORDER BY (coalesce(g.gates,'{}') = '{}') DESC, n.name`,
  PAT.map(x => `%${x}%`));
console.log(`\n${r.rows.length} folders matched a sensitive keyword:\n`);
let open = 0;
for (const x of r.rows) {
  const locked = (x.gates ?? []).length > 0;
  if (!locked) open++;
  console.log(`  ${locked ? "🔒 already" : "⚠️  OPEN  "}  ${String(x.name).slice(0,48).padEnd(50)} ${String(x.kids).padStart(3)} items`);
}
console.log(`\n  ${open} of ${r.rows.length} are currently readable by every staff member\n`);
await p.end();

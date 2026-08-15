import pg from "pg";
const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
// NAME patterns only. Content matches are far too broad — a policy that merely
// mentions payroll is not a payslip.
const PAT = ['contract','payslip','salary','remuneration','passport','visa application',
             'payroll','bank account','tenancy agreement','employment agreement','offer letter'];
const like = PAT.map((_, i) => `lower(n.name) LIKE $${i + 1}`).join(" OR ");
const r = await p.query(`
  SELECT n.id, n.name, coalesce(g.gates,'{}') AS gates
  FROM drive_nodes n LEFT JOIN drive_node_gates g ON g.id = n.id
  WHERE n.kind='file' AND n.trashed_at IS NULL AND (${like})
  ORDER BY (coalesce(g.gates,'{}')='{}') DESC, n.name`, PAT.map(x => `%${x}%`));
const open = r.rows.filter((x: any) => (x.gates ?? []).length === 0);
console.log(`\n${r.rows.length} files match a sensitive NAME · ${open.length} still open:\n`);
for (const x of open.slice(0, 25)) console.log(`  ⚠️  ${String(x.name).slice(0, 66)}`);
if (open.length > 25) console.log(`  …and ${open.length - 25} more`);
console.log("");
await p.end();

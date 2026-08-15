// Lock folders at ANY depth whose names indicate contracts, money, identity or
// medical records.
//
//   Preview: npx tsx --env-file=.env script/lock-sensitive-folders.ts --list
//   Apply:   npx tsx --env-file=.env script/lock-sensitive-folders.ts
//
// 🔴 preseed-drive-gates.ts only covers the TOP level, which is not enough: the
// import surfaced "SIU - South Island United/Player Contracts/SIU Signed
// Contracts" and "Payroll Information" several levels down inside otherwise
// perfectly ordinary folders. Found by reading a screenshot of real search
// results, not by reading the tree — two players' signed contracts came back
// for an ordinary staff account.
//
// Gates accumulate downward, so locking the folder locks everything under it.
import { Pool } from "pg";

const LIST = process.argv.includes("--list");
const PAT = ['contract','salary','salaries','payment','payroll','wage','passport','visa',
             'medical','bank','tax','ird','confidential','private','personal','tenanc',
             'bond','disciplinary','safeguard','payslip','remuneration'];

// 🔴 FILES matter as much as folders. Folder gating cannot catch an employment
// agreement sitting in an otherwise ordinary folder — the real drive had the
// GM's contract, four role contracts, a remuneration report and a passports
// file all readable by every staff account. NAME patterns only: a policy that
// merely mentions payroll is not a payslip, so matching on content would lock
// half the drive.
const FILE_PAT = ['contract','payslip','salary','remuneration','passport','visa application',
                  'payroll','bank account','tenancy agreement','employment agreement','offer letter',
                  // A signed personal document rarely says "contract" in its
                  // name: the Academy Director's was "PH - Academy Director 2026
                  // - Signed.pdf" and slipped straight through.
                  '- signed','signed -','_signed','agreement'];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const like = PAT.map((_, i) => `lower(n.name) LIKE $${i + 1}`).join(" OR ");
const { rows } = await pool.query(`
  SELECT n.id, n.name, coalesce(g.gates,'{}') AS gates
  FROM drive_nodes n LEFT JOIN drive_node_gates g ON g.id = n.id
  WHERE n.kind='folder' AND n.trashed_at IS NULL AND n.required_tab IS NULL
    AND coalesce(g.gates,'{}') = '{}' AND (${like})
  ORDER BY n.name`, PAT.map(x => `%${x}%`));

console.log(`\n${rows.length} unlocked folder(s) matched:\n`);
for (const r of rows) console.log(`  ${r.name}`);
if (LIST) { console.log(""); await pool.end(); process.exit(0); }

for (const r of rows) {
  await pool.query(`UPDATE drive_nodes SET required_tab='budget' WHERE id=$1`, [r.id]);
}
console.log(`\n  locked ${rows.length} folder(s) to super-admin (everything beneath inherits)`);

const fileLike = FILE_PAT.map((_, i) => `lower(n.name) LIKE $${i + 1}`).join(" OR ");
const files = await pool.query(`
  SELECT n.id, n.name FROM drive_nodes n LEFT JOIN drive_node_gates g ON g.id = n.id
  WHERE n.kind='file' AND n.trashed_at IS NULL AND n.required_tab IS NULL
    AND coalesce(g.gates,'{}') = '{}' AND (${fileLike})`, FILE_PAT.map(x => `%${x}%`));
for (const f of files.rows) {
  await pool.query(`UPDATE drive_nodes SET required_tab='budget' WHERE id=$1`, [f.id]);
}
console.log(`  locked ${files.rows.length} individual file(s) by name\n`);
await pool.end();

// Confirm BOTH the chat-threads migration and the Club Drive migration are on
// the production database before deploying the union of the two branches.
import pg from "pg";

const p = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const cols = await p.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_name='staff_messages' AND column_name IN ('parent_message_id','forwarded_from_message_id')`,
);
const links = await p.query(`SELECT 1 FROM information_schema.tables WHERE table_name='staff_message_links'`);
const drive = await p.query(`SELECT 1 FROM information_schema.tables WHERE table_name='drive_nodes'`);
const gates = await p.query(`SELECT 1 FROM information_schema.views WHERE table_name='drive_node_gates'`);
const driveRows = await p.query(`SELECT count(*)::int AS n FROM drive_nodes`);

console.log(`  chat: thread columns on staff_messages   ${cols.rows.length}/2`);
console.log(`  chat: staff_message_links table          ${links.rows.length ? "yes" : "NO"}`);
console.log(`  drive: drive_nodes table                 ${drive.rows.length ? "yes" : "NO"}`);
console.log(`  drive: drive_node_gates view             ${gates.rows.length ? "yes" : "NO"}`);
console.log(`  drive: rows currently stored             ${driveRows.rows[0].n}`);

await p.end();
const allGood = cols.rows.length === 2 && links.rows.length && drive.rows.length && gates.rows.length;
console.log(allGood ? "\n  both migrations are live on prod\n" : "\n  SOMETHING IS MISSING — do not deploy\n");
process.exit(allGood ? 0 : 1);

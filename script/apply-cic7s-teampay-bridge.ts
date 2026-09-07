// Apply migrations/2026-09-08_cic7s_teampay_bridge.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-cic7s-teampay-bridge.ts            (dry run)
//   npx tsx --env-file=.env script/apply-cic7s-teampay-bridge.ts --commit
//
// There is no local Postgres, so the dry run IS the rehearsal: the real DDL and
// the real checks run inside a transaction that is then rolled back. Fixtures
// are built under a SAVEPOINT and discarded before COMMIT, so nothing of the
// rehearsal survives a --commit either.
//
// What must be REFUSED (a constraint nobody has watched reject something is a
// comment):
//   1. two registrations claiming the same Team Pay entry
//   2. two registrations holding the same enter token
// What must be ACCEPTED:
//   A. many registrations with no token and no entry (every existing row)
//   B. a registration linked to a real entry
//   C. deleting that entry leaves the registration standing, link cleared
//   D. re-running the migration
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-08_cic7s_teampay_bridge.sql";

const problems: string[] = [];
let checks = 0;
function ok(label: string) { checks++; console.log(`  ✓ ${label}`); }
function bad(label: string) { checks++; problems.push(label); console.log(`  ✗ ${label}`); }

async function mustRefuse(c: pg.Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ALLOWED, and must not be`);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    ok(`refused: ${label}`);
  }
}
async function mustAccept(c: pg.Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    const r = await c.query(sql, params);
    await c.query("RELEASE SAVEPOINT s");
    ok(`accepted: ${label}`);
    return r;
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was REFUSED: ${e.message}`);
    return null;
  }
}

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`\n  ${MIGRATION} — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await c.query("BEGIN");
  try {
    const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
    await c.query(sql);
    ok("migration ran");
    await c.query(sql);
    ok("migration ran a second time (idempotent)");

    const cols = (await c.query(
      `select column_name from information_schema.columns
        where table_name = 'cic7s_registrations' and column_name in ('enter_token','teampay_entry_id','notes')`)).rows.map((r) => r.column_name).sort();
    if (cols.join(",") === "enter_token,notes,teampay_entry_id") ok("three columns present"); else bad(`columns: ${cols.join(",")}`);

    // ── fixtures, discarded below ─────────────────────────────────────────
    await c.query("SAVEPOINT fixtures");
    const org = (await c.query(`select id from organizations where slug = 'christchurch-international-cup'`)).rows[0];
    if (!org) throw new Error("CIC org not found");
    const comp = (await c.query(`select id from teampay_competitions where organization_id = $1 limit 1`, [org.id])).rows[0];
    if (!comp) throw new Error("no teampay competition under the CIC org to build a fixture on");

    const mkEntry = async () => (await c.query(
      `insert into teampay_entries (competition_id, organization_id, team_name, manager_name, manager_email, fee_cents, squad_size, organiser_token)
       values ($1,$2,'_bridge fixture','Fixture','fixture@example.invalid',100,14,$3) returning id`,
      [comp.id, org.id, "fixture-" + Math.random().toString(36).slice(2)])).rows[0].id;
    const mkReg = async (token: string | null, entryId: number | null) => (await c.query(
      `insert into cic7s_registrations (organization_id, first_name, email, status, enter_token, teampay_entry_id)
       values ($1,'Fixture','fixture@example.invalid','new',$2,$3) returning id`,
      [org.id, token, entryId])).rows[0].id;

    await mustAccept(c, "A. two registrations with no token and no entry", `select 1`);
    await mkReg(null, null); await mkReg(null, null);
    ok("A. …both inserted");

    const e1 = await mkEntry();
    const r1 = await mkReg("tok-one", e1);
    ok("B. registration linked to a real entry");

    await mustRefuse(c, "1. a second registration claiming the same entry",
      `insert into cic7s_registrations (organization_id, first_name, email, status, teampay_entry_id) values ($1,'X','x@example.invalid','new',$2)`, [org.id, e1]);
    await mustRefuse(c, "2. a second registration holding the same token",
      `insert into cic7s_registrations (organization_id, first_name, email, status, enter_token) values ($1,'X','x@example.invalid','new','tok-one')`, [org.id]);

    await c.query(`delete from teampay_entries where id = $1`, [e1]);
    const after = (await c.query(`select teampay_entry_id from cic7s_registrations where id = $1`, [r1])).rows[0];
    if (after && after.teampay_entry_id === null) ok("C. deleting the entry left the registration, link cleared");
    else bad(`C. registration ${after ? "kept a dangling link" : "was deleted with the entry"}`);

    await c.query("ROLLBACK TO SAVEPOINT fixtures");
    const leak = (await c.query(`select count(*)::int as n from cic7s_registrations where first_name = 'Fixture'`)).rows[0].n;
    if (leak === 0) ok("fixtures discarded"); else bad(`${leak} fixture rows survived the savepoint`);

    console.log(`\n  ${checks} checks, ${problems.length} problem(s)`);
    if (problems.length) throw new Error(problems.join("; "));

    if (COMMIT) { await c.query("COMMIT"); console.log("  COMMITTED\n"); }
    else { await c.query("ROLLBACK"); console.log("  rolled back — re-run with --commit to apply.\n"); }
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error(`\n  failed: ${e.message}\n`);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

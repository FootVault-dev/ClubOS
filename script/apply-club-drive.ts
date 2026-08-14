// Apply the Club Drive migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-club-drive.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-club-drive.ts
//
// `--dry-run` runs the migration AND every verification inside a transaction it
// then ROLLS BACK — proving the SQL parses and the invariants hold without
// changing anything. (Prod has schema drift — never `db:push --force`.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-15_club_drive.sql"), "utf8");

// A migration must run on ONE connection — `pool.query` checks out an arbitrary
// client per call, so BEGIN and its SAVEPOINTs can land on different
// connections and the rollback silently applies to nothing.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const db = await pool.connect();

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

try {
  await db.query("BEGIN");
  console.log(`\nClub Drive migration ${DRY_RUN ? "(DRY RUN — will roll back)" : "(APPLYING)"}\n`);
  await db.query(sql);
  console.log("  migration SQL ran\n");

  // ── Structure ─────────────────────────────────────────────────────────────
  const tables = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('drive_nodes','drive_access_log')`,
  );
  check("both tables exist", tables.rows.length === 2, `${tables.rows.length}/2`);

  const view = await db.query(`SELECT 1 FROM information_schema.views WHERE table_name = 'drive_node_gates'`);
  check("drive_node_gates view exists", view.rows.length === 1);

  const rls = await db.query(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('drive_nodes','drive_access_log')`,
  );
  check("RLS enabled on both tables", rls.rows.every((r: any) => r.relrowsecurity === true),
    rls.rows.map((r: any) => `${r.relname}=${r.relrowsecurity}`).join(" "));

  // parent_id must be RESTRICT — a CASCADE here would let one delete take a
  // decade of club records with it.
  const fk = await db.query(`
    SELECT confdeltype FROM pg_constraint
    WHERE conrelid = 'drive_nodes'::regclass AND confrelid = 'drive_nodes'::regclass
  `);
  check("parent_id is ON DELETE RESTRICT", fk.rows.length === 1 && fk.rows[0].confdeltype === "r",
    fk.rows[0]?.confdeltype);

  // ── The invariant that matters: gates accumulate and never release ────────
  const root = await db.query(
    `INSERT INTO drive_nodes (kind, name, required_tab) VALUES ('folder','__t_locked','budget') RETURNING id`,
  );
  const rootId = root.rows[0].id;
  const mid = await db.query(
    `INSERT INTO drive_nodes (parent_id, kind, name) VALUES ($1,'folder','__t_mid') RETURNING id`, [rootId],
  );
  const midId = mid.rows[0].id;
  // A child that tries to be LESS restrictive than its parent.
  const leaf = await db.query(
    `INSERT INTO drive_nodes (parent_id, kind, name, required_tab) VALUES ($1,'file','__t_leaf.pdf', NULL) RETURNING id`,
    [midId],
  );
  const leafId = leaf.rows[0].id;

  const g = await db.query(`SELECT id, gates FROM drive_node_gates WHERE id = ANY($1)`, [[rootId, midId, leafId]]);
  const byId = new Map(g.rows.map((r: any) => [Number(r.id), r.gates as string[]]));
  check("gate on the root folder", (byId.get(rootId) ?? []).includes("budget@"));
  check("gate INHERITS to the middle folder", (byId.get(midId) ?? []).includes("budget@"));
  check("gate INHERITS to a file two levels down", (byId.get(leafId) ?? []).includes("budget@"),
    JSON.stringify(byId.get(leafId)));

  // A second gate deeper down must ADD, not replace.
  await db.query(`UPDATE drive_nodes SET required_tab = 'housing' WHERE id = $1`, [midId]);
  const g2 = await db.query(`SELECT gates FROM drive_node_gates WHERE id = $1`, [leafId]);
  const leafGates: string[] = g2.rows[0].gates;
  check("a deeper gate ADDS to the ancestor's", leafGates.includes("budget@") && leafGates.includes("housing@"),
    JSON.stringify(leafGates));

  // ── Sibling-name uniqueness, and that trashing frees the name ─────────────
  // Each probe that is MEANT to fail runs inside its own SAVEPOINT: a
  // constraint violation aborts the whole transaction otherwise, and every
  // later check would report a misleading "current transaction is aborted"
  // rather than its own result.
  const expectRejection = async (label: string, statement: string, params: any[] = []) => {
    await db.query("SAVEPOINT probe");
    let rejected = false;
    try {
      await db.query(statement, params);
    } catch {
      rejected = true;
    }
    await db.query(rejected ? "ROLLBACK TO SAVEPOINT probe" : "RELEASE SAVEPOINT probe");
    check(label, rejected);
  };

  await expectRejection(
    "duplicate name in the same folder is refused",
    `INSERT INTO drive_nodes (parent_id, kind, name) VALUES ($1,'file','__t_leaf.pdf')`, [midId],
  );

  await db.query(`UPDATE drive_nodes SET trashed_at = now() WHERE id = $1`, [leafId]);
  let reuseOk = true;
  try {
    await db.query(`INSERT INTO drive_nodes (parent_id, kind, name) VALUES ($1,'file','__t_leaf.pdf')`, [midId]);
  } catch (e) { reuseOk = false; console.log("    (reuse error:", (e as any).message, ")"); }
  check("the name frees up once trashed", reuseOk);

  // ── Deleting a folder with children must be refused ───────────────────────
  await expectRejection(
    "deleting a folder with children is refused",
    `DELETE FROM drive_nodes WHERE id = $1`, [rootId],
  );

  if (DRY_RUN) {
    await db.query("ROLLBACK");
    console.log("\nROLLED BACK — nothing changed.\n");
  } else {
    // Clean the probes out before committing for real.
    await db.query(`DELETE FROM drive_nodes WHERE name LIKE '__t_%'`);
    if (failures) {
      await db.query("ROLLBACK");
      console.log(`\n${failures} check(s) FAILED — rolled back, nothing changed.\n`);
    } else {
      await db.query("COMMIT");
      console.log("\nCOMMITTED.\n");
    }
  }
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  console.error("\nMigration failed, rolled back:\n", e);
  failures++;
} finally {
  db.release();
  await pool.end();
}

process.exit(failures ? 1 : 0);

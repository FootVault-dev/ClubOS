// Apply the Equipment Register migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-equipment-register.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-equipment-register.ts
//
// `--dry-run` runs the whole migration AND every verification inside a
// transaction it then ROLLS BACK. Postgres DDL is transactional, so this proves
// the SQL parses, the organizations/contacts/users foreign keys resolve, and
// the partial unique index builds — while changing nothing. There is no local
// Postgres to rehearse against, and a typo found during the real run is a typo
// found with the deploy already half done.
//
// Two of the checks below are BEHAVIOURAL: they insert real rows to prove the
// database itself refuses a second active holder for one team, and that
// retiring the first one frees the team up again. A unique index that exists is
// not the same as a unique index that bites.
//
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "..", "migrations", "2026-08-18_equipment_register.sql"), "utf8");

const TABLES = [
  "equipment_holders",
  "equipment_items",
  "equipment_audit_rounds",
  "equipment_audit_returns",
  "equipment_audit_counts",
  "equipment_audit_reminders",
];

const INDEXES = [
  "equipment_holders_one_active_per_team_unq",
  "equipment_rounds_org_term_unq",
  "equipment_returns_round_holder_unq",
  "equipment_items_holder_idx",
  "equipment_counts_return_idx",
];

// ONE dedicated client for the whole run. A failed statement poisons the
// transaction, and a pool hands the next query a *different* connection —
// which then reports "relation does not exist" several checks later and sends
// you hunting a migration bug that does not exist. Learned on staff-voice.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

let missing = 0;
const check = (ok: boolean, label: string) => {
  if (!ok) missing++;
  console.log(`${ok ? "  ok " : " MISS"}  ${label}`);
};

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await client.query("BEGIN");
  await client.query(sql);

  for (const t of TABLES) {
    const r = await client.query("SELECT to_regclass($1) AS t", [t]);
    check(r.rows[0].t !== null, `table ${t}`);
  }
  for (const idx of INDEXES) {
    const r = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    check(r.rows.length > 0, `index ${idx}`);
  }

  // The one-active-holder index MUST be partial. A plain unique index on
  // (org, team) would reject the *replacement* coordinator for a team whose
  // previous holder was retired — which would look like an app bug rather than
  // a migration bug, and would arrive months later.
  const partial = await client.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname = 'equipment_holders_one_active_per_team_unq'",
  );
  check(/ WHERE /i.test(partial.rows[0]?.indexdef ?? ""), "one-active-holder index is partial");

  // RLS on every new table — a new table defaults to RLS off, and the anon key
  // is public by design.
  const rls = await client.query(
    `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[])`,
    [TABLES],
  );
  for (const row of rls.rows) check(row.relrowsecurity === true, `RLS enabled on ${row.relname}`);

  // ── Behavioural: prove the invariant actually bites ────────────────────────
  const [{ id: orgId }] = (
    await client.query("SELECT id FROM organizations WHERE slug = 'united-sports-group'")
  ).rows;

  const ins = async (team: string, status = "active") =>
    client.query(
      `INSERT INTO equipment_holders (organization_id, team_name, person_name, email, status)
       VALUES ($1, $2, 'Rehearsal Person', 'rehearsal@example.invalid', $3) RETURNING id`,
      [orgId, team, status],
    );

  const first = await ins("REHEARSAL U9");
  check(!!first.rows[0].id, "a first active holder inserts");

  await client.query("SAVEPOINT dup");
  let refused = false;
  try {
    // Same team, different case — the index lower()s the name, so this is the
    // same team as far as the database is concerned.
    await ins("rehearsal u9");
  } catch {
    refused = true;
  }
  // A constraint violation poisons the transaction until we rewind to the
  // savepoint. Without this the rest of the run fails for the wrong reason.
  await client.query("ROLLBACK TO SAVEPOINT dup");
  check(refused, "a SECOND active holder for the same team is refused");

  await client.query("UPDATE equipment_holders SET status = 'inactive' WHERE id = $1", [first.rows[0].id]);
  let replaced = false;
  try {
    await ins("REHEARSAL U9");
    replaced = true;
  } catch {
    replaced = false;
  }
  check(replaced, "retiring the holder frees the team for a replacement");

  // A count with no counted_quantity must be storable — "not counted" is the
  // state a part-way-through audit lives in, and if the column were NOT NULL
  // the whole design would collapse into treating blank as zero.
  const round = await client.query(
    `INSERT INTO equipment_audit_rounds (organization_id, year, term_number, label)
     VALUES ($1, 2999, 1, 'Rehearsal') RETURNING id`,
    [orgId],
  );
  const ret = await client.query(
    `INSERT INTO equipment_audit_returns (organization_id, round_id, holder_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [orgId, round.rows[0].id, first.rows[0].id],
  );
  await client.query(
    `INSERT INTO equipment_audit_counts (organization_id, return_id, item_name, quantity_before, counted_quantity)
     VALUES ($1, $2, 'Rehearsal balls', 22, NULL)`,
    [orgId, ret.rows[0].id],
  );
  const nullCount = await client.query(
    "SELECT counted_quantity FROM equipment_audit_counts WHERE return_id = $1",
    [ret.rows[0].id],
  );
  check(nullCount.rows[0].counted_quantity === null, "an UNCOUNTED line stores as NULL, not 0");

  if (missing) {
    await client.query("ROLLBACK");
    console.error(`\n${missing} check(s) failed — DO NOT DEPLOY.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    await client.query("ROLLBACK");
    console.log("\n✓ Migration is valid. Rolled back — the database is unchanged.");
    console.log("  Re-run without --dry-run to apply it for real.\n");
  } else {
    // The rehearsal rows above are real inserts. Remove them before committing,
    // youngest first so the RESTRICT on returns→holders is never tripped.
    await client.query("DELETE FROM equipment_audit_counts  WHERE item_name = 'Rehearsal balls'");
    await client.query("DELETE FROM equipment_audit_returns WHERE round_id = $1", [round.rows[0].id]);
    await client.query("DELETE FROM equipment_audit_rounds  WHERE id = $1", [round.rows[0].id]);
    await client.query("DELETE FROM equipment_holders WHERE email = 'rehearsal@example.invalid'");
    const left = await client.query(
      "SELECT count(*)::int AS n FROM equipment_holders WHERE email = 'rehearsal@example.invalid'",
    );
    if (left.rows[0].n !== 0) {
      await client.query("ROLLBACK");
      console.error("\nRehearsal rows survived cleanup — rolled back, nothing applied.");
      process.exit(1);
    }
    await client.query("COMMIT");
    console.log("\nAll equipment objects present, invariants proven, rehearsal rows removed. Safe to deploy.\n");
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  throw e;
} finally {
  client.release();
  await pool.end();
}

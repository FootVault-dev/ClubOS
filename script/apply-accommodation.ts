// Apply the accommodation migration. ADDITIVE ONLY.
//
//   Rehearse:  npx tsx --env-file=.env script/apply-accommodation.ts --dry-run
//   Apply:     npx tsx --env-file=.env script/apply-accommodation.ts
//
// `--dry-run` runs the whole migration AND every check inside a transaction it
// then rolls back. Postgres DDL is transactional, so this proves the SQL parses,
// the foreign keys resolve and the partial indexes build, while changing
// nothing. There is no local Postgres to rehearse against.
//
// 🔴 The behavioural checks below insert real rows. Each one that is SUPPOSED to
// fail runs inside its own SAVEPOINT — a constraint violation poisons the whole
// transaction otherwise, and the next query comes back on a different pooled
// connection reporting "relation does not exist" several checks later, which
// looks like a migration bug and is not one.
//
// (Prod has schema drift — never `db:push --force`. Run BEFORE fly deploy.)
import { Pool } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const DRY_RUN = process.argv.includes("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "..", "migrations", "2026-08-18_accommodation.sql"), "utf8");

// 🔴 The migration carries its own BEGIN/COMMIT so it can be pasted straight
// into a SQL console. Left in place, that inner COMMIT ends the transaction
// this script opened — and every statement after it, plus the ROLLBACK meant to
// undo a dry run, then runs in autocommit against the live database. A "dry
// run" that reports success and silently commits is worse than no dry run.
//
// So the wrapper owns the transaction and the file's own markers are stripped.
// (Found the hard way on 2026-08-18. Fourteen migrations in this repo carry
// BEGIN/COMMIT and every apply-*.ts around them has the same hole — see
// outputs/accommodation/2026-08-18-residency-import/00-READ-FIRST.md.)
const sql = raw.replace(/^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$/gim, "-- $1 (owned by apply-accommodation.ts)");
if (/^[ \t]*(BEGIN|COMMIT)[ \t]*;/im.test(sql)) {
  console.error("Refusing to run: a BEGIN/COMMIT survived stripping, so a dry run could not be rolled back.");
  process.exit(1);
}

// One dedicated client for the whole rehearsal, for the reason in the header.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

let failures = 0;
const ok = (pass: boolean, label: string, extra = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "  ok " : " FAIL"}  ${label}${extra ? `  — ${extra}` : ""}`);
};

/** Run something that MUST fail, without poisoning the transaction. */
async function expectFailure(label: string, run: () => Promise<unknown>, wantCode?: string) {
  await client.query("SAVEPOINT chk");
  try {
    await run();
    await client.query("ROLLBACK TO SAVEPOINT chk");
    ok(false, label, "it was allowed");
  } catch (e: any) {
    await client.query("ROLLBACK TO SAVEPOINT chk");
    ok(!wantCode || e.code === wantCode, label, wantCode && e.code !== wantCode ? `wrong error ${e.code}` : `refused (${e.code})`);
  }
}

async function expectSuccess(label: string, run: () => Promise<unknown>) {
  await client.query("SAVEPOINT chk");
  try {
    await run();
    await client.query("RELEASE SAVEPOINT chk");
    ok(true, label);
  } catch (e: any) {
    await client.query("ROLLBACK TO SAVEPOINT chk");
    ok(false, label, `${e.code}: ${e.message}`);
  }
}

try {
  console.log(DRY_RUN ? "\nDRY RUN — everything below is rolled back.\n" : "\nAPPLYING to the database.\n");
  await client.query("BEGIN");
  await client.query(sql);

  // ── Structure ──────────────────────────────────────────────────────────────
  for (const t of ["housing_periods", "housing_roster", "housing_action_items"]) {
    const r = await client.query("SELECT to_regclass($1) AS t", [t]);
    ok(r.rows[0].t !== null, `table ${t}`);
  }

  const newCols: [string, string][] = [
    ["housing_rooms", "default_utilities_cents"], ["housing_rooms", "key_code"],
    ["housing_rooms", "condition_status"], ["housing_rooms", "is_reserve"],
    ["housing_rooms", "bed_config"], ["housing_rooms", "occupant_type"],
    ["housing_rooms", "property_lead"], ["housing_rooms", "source_status"],
    ["housing_tenancies", "period_id"], ["housing_tenancies", "utilities_cents"],
    ["housing_tenancies", "utilities_included"], ["housing_tenancies", "agreement_type"],
    ["housing_tenancies", "is_remuneration"], ["housing_tenancies", "holiday_weeks"],
    ["housing_tenancies", "key_issued"], ["housing_tenancies", "condition_report"],
    ["housing_tenancies", "stated_total_cents"], ["housing_tenancies", "source_ref"],
    ["housing_tenancies", "unconfirmed_house_id"], ["housing_tenancies", "room_conflict_note"],
    ["housing_rent_charges", "period_id"], ["housing_rent_charges", "kind"],
  ];
  for (const [table, col] of newCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name=$2`, [table, col]);
    ok(r.rows.length > 0, `${table}.${col}`);
  }

  for (const idx of [
    "housing_periods_org_name_unq",
    "housing_roster_org_contact_unq",
    "housing_action_items_org_ref_unq",
    "housing_tenancies_source_ref_unq",
  ]) {
    const r = await client.query("SELECT 1 FROM pg_indexes WHERE indexname = $1", [idx]);
    ok(r.rows.length > 0, `index ${idx}`);
  }

  // room_id must now be nullable — the whole disputed-room import depends on it.
  {
    const r = await client.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name='housing_tenancies' AND column_name='room_id'`);
    ok(r.rows[0]?.is_nullable === "YES", "housing_tenancies.room_id is nullable");
  }

  // RLS on the three new tables. A new table defaults to RLS OFF, and the anon
  // key is public by design — off + public key is the whole world reading it.
  for (const t of ["housing_periods", "housing_roster", "housing_action_items"]) {
    const r = await client.query("SELECT relrowsecurity FROM pg_class WHERE relname=$1", [t]);
    ok(r.rows[0]?.relrowsecurity === true, `RLS enabled on ${t}`);
  }

  // ── Behaviour ──────────────────────────────────────────────────────────────
  // Structure proves the columns exist. These prove the rules actually hold.
  const [org] = (await client.query("SELECT id FROM organizations ORDER BY id LIMIT 1")).rows;
  const [house] = (await client.query(
    `INSERT INTO housing_houses (organization_id, name) VALUES ($1,$2) RETURNING id`,
    [org.id, `__rehearsal_${Date.now()}`])).rows;
  const [roomA] = (await client.query(
    `INSERT INTO housing_rooms (house_id, organization_id, name) VALUES ($1,$2,'R1') RETURNING id`,
    [house.id, org.id])).rows;
  const [person] = (await client.query(
    `INSERT INTO contacts (type, first_name, last_name) VALUES ('tenant','Rehearsal','One') RETURNING id`)).rows;
  const [person2] = (await client.query(
    `INSERT INTO contacts (type, first_name, last_name) VALUES ('tenant','Rehearsal','Two') RETURNING id`)).rows;

  const addTenancy = (roomId: number | null, contactId: number, start: string, end: string | null, ref: string | null = null) =>
    client.query(
      `INSERT INTO housing_tenancies (room_id, organization_id, contact_id, start_date, end_date, source_ref)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [roomId, org.id, contactId, start, end, ref]);

  await expectSuccess("a first tenancy in a room is accepted",
    () => addTenancy(roomA.id, person.id, "2026-01-05", "2026-05-25"));

  await expectFailure("two tenants in ONE room over the same dates is refused",
    () => addTenancy(roomA.id, person2.id, "2026-02-01", "2026-03-01"), "23P01");

  await expectSuccess("a tenancy that starts the day after the last one ends is accepted",
    () => addTenancy(roomA.id, person2.id, "2026-05-26", "2026-09-01"));

  // 🔴 The new behaviour the disputed-room import relies on. If NULL room ids
  // collided with each other, only ONE of the four conflicted tenancies could
  // be imported and the rest of that term's money would silently vanish.
  await expectSuccess("two tenancies with NO room, over the same dates, are both accepted", async () => {
    await addTenancy(null, person.id, "2026-06-01", "2026-07-01");
    await addTenancy(null, person2.id, "2026-06-01", "2026-07-01");
  });

  // source_ref is unique per org, but only where it is set — the club's own
  // hand-entered tenancies carry no ref and must not collide with each other.
  await expectSuccess("two tenancies with NO source_ref are both accepted", async () => {
    await addTenancy(null, person.id, "2026-08-01", "2026-08-10", null);
    await addTenancy(null, person2.id, "2026-08-01", "2026-08-10", null);
  });
  await expectSuccess("a tenancy with a source_ref is accepted",
    () => addTenancy(null, person.id, "2026-09-01", "2026-09-10", "REHEARSAL-1"));
  await expectFailure("the SAME source_ref twice in one org is refused",
    () => addTenancy(null, person2.id, "2026-10-01", "2026-10-10", "REHEARSAL-1"), "23505");

  // holiday_weeks carries the club's Christmas deduction — 2 whole weeks today,
  // but a half week is the obvious next thing someone types.
  await expectSuccess("holiday_weeks accepts a fractional week", () =>
    client.query(`UPDATE housing_tenancies SET holiday_weeks = 2.5 WHERE room_id = $1`, [roomA.id]));

  // A person deleted out from under the housing record must be refused, not
  // cascaded — the rent they owed is a financial record.
  await expectFailure("deleting a contact who holds a tenancy is refused",
    () => client.query(`DELETE FROM contacts WHERE id = $1`, [person.id]), "23503");

  await expectSuccess("a roster row is accepted", () =>
    client.query(`INSERT INTO housing_roster (organization_id, contact_id) VALUES ($1,$2)`, [org.id, person.id]));
  await expectFailure("the same person twice on one roster is refused",
    () => client.query(`INSERT INTO housing_roster (organization_id, contact_id) VALUES ($1,$2)`, [org.id, person.id]), "23505");

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED.`}`);

  if (DRY_RUN || failures > 0) {
    await client.query("ROLLBACK");
    console.log(failures > 0 && !DRY_RUN
      ? "Rolled back — the migration was NOT applied because a check failed.\n"
      : "Rolled back — nothing changed.\n");
    process.exit(failures > 0 ? 1 : 0);
  }

  // A real run must not leave the rehearsal rows behind.
  await client.query(`DELETE FROM housing_tenancies WHERE organization_id = $1 AND room_id IN (SELECT id FROM housing_rooms WHERE house_id = $2)`, [org.id, house.id]);
  await client.query(`DELETE FROM housing_tenancies WHERE contact_id IN ($1,$2)`, [person.id, person2.id]);
  await client.query(`DELETE FROM housing_roster WHERE contact_id IN ($1,$2)`, [person.id, person2.id]);
  await client.query(`DELETE FROM housing_rooms WHERE house_id = $1`, [house.id]);
  await client.query(`DELETE FROM housing_houses WHERE id = $1`, [house.id]);
  await client.query(`DELETE FROM contacts WHERE id IN ($1,$2)`, [person.id, person2.id]);

  await client.query("COMMIT");
  console.log("Committed.\n");
} catch (e: any) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("\nFailed, rolled back:", e?.message || e);
  process.exit(1);
} finally {
  client.release();
  await pool.end();
}

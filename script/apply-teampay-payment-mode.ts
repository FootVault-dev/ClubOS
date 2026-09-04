// Apply migrations/2026-09-04_teampay_payment_mode.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-teampay-payment-mode.ts            (dry run)
//   npx tsx --env-file=.env script/apply-teampay-payment-mode.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real checks inside a transaction it then rolls back.
//
// 🔴 The behavioural checks are the point, and most of them are an insert or an
// update that MUST be refused. A constraint you have not watched reject
// something is a comment. What this proves:
//
//   1.  a team payment with no amount            ("Paid — $0.00" on a dashboard)
//   2.  an amount with no paid-at                (money with no moment)
//   3.  a negative team payment
//   4.  a team payment LARGER than the team fee  (the over-collection)
//   5.  resizing a squad after the manager paid  (re-pricing a settled seat)
//   6.  two registrations claiming one entry     (one community, two teams)
//
// And what must be ACCEPTED, each easy to break by accident:
//   A. an entry in 'whole' mode
//   B. every pre-existing entry silently becoming 'split'
//   C. a team payment of exactly the fee        (the ordinary case)
//   D. re-running the whole migration           (idempotency)
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-09-04_teampay_payment_mode.sql";

const problems: string[] = [];
let checks = 0;

function ok(label: string) {
  checks++;
  console.log(`  ✓ ${label}`);
}
function bad(label: string) {
  checks++;
  problems.push(label);
  console.log(`  ✗ ${label}`);
}

/** Run something that MUST fail. A success here is the bug. */
async function mustRefuse(client: pg.Client, label: string, sql: string, params: any[] = []) {
  await client.query("SAVEPOINT s");
  try {
    await client.query(sql, params);
    await client.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ALLOWED, and must not be`);
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT s");
    ok(`refused: ${label}`);
  }
}

/** Run something that must succeed. */
async function mustAccept(client: pg.Client, label: string, sql: string, params: any[] = []) {
  await client.query("SAVEPOINT s");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT s");
    ok(`accepted: ${label}`);
  } catch (e: any) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was REFUSED: ${e.message}`);
  }
}

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  Team Pay — payment mode — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");

  try {
    await client.query(sql);
    console.log("  migration ran\n");

    // ── structure ──────────────────────────────────────────────────────────
    for (const [t, col, type] of [
      ["teampay_entries", "payment_mode", "text"],
      ["teampay_entries", "team_paid_cents", "integer"],
      ["teampay_entries", "team_paid_at", "timestamp without time zone"],
      ["teampay_entries", "team_stripe_payment_intent_id", "text"],
      ["ethnic_cup_registrations", "teampay_entry_id", "integer"],
    ]) {
      const r = await client.query(
        `select data_type from information_schema.columns
          where table_name = $1 and column_name = $2`, [t, col]);
      r.rows[0]?.data_type === type
        ? ok(`${t}.${col} is ${type}`)
        : bad(`${t}.${col} is ${r.rows[0]?.data_type ?? "MISSING"}, expected ${type}`);
    }

    // 🔴 team_paid_cents must have NO default. A default of 0 makes "no team
    // payment" and "a team payment of nothing" the same row — the exact bug
    // already sitting on every camp registration in this database.
    const d = await client.query(
      `select column_default from information_schema.columns
        where table_name = 'teampay_entries' and column_name = 'team_paid_cents'`);
    d.rows[0]?.column_default == null
      ? ok("team_paid_cents has no default — NULL means no payment, not $0")
      : bad(`team_paid_cents defaults to ${d.rows[0].column_default}`);

    // 🔴 payment_mode must NOT have a CHECK. A stale CHECK on an enum-ish
    // column is how the MFL checkout once 500'd.
    const chk = await client.query(
      `select conname from pg_constraint
        where conrelid = 'teampay_entries'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%payment_mode%'`);
    chk.rowCount === 0
      ? ok("payment_mode carries no CHECK — validated in app code")
      : bad(`payment_mode has a CHECK (${chk.rows[0].conname}) — a stale one will 500 a checkout`);

    // ── a real entry to test against ───────────────────────────────────────
    const org = await client.query(`select id from organizations order by id limit 1`);
    const orgId = org.rows[0]?.id;
    const comp = await client.query(
      `select id, fee_cents from teampay_competitions order by id limit 1`);
    if (!orgId || !comp.rowCount) {
      bad("no organization or teampay_competition to test against");
    } else {
      const compId = comp.rows[0].id;
      const FEE = 80000;

      const e = await client.query(
        `insert into teampay_entries
           (competition_id, organization_id, team_name, manager_name, manager_email,
            squad_size, fee_cents, organiser_token)
         values ($1,$2,'ZZ Migration Probe','Probe','probe@example.invalid',16,$3,$4)
         returning id, payment_mode`,
        [compId, orgId, FEE, `probe-${Date.now()}`]);
      const entryId = e.rows[0].id;

      // B — the safety property of the whole migration.
      e.rows[0].payment_mode === "split"
        ? ok("a pre-existing-shaped entry defaults to 'split'")
        : bad(`new entry defaulted to '${e.rows[0].payment_mode}', expected 'split'`);

      // A
      await mustAccept(client, "an entry in 'whole' mode",
        `update teampay_entries set payment_mode = 'whole' where id = $1`, [entryId]);

      // 1, 2
      await mustRefuse(client, "a team payment with no amount",
        `update teampay_entries set team_paid_at = now() where id = $1`, [entryId]);
      await mustRefuse(client, "an amount with no paid-at",
        `update teampay_entries set team_paid_cents = 80000 where id = $1`, [entryId]);

      // 3
      await mustRefuse(client, "a negative team payment",
        `update teampay_entries set team_paid_at = now(), team_paid_cents = -1 where id = $1`, [entryId]);

      // 4 — the one that costs a refund.
      await mustRefuse(client, "a team payment larger than the team fee",
        `update teampay_entries set team_paid_at = now(), team_paid_cents = $2 where id = $1`,
        [entryId, FEE + 1]);

      // C
      await mustAccept(client, "a team payment of exactly the fee",
        `update teampay_entries set team_paid_at = now(), team_paid_cents = $2 where id = $1`,
        [entryId, FEE]);

      // 5 — the new branch of the freeze trigger.
      await mustRefuse(client, "resizing a squad after the manager paid",
        `update teampay_entries set squad_size = 14 where id = $1`, [entryId]);

      // 6 — one community must not end up with two teams in the draw.
      const cicOrg = await client.query(
        `select id from organizations where slug = 'christchurch-international-cup'`);
      if (cicOrg.rowCount) {
        const o = cicOrg.rows[0].id;
        await client.query(
          `insert into ethnic_cup_registrations
             (organization_id, first_name, email, community, teampay_entry_id)
           values ($1,'ZZ Probe A','probe-a@example.invalid','Probe A',$2)`, [o, entryId]);
        await mustRefuse(client, "two registrations claiming the same entry",
          `insert into ethnic_cup_registrations
             (organization_id, first_name, email, community, teampay_entry_id)
           values ($1,'ZZ Probe B','probe-b@example.invalid','Probe B',$2)`, [o, entryId]);

        // NULLs must stay distinct, or only ONE registration could ever exist
        // without an entry — which is every registration on the board today.
        await mustAccept(client, "two registrations with no entry yet",
          `insert into ethnic_cup_registrations
             (organization_id, first_name, email, community)
           values ($1,'ZZ Probe C','probe-c@example.invalid','Probe C'),
                  ($1,'ZZ Probe D','probe-d@example.invalid','Probe D')`, [o]);
      } else {
        bad("CIC organization not found — could not test the registration link");
      }
    }

    // D — idempotency. Running it twice must be a no-op, not an error.
    await mustAccept(client, "re-running the whole migration", sql);

    // 🔴 Nothing this script created may survive, even on --commit. These are
    // probes, not data, and a team called "ZZ Migration Probe" appearing in the
    // Ethnic Cup draw is exactly the kind of thing nobody notices until it is
    // printed on a fixture list.
    const delReg = await client.query(
      `delete from ethnic_cup_registrations where email like 'probe-%@example.invalid'`);
    const delEntry = await client.query(
      `delete from teampay_entries where manager_email = 'probe@example.invalid'`);
    const leftover = await client.query(
      `select count(*)::int n from teampay_entries where manager_email = 'probe@example.invalid'`);
    leftover.rows[0].n === 0
      ? ok(`probes cleaned up (${delEntry.rowCount} entry, ${delReg.rowCount} registrations)`)
      : bad(`${leftover.rows[0].n} probe entries left behind`);

  } catch (e: any) {
    problems.push(`fatal: ${e.message}`);
    console.error(`\n  ✗ fatal: ${e.message}`);
  }

  const clean = problems.length === 0;
  if (COMMIT && clean) {
    await client.query("COMMIT");
    console.log(`\n  ${checks} checks passed — COMMITTED\n`);
  } else {
    await client.query("ROLLBACK");
    console.log(
      clean
        ? `\n  ${checks} checks passed — rolled back. Re-run with --commit to apply.\n`
        : `\n  ${problems.length} problem(s) of ${checks} checks — ROLLED BACK:\n` +
          problems.map((p) => `    · ${p}`).join("\n") + "\n",
    );
  }
  await client.end();
  process.exit(clean ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

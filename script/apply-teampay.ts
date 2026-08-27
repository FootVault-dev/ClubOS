// Apply migrations/2026-08-27_teampay.sql, rehearsing it first.
//
//   npx tsx --env-file=.env script/apply-teampay.ts            (dry run)
//   npx tsx --env-file=.env script/apply-teampay.ts --commit
//
// There is no local Postgres, so a dry run is the only rehearsal available: it
// runs the real DDL and the real checks inside a transaction it then rolls back.
// Additive and idempotent — no existing table is touched.
//
// 🔴 The behavioural checks are the point, and every one of them is an insert
// that MUST be refused. A constraint you have not seen reject something is a
// comment. The list below is the actual reason this is a set of tables and not
// a spreadsheet:
//
//   1.  a competition belonging to both a tournament and a programme
//   2.  a competition belonging to neither
//   3.  a squad member with no email and no phone           (uncontactable)
//   4.  paid with no amount, and an amount with no paid_at  ("Paid — $0.00")
//   5.  a refund larger than the payment
//   6.  removing a player who paid and was never refunded   (the silent drop)
//   7.  two managers on one entry
//   8.  the same person invited twice to one team
//   9.  two teams holding the same fill-in at once          (Isaac's requirement)
//   10. the same fill-in on two rosters
//   11. changing squad size after somebody has paid         (re-pricing a seat)
//   12. a 15th player in a 14-seat squad                    (over-collecting)
//
// And three that must be ACCEPTED, each easy to break by accident:
//   A. a player with a phone and no email      — the group-chat case
//   B. two players on one team with no email   — NULLs must stay distinct
//   C. re-running the whole migration          — idempotency
import { readFileSync } from "fs";
import { join } from "path";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const MIGRATION = "2026-08-27_teampay.sql";

type Client = pg.Client;
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

/** Assert a statement is REFUSED by the database. */
async function mustReject(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  try {
    await c.query(sql, params);
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was ACCEPTED, the database is not enforcing this`);
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT s");
    ok(label);
  }
}

/**
 * Assert a statement is ACCEPTED. Returns the first row.
 *
 * `pg` returns an ARRAY of results for a multi-statement string, so `.rows` is
 * undefined there — reading it blindly turned a passing idempotency check into
 * a failure that looked like a broken migration.
 */
async function mustAccept(c: Client, label: string, sql: string, params: any[] = []) {
  await c.query("SAVEPOINT s");
  let r: any;
  try {
    r = await c.query(sql, params);
  } catch (e: any) {
    await c.query("ROLLBACK TO SAVEPOINT s");
    bad(`${label} — was REFUSED: ${e.message}`);
    return null;
  }
  await c.query("RELEASE SAVEPOINT s");
  ok(label);
  return Array.isArray(r) ? undefined : r?.rows?.[0];
}

async function main() {
  const sql = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(`\n  Team Pay — ${COMMIT ? "COMMIT" : "DRY RUN (rolled back)"}\n`);
  await client.query("BEGIN");

  try {
    await client.query(sql);
    console.log("  migration ran\n");

    // ── structure ──────────────────────────────────────────────────────────
    const TABLES = [
      "teampay_competitions", "teampay_entries", "teampay_players",
      "teampay_fillins", "teampay_fillin_holds", "teampay_events",
    ];
    for (const t of TABLES) {
      const r = await client.query(
        `select 1 from information_schema.tables where table_name = $1`, [t]);
      r.rowCount ? ok(`${t} exists`) : bad(`${t} was not created`);
    }

    // Money is an integer number of cents, never a float.
    for (const [t, col] of [
      ["teampay_competitions", "fee_cents"],
      ["teampay_entries", "fee_cents"],
      ["teampay_players", "paid_cents"],
    ]) {
      const r = await client.query(
        `select data_type from information_schema.columns
          where table_name = $1 and column_name = $2`, [t, col]);
      r.rows[0]?.data_type === "integer"
        ? ok(`${t}.${col} is an integer`)
        : bad(`${t}.${col} is ${r.rows[0]?.data_type ?? "missing"} — money must be cents`);
    }

    // 🔴 paid_cents must have NO default. A default of 0 makes "hasn't paid"
    // and "paid nothing" the same row, which is the bug already sitting on
    // every camp registration in this database.
    const d = await client.query(
      `select column_default, is_nullable from information_schema.columns
        where table_name = 'teampay_players' and column_name = 'paid_cents'`);
    d.rows[0]?.column_default == null
      ? ok("paid_cents has no default — unpaid stays distinct from paid-nothing")
      : bad(`paid_cents defaults to ${d.rows[0].column_default}`);

    // RLS on every table — new tables default to OFF and the anon key is public.
    const rls = await client.query(
      `select relname, relrowsecurity from pg_class
        where relname = any($1) and relkind = 'r'`, [TABLES]);
    for (const row of rls.rows) {
      row.relrowsecurity
        ? ok(`RLS enabled on ${row.relname}`)
        : bad(`RLS is OFF on ${row.relname} — a leaked anon key reads it`);
    }

    // ── fixtures ───────────────────────────────────────────────────────────
    //
    // 🔴 Everything from here to `ROLLBACK TO SAVEPOINT fixtures` is thrown
    // away, on a --commit run as well as a dry run.
    //
    // The first version of this script did not have that savepoint: --commit
    // committed the DDL *and* a fixture tournament and a fixture competition
    // straight into the production database. They were found by probing, not by
    // the script. A rehearsal that leaves its props on the stage is not a
    // rehearsal.
    await client.query("SAVEPOINT fixtures");

    const org = (await client.query(
      `select id from organizations where slug = 'christchurch-international-cup'`)).rows[0];
    if (!org) throw new Error("CIC organisation not found — cannot build fixtures");

    const tour = (await client.query(
      `insert into tournaments (organization_id, name, status)
       values ($1, '__teampay_fixture__', 'draft') returning id`, [org.id])).rows[0];

    const prog = (await client.query(`select id from programs limit 1`)).rows[0];

    const comp = (await client.query(
      `insert into teampay_competitions
         (organization_id, kind, tournament_id, slug, name, fee_cents, default_squad_size)
       values ($1, 'tournament', $2, '__fixture__', 'Fixture Cup', 80000, 14)
       returning id`, [org.id, tour.id])).rows[0];

    const entry = (await client.query(
      `insert into teampay_entries
         (competition_id, organization_id, team_name, manager_name, manager_email,
          squad_size, fee_cents, organiser_token)
       values ($1, $2, 'Fixture FC', 'Manager', 'm@example.com', 14, 80000, 'tok-org-1')
       returning id`, [comp.id, org.id])).rows[0];

    console.log("");

    // ── 1 & 2: a competition has exactly one parent ────────────────────────
    if (prog) {
      await mustReject(client, "a competition cannot belong to a tournament AND a programme",
        `insert into teampay_competitions
           (organization_id, kind, tournament_id, program_id, slug, name, fee_cents)
         values ($1,'tournament',$2,$3,'__both__','Both',1000)`, [org.id, tour.id, prog.id]);
    }
    await mustReject(client, "a competition cannot belong to neither",
      `insert into teampay_competitions (organization_id, kind, slug, name, fee_cents)
       values ($1,'tournament','__neither__','Neither',1000)`, [org.id]);

    // ── 3: a squad member must be contactable ──────────────────────────────
    await mustReject(client, "a squad member with no email and no phone is refused",
      `insert into teampay_players (entry_id, name, invite_token)
       values ($1,'Ghost','tok-ghost')`, [entry.id]);

    // ── A & B: the cases that MUST work ────────────────────────────────────
    const phoneOnly = await mustAccept(client, "a player with a mobile and no email is accepted (the group-chat case)",
      `insert into teampay_players (entry_id, name, phone, invite_token)
       values ($1,'Phone Only','+64211234567','tok-p1') returning id`, [entry.id]);
    await mustAccept(client, "a second player with no email is accepted (NULLs stay distinct)",
      `insert into teampay_players (entry_id, name, phone, invite_token)
       values ($1,'Phone Two','+64217654321','tok-p2') returning id`, [entry.id]);

    // ── 4: paid and the amount travel together ─────────────────────────────
    await mustReject(client, "paid with no amount is refused (no more \"Paid — $0.00\")",
      `insert into teampay_players (entry_id, name, email, invite_token, paid_at)
       values ($1,'NoAmount','na@example.com','tok-na', now())`, [entry.id]);
    await mustReject(client, "an amount with no paid_at is refused",
      `insert into teampay_players (entry_id, name, email, invite_token, paid_cents)
       values ($1,'NoWhen','nw@example.com','tok-nw', 5715)`, [entry.id]);

    const paid = await mustAccept(client, "a paid player with an amount is accepted",
      `insert into teampay_players (entry_id, name, email, invite_token, paid_at, paid_cents)
       values ($1,'Paid Player','paid@example.com','tok-paid', now(), 5715) returning id`, [entry.id]);

    // ── 5: refunds cannot exceed the payment ───────────────────────────────
    await mustReject(client, "a refund larger than the payment is refused",
      `update teampay_players set refunded_cents = 9999, refunded_at = now() where id = $1`, [paid.id]);

    // ── 6: a paid player cannot be silently dropped ────────────────────────
    await mustReject(client, "removing a player who paid and was never refunded is refused",
      `update teampay_players set removed_at = now() where id = $1`, [paid.id]);
    await mustAccept(client, "removing them AFTER a refund is allowed",
      `update teampay_players
          set refunded_cents = paid_cents, refunded_at = now(), removed_at = now()
        where id = $1`, [paid.id]);

    // ── 7: one manager per entry ───────────────────────────────────────────
    await mustAccept(client, "the first manager row is accepted",
      `insert into teampay_players (entry_id, name, email, invite_token, is_manager)
       values ($1,'The Manager','m@example.com','tok-m1', true)`, [entry.id]);
    await mustReject(client, "a second manager on the same entry is refused",
      `insert into teampay_players (entry_id, name, email, invite_token, is_manager)
       values ($1,'Other Manager','m2@example.com','tok-m2', true)`, [entry.id]);

    // ── 8: no double invitations ───────────────────────────────────────────
    await mustReject(client, "inviting the same email to one team twice is refused",
      `insert into teampay_players (entry_id, name, email, invite_token)
       values ($1,'Duplicate','M@EXAMPLE.COM','tok-dup')`, [entry.id]);

    // ── 9 & 10: the fill-in cannot be double-booked ────────────────────────
    const fillin = (await client.query(
      `insert into teampay_fillins
         (competition_id, organization_id, first_name, email, player_token)
       values ($1,$2,'Fill','fill@example.com','tok-f1') returning id`, [comp.id, org.id])).rows[0];

    const entry2 = (await client.query(
      `insert into teampay_entries
         (competition_id, organization_id, team_name, manager_name, manager_email,
          squad_size, fee_cents, organiser_token)
       values ($1,$2,'Rival FC','Rival','r@example.com',14,80000,'tok-org-2')
       returning id`, [comp.id, org.id])).rows[0];

    await mustAccept(client, "the first team's hold on a fill-in is accepted",
      `insert into teampay_fillin_holds (fillin_id, entry_id, hold_token, expires_at)
       values ($1,$2,'tok-h1', now() + interval '48 hours')`, [fillin.id, entry.id]);
    await mustReject(client, "a SECOND team holding the same fill-in is refused (Isaac's double-booking rule)",
      `insert into teampay_fillin_holds (fillin_id, entry_id, hold_token, expires_at)
       values ($1,$2,'tok-h2', now() + interval '48 hours')`, [fillin.id, entry2.id]);
    // 🔴 Released and re-taken as TWO statements, deliberately. Postgres gives
    // every sub-statement of a single command the same snapshot, so an UPDATE
    // inside a CTE is invisible to the INSERT's unique-index check beside it —
    // "release the old hold and take a new one" written as one statement fails
    // every time. The engine releases first, then inserts. (Found here.)
    await client.query(`update teampay_fillin_holds set state='declined' where hold_token='tok-h1'`);
    await mustAccept(client, "once the first hold is declined, another team may ask",
      `insert into teampay_fillin_holds (fillin_id, entry_id, hold_token, expires_at)
       values ($1,$2,'tok-h3', now() + interval '48 hours')`, [fillin.id, entry2.id]);

    await mustAccept(client, "the fill-in joins one team's roster",
      `insert into teampay_players (entry_id, name, email, invite_token, fillin_id, source)
       values ($1,'Fill In','fill@example.com','tok-fp1',$2,'fillin')`, [entry.id, fillin.id]);
    await mustReject(client, "the same fill-in on a SECOND roster is refused",
      `insert into teampay_players (entry_id, name, email, invite_token, fillin_id, source)
       values ($1,'Fill In','fill@example.com','tok-fp2',$2,'fillin')`, [entry2.id, fillin.id]);

    // ── 11: the share cannot be re-priced under a payer ────────────────────
    await mustAccept(client, "squad size can be changed while nobody has paid",
      `update teampay_entries set squad_size = 16 where id = $1`, [entry2.id]);
    await client.query(
      `insert into teampay_players (entry_id, name, email, invite_token, paid_at, paid_cents)
       values ($1,'Early Bird','early@example.com','tok-early', now(), 5000)`, [entry2.id]);
    await mustReject(client, "squad size is FROZEN once a player has paid",
      `update teampay_entries set squad_size = 20 where id = $1`, [entry2.id]);

    // ── 12: a squad cannot exceed its seats ────────────────────────────────
    const small = (await client.query(
      `insert into teampay_entries
         (competition_id, organization_id, team_name, manager_name, manager_email,
          squad_size, fee_cents, organiser_token)
       values ($1,$2,'Tiny FC','T','t@example.com',2,80000,'tok-org-3')
       returning id`, [comp.id, org.id])).rows[0];
    await mustAccept(client, "seat 1 of 2 is accepted",
      `insert into teampay_players (entry_id, name, email, invite_token)
       values ($1,'One','one@example.com','tok-s1')`, [small.id]);
    await mustAccept(client, "seat 2 of 2 is accepted",
      `insert into teampay_players (entry_id, name, email, invite_token)
       values ($1,'Two','two@example.com','tok-s2')`, [small.id]);
    await mustReject(client, "seat 3 of 2 is refused — the club cannot collect more than the team fee",
      `insert into teampay_players (entry_id, name, email, invite_token)
       values ($1,'Three','three@example.com','tok-s3')`, [small.id]);
    // Two statements again, and for the same reason: the capacity trigger's own
    // SELECT cannot see an UPDATE made in a CTE of the statement that fired it.
    await client.query(`update teampay_players set declined_at = now() where invite_token = 'tok-s2'`);
    await mustAccept(client, "a seat freed by a decline can be refilled",
      `insert into teampay_players (entry_id, name, email, invite_token)
       values ($1,'Replacement','rep@example.com','tok-s4')`, [small.id]);

    // ── C: idempotency ─────────────────────────────────────────────────────
    await mustAccept(client, "the whole migration re-runs cleanly (idempotent)", sql);

    // Every fixture above is discarded. The DDL, which ran before the savepoint,
    // survives. This is what makes --commit safe to run against production.
    await client.query("ROLLBACK TO SAVEPOINT fixtures");

    const leftovers = await client.query(
      `select (select count(*) from teampay_competitions)::int c,
              (select count(*) from teampay_entries)::int e,
              (select count(*) from teampay_players)::int p,
              (select count(*) from teampay_fillins)::int f,
              (select count(*) from tournaments where name = '__teampay_fixture__')::int t`);
    const l = leftovers.rows[0];
    l.e === 0 && l.p === 0 && l.f === 0 && l.t === 0
      ? ok("no fixture data survives the rehearsal")
      : bad(`fixtures leaked: ${JSON.stringify(l)}`);

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

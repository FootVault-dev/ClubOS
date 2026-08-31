// A DEMO Team Pay competition, so Daniel can tap through the real thing.
//
//   npx tsx --env-file=.env script/seed-teampay-preview.ts --commit
//   npx tsx --env-file=.env script/seed-teampay-preview.ts --remove --commit
//
// 🔴 This is NOT the Christchurch Ethnic Cup. It is a separate competition with
// its own slug, so the real Cup's three switches stay off and untouched. Deleting
// this one cascades everything it made and leaves the real Cup alone.
//
// The squad is seeded across all three states — one paid, one opened-not-paid,
// the rest not opened — because a dashboard with everybody in the same state
// shows nothing about what the dashboard is for.
//
// 🔴 The "paid" row is written straight to the database with paid_at + paid_cents.
// No charge was made and no Stripe object exists for it. That is the whole point:
// a preview must never move money.
import pg from "pg";
import { randomBytes } from "crypto";

const COMMIT = process.argv.includes("--commit");
const REMOVE = process.argv.includes("--remove");

const SLUG = "preview-ethnic-cup";
const FEE_CENTS = 80000;
const SQUAD = 14;
const SHARE = Math.ceil(FEE_CENTS / SQUAD); // 5715

// Fixed tokens so the preview links never change between re-seeds.
const ORG_TOKEN = "preview" + "0".repeat(25);
const TOK = (n: string) => (n + "0".repeat(32)).slice(0, 32);

async function main() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log(`\n  Team Pay preview — ${REMOVE ? "REMOVE" : "SEED"} — ${COMMIT ? "COMMIT" : "DRY RUN"}\n`);
  await c.query("BEGIN");

  try {
    const org = (await c.query(
      `select id from organizations where slug='christchurch-international-cup'`)).rows[0];

    // Always start clean so a re-seed is idempotent.
    await c.query(`delete from teampay_competitions where slug = $1`, [SLUG]);
    await c.query(`delete from tournaments where name = '__teampay_preview__'`);

    if (REMOVE) {
      console.log("  preview competition and everything under it removed");
      await c.query(COMMIT ? "COMMIT" : "ROLLBACK");
      await c.end();
      return;
    }

    const tour = (await c.query(
      `insert into tournaments (organization_id, name, status, active)
       values ($1,'__teampay_preview__','draft',false) returning id`, [org.id])).rows[0];

    const comp = (await c.query(
      `insert into teampay_competitions
         (organization_id, kind, tournament_id, slug, name, brand, fee_cents, default_squad_size,
          blurb, entries_open, payments_enabled, fillins_open)
       values ($1,'tournament',$2,$3,'Christchurch Ethnic Cup','ethniccup',$4,$5,$6,true,true,true)
       returning id`,
      [org.id, tour.id, SLUG, FEE_CENTS, SQUAD,
       "An eleven-a-side tournament for teams representing Christchurch's communities. " +
       "The team fee is split across your squad — everyone pays their own share."])).rows[0];

    const entry = (await c.query(
      `insert into teampay_entries
         (competition_id, organization_id, team_name, community, manager_name, manager_email,
          manager_phone, squad_size, fee_cents, organiser_token)
       values ($1,$2,'Ethiopian Community FC','Ethiopian community','Amanuel Tesfaye',
               'amanuel@example.com','021 555 0134',$3,$4,$5) returning id`,
      [comp.id, org.id, SQUAD, FEE_CENTS, ORG_TOKEN])).rows[0];

    // paid · opened-not-paid · not-opened · not-opened (phone only)
    const squad: Array<[string, string | null, string | null, string, string]> = [
      ["Amanuel Tesfaye", "amanuel@example.com", "021 555 0134", TOK("mgr"), "paid"],
      ["Bereket Haile",   "bereket@example.com", null,           TOK("opened"), "opened"],
      ["Yonas Abebe",     "yonas@example.com",   null,           TOK("pay"), "new"],
      ["Dawit Mengistu",  "dawit@example.com",   null,           TOK("d"), "new"],
      ["Samuel Girma",    null,                  "022 555 0198", TOK("s"), "new"],
      ["Nahom Tadesse",   "nahom@example.com",   null,           TOK("n"), "new"],
    ];

    for (const [name, email, phone, token, state] of squad) {
      const isMgr = name === "Amanuel Tesfaye";
      await c.query(
        `insert into teampay_players
           (entry_id, name, email, phone, invite_token, is_manager, source,
            first_opened_at, last_opened_at, open_count, nudge_count, last_nudged_at,
            paid_at, paid_cents)
         values ($1,$2,$3,$4,$5,$6,$7,
                 $8,$8,$9,$10,$11,
                 $12,$13)`,
        [entry.id, name, email, phone, token, isMgr, isMgr ? "manager" : "roster",
         state === "new" ? null : new Date(Date.now() - 36 * 3600_000),
         state === "new" ? 0 : 3,
         state === "opened" ? 1 : 0,
         state === "opened" ? new Date(Date.now() - 20 * 3600_000) : null,
         state === "paid" ? new Date(Date.now() - 40 * 3600_000) : null,
         state === "paid" ? SHARE : null]);
    }

    // A pool worth browsing — the context Isaac's spec asks for.
    const pool: Array<[string, string, string, string, string, string, string]> = [
      ["Santiago", "Restrepo", "Midfielder", "Club level", "Colombia, here 3 months",
       "Meet people", "New in town and don't know anyone yet. Happy anywhere in midfield."],
      ["Ravi", "Sharma", "Goalkeeper", "Played socially", "India, 2 years in Christchurch",
       "Just for fun", "Keeper. Played every week back home, looking for a run out."],
      ["Tomás", "Silva", "Forward", "Representative / semi-pro", "Brazil, here since March",
       "Play competitively", "Played state level at home. Fit and available every weekend."],
    ];
    for (const [first, last, pos, ability, from, motive, note] of pool) {
      await c.query(
        `insert into teampay_fillins
           (competition_id, organization_id, first_name, last_name, email, phone,
            position, ability, from_where, motivation, note, player_token)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [comp.id, org.id, first, last, `${first.toLowerCase()}@example.com`, "021 555 0100",
         pos, ability, from, motive, note, randomBytes(16).toString("hex")]);
    }

    const base = "https://app.usg.co.nz";
    console.log(`  Manager dashboard  ${base}/team/${ORG_TOKEN}`);
    console.log(`  A player's page    ${base}/pay/${TOK("pay")}`);
    console.log(`  Enter a team       ${base}/enter/${SLUG}`);
    console.log(`  Fill-in signup     ${base}/fill-in/${SLUG}`);
    console.log(`\n  $${(FEE_CENTS / 100).toFixed(2)} ÷ ${SQUAD} = $${(SHARE / 100).toFixed(2)} each`);
    console.log(`  squad: 1 paid · 1 opened-not-paid · 4 not opened · ${pool.length} in the fill-in pool\n`);

    await c.query(COMMIT ? "COMMIT" : "ROLLBACK");
    console.log(COMMIT ? "  COMMITTED\n" : "  rolled back — re-run with --commit\n");
  } catch (e: any) {
    await c.query("ROLLBACK");
    console.error(`\n  failed: ${e.message}\n`);
    await c.end();
    process.exit(1);
  }
  await c.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

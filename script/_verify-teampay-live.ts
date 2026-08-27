// Team Pay — end-to-end verification against a RUNNING server.
//
//   npx tsx --env-file=.env script/_verify-teampay-live.ts                 (prod)
//   BASE=http://localhost:5000 npx tsx --env-file=.env script/_verify-teampay-live.ts
//
// Drives the real HTTP endpoints the way a manager and a player would, then
// deletes everything it made. It builds its OWN throwaway competition rather
// than touching the real Ethnic Cup — a verification run must never open
// entries on a live tournament for the seconds it takes to test them, and must
// never leave a fixture behind (an earlier version of the migration applier did
// exactly that, and it went unnoticed until someone went looking).
//
// 🔴 Uses curl, not fetch. Node's outbound fetch is dead on this Mac, which is
// what once let the deploy guard print "Safe to deploy" while reaching nothing.
import { execFileSync } from "child_process";
import pg from "pg";
import { shareCents } from "../shared/teampay";

const BASE = process.env.BASE || "https://app.usg.co.nz";
const SLUG = `__verify-teampay-${Date.now().toString(36)}`;
const FEE_CENTS = 80000;
const SQUAD = 14;

let pass = 0;
const fails: string[] = [];
function ok(m: string) { pass++; console.log(`  ✓ ${m}`); }
function bad(m: string) { fails.push(m); console.log(`  ✗ ${m}`); }
function check(cond: boolean, m: string) { cond ? ok(m) : bad(m); }

function http(method: string, path: string, body?: unknown): { status: number; json: any } {
  const args = ["-s", "-o", "/dev/stdout", "-w", "\n%{http_code}", "-X", method, `${BASE}${path}`, "--max-time", "25"];
  if (body !== undefined) args.push("-H", "Content-Type: application/json", "-d", JSON.stringify(body));
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const nl = out.lastIndexOf("\n");
  const status = Number(out.slice(nl + 1).trim());
  let json: any = null;
  try { json = JSON.parse(out.slice(0, nl)); } catch { /* html or empty */ }
  return { status, json };
}

async function main() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  console.log(`\n  Team Pay — live verification against ${BASE}\n`);

  let compId: number | undefined;
  let tourId: number | undefined;

  try {
    // ── the real Ethnic Cup, untouched ────────────────────────────────────
    const real = http("GET", "/api/public/teampay/competition/ethnic-cup-2026");
    check(real.status === 200, "the Ethnic Cup competition is served publicly");
    check(real.json?.feeCents === 80000, `the team fee is $800 (got ${real.json?.feeCents})`);
    check(real.json?.paymentsEnabled === false,
      "🔴 payments are OFF on the real Cup — no money until the venue is confirmed");
    check(real.json?.brand === "ethniccup", "it renders in the Ethnic Cup brand");

    const badSlug = http("GET", "/api/public/teampay/competition/no-such-cup");
    check(badSlug.status === 404, "an unknown competition 404s");

    // ── staff routes are gated ────────────────────────────────────────────
    check(http("GET", "/api/admin/teampay/overview").status === 401,
      "the staff board refuses an unauthenticated caller");

    // ── a throwaway competition to drive the flow ─────────────────────────
    const org = (await db.query(`select id from organizations where slug='christchurch-international-cup'`)).rows[0];
    tourId = (await db.query(
      `insert into tournaments (organization_id, name, status) values ($1,$2,'draft') returning id`,
      [org.id, `__verify_teampay_${SLUG}`])).rows[0].id;
    compId = (await db.query(
      `insert into teampay_competitions
         (organization_id, kind, tournament_id, slug, name, brand, fee_cents, default_squad_size,
          entries_open, payments_enabled, fillins_open)
       values ($1,'tournament',$2,$3,'Verification Cup','ethniccup',$4,$5,true,true,true)
       returning id`, [org.id, tourId, SLUG, FEE_CENTS, SQUAD])).rows[0].id;

    // ── entering a team ───────────────────────────────────────────────────
    const enter = http("POST", `/api/public/teampay/competition/${SLUG}/enter`, {
      teamName: "Verification FC", community: "QA",
      managerName: "Test Manager", managerEmail: `verify+mgr@example.com`,
      squadSize: SQUAD, managerPlays: true,
    });
    check(enter.status === 200 && !!enter.json?.dashboardUrl,
      "a team can be entered with no card and no login");

    const orgToken = String(enter.json?.dashboardUrl || "").split("/team/")[1] || "";
    check(orgToken.length === 32, `the dashboard token is 128 random bits (${orgToken.length} chars)`);

    const dash = http("GET", `/api/public/teampay/team/${orgToken}`);
    check(dash.status === 200, "the manager's dashboard loads from its token alone");
    check(dash.json?.shareCents === shareCents(FEE_CENTS, SQUAD),
      `the share is ${shareCents(FEE_CENTS, SQUAD)}c — computed the same way on both sides`);
    check(dash.json?.players?.length === 1 && dash.json.players[0].isManager,
      "the manager is on their own squad and owes a share like everyone else");
    check(dash.json.players[0].status === "invited",
      "🔴 a brand-new player reads 'Not opened', not 'unknown' and not 'unpaid'");

    check(http("GET", `/api/public/teampay/team/${"0".repeat(32)}`).status === 404,
      "a wrong dashboard token 404s — it never says whether one exists");

    // ── the roster ────────────────────────────────────────────────────────
    const add = http("POST", `/api/public/teampay/team/${orgToken}/players`, {
      players: [
        { name: "Emailed Player", email: "verify+p1@example.com" },
        { name: "Phone Only Player", phone: "+64211234567" },
        { name: "No Contact At All" },
        { name: "Emailed Player Again", email: "VERIFY+P1@example.com" },
      ],
    });
    check(add.json?.added === 2, `two valid players added (got ${add.json?.added})`);
    const reasons = (add.json?.rejected ?? []).map((r: any) => r.reason).join(" | ");
    check(/email or a mobile/i.test(reasons), "a player with no way to contact them is refused, with a reason");
    check(/[Aa]lready on your squad/.test(reasons), "the same email twice is refused, case-insensitively");

    // ── the three statuses ────────────────────────────────────────────────
    const d2 = http("GET", `/api/public/teampay/team/${orgToken}`);
    const emailed = d2.json.players.find((p: any) => p.name === "Emailed Player");
    check(emailed?.status === "invited", "an added player starts at 'Not opened'");
    check(typeof emailed?.payUrl === "string" && emailed.payUrl.includes("/pay/"),
      "each player gets their OWN link, not a shared one");

    const inviteToken = emailed.payUrl.split("/pay/")[1];

    // 🔴 The open ping is a POST for a reason. Prove a GET does NOT mark it.
    http("GET", `/api/public/teampay/pay/${inviteToken}`);
    const afterGet = http("GET", `/api/public/teampay/team/${orgToken}`)
      .json.players.find((p: any) => p.name === "Emailed Player");
    check(afterGet.status === "invited",
      "🔴 fetching the link does NOT mark it opened — a mail scanner is not a player");

    check(http("POST", `/api/public/teampay/pay/${inviteToken}/opened`).status === 200,
      "the page reports its own open once it has mounted");
    const afterPost = http("GET", `/api/public/teampay/team/${orgToken}`)
      .json.players.find((p: any) => p.name === "Emailed Player");
    check(afterPost.status === "opened", "and only then does the manager see 'Opened, not paid'");
    check(afterPost.openCount === 1, "opens are counted");

    // ── the player's own page ─────────────────────────────────────────────
    const pv = http("GET", `/api/public/teampay/pay/${inviteToken}`);
    check(pv.status === 200, "the player's page loads from their token");
    check(pv.json?.you?.shareCents === shareCents(FEE_CENTS, SQUAD), "they are quoted the same share");
    check(pv.json?.team?.managerName === "Test Manager", "they can see whose team it is");
    check(!("email" in (pv.json?.you ?? {})), "the player page does not echo other people's details");

    // ── money ─────────────────────────────────────────────────────────────
    const intent = http("POST", `/api/public/teampay/pay/${inviteToken}/intent`);
    check(intent.status === 200 && !!intent.json?.clientSecret,
      "a PaymentIntent is minted for the player");
    check(intent.json?.amountCents === shareCents(FEE_CENTS, SQUAD),
      "🔴 the amount is computed on the SERVER from the team fee");

    const spoof = http("POST", `/api/public/teampay/pay/${inviteToken}/intent`, { amountCents: 1 });
    check(spoof.json?.amountCents === shareCents(FEE_CENTS, SQUAD),
      "🔴 a request naming its own price of $0.01 is charged the real share");

    const secondIntent = http("POST", `/api/public/teampay/pay/${inviteToken}/intent`);
    check(
      String(secondIntent.json?.clientSecret || "").split("_secret_")[0] ===
      String(intent.json?.clientSecret || "").split("_secret_")[0],
      "🔴 asking twice re-uses the SAME intent — a double tap is a retry, not a second charge");

    // ── squad size ────────────────────────────────────────────────────────
    check(http("PATCH", `/api/public/teampay/team/${orgToken}/squad-size`, { squadSize: 20 }).status === 200,
      "squad size can be changed while nobody has paid");
    check(http("PATCH", `/api/public/teampay/team/${orgToken}/squad-size`, { squadSize: 2 }).status === 400,
      "it cannot be set below the players already on the roster");
    check(http("PATCH", `/api/public/teampay/team/${orgToken}/squad-size`, { squadSize: 999 }).status === 400,
      "and not to an absurd number");
    http("PATCH", `/api/public/teampay/team/${orgToken}/squad-size`, { squadSize: SQUAD });

    // ── nudging ───────────────────────────────────────────────────────────
    const n1 = http("POST", `/api/public/teampay/team/${orgToken}/players/${emailed.id}/nudge`);
    // Sending may legitimately fail outside NZ hours or with no Resend key; both
    // are reported honestly rather than as a success.
    check(n1.status === 200 || /sending hours|couldn't get that email/i.test(n1.json?.message || ""),
      `a nudge either sends or says why not (${n1.status}: ${n1.json?.message ?? "sent"})`);
    if (n1.status === 200) {
      const n2 = http("POST", `/api/public/teampay/team/${orgToken}/players/${emailed.id}/nudge`);
      check(n2.status === 400, "🔴 a second nudge inside the cooling-off window is refused");
    }

    const paidRow = (await db.query(
      `select id from teampay_players where entry_id = (select id from teampay_entries where organiser_token=$1)
        and name = 'Phone Only Player'`, [orgToken])).rows[0];
    const nudgePhone = http("POST", `/api/public/teampay/team/${orgToken}/players/${paidRow.id}/nudge`);
    check(nudgePhone.status === 400 && /mobile/i.test(nudgePhone.json?.message || ""),
      "a player with only a mobile is not silently skipped — the manager is told to text them");

    // ── the fill-in marketplace ───────────────────────────────────────────
    const f1 = http("POST", `/api/public/teampay/competition/${SLUG}/fill-in`, {
      firstName: "Fill", lastName: "In", email: "verify+fill@example.com",
      phone: "+64277654321", position: "Midfielder", ability: "Club level",
      fromWhere: "Colombia, here 3 months", motivation: "Meet people",
    });
    check(f1.status === 200, "a player with no team can join the fill-in list");

    const browse = http("GET", `/api/public/teampay/team/${orgToken}/fill-ins`);
    check(browse.status === 200 && browse.json.fillins.length >= 1, "a manager can browse the pool");
    const listed = browse.json.fillins[0];
    check(listed.firstName === "Fill", "they see the player's first name");
    check(!("email" in listed) && !("phone" in listed) && !("lastName" in listed),
      "🔴 no email, phone or surname reaches the browse list — entering a team costs nothing, so it is not a gate");
    check(listed.fromWhere === "Colombia, here 3 months",
      "the context Isaac asked for IS there — newcomers with nobody to form a team with");

    const req1 = http("POST", `/api/public/teampay/team/${orgToken}/fill-ins/${listed.id}/request`,
      { note: "We train Tuesdays" });
    check(req1.status === 200, "a manager can ask them to join");

    // A second team asking the same player must be refused.
    const enter2 = http("POST", `/api/public/teampay/competition/${SLUG}/enter`, {
      teamName: "Rival FC", managerName: "Rival", managerEmail: "verify+rival@example.com", squadSize: SQUAD,
    });
    const orgToken2 = String(enter2.json?.dashboardUrl || "").split("/team/")[1];
    const req2 = http("POST", `/api/public/teampay/team/${orgToken2}/fill-ins/${listed.id}/request`, {});
    check(req2.status === 400, "🔴 a second team cannot claim the same fill-in — Isaac's double-booking rule");
    check(http("GET", `/api/public/teampay/team/${orgToken2}/fill-ins`).json.fillins.length === 0,
      "and they vanish from everyone else's list while held");

    const holdToken = (await db.query(
      `select hold_token from teampay_fillin_holds where state='active' order by id desc limit 1`)).rows[0].hold_token;
    const hv = http("GET", `/api/public/teampay/hold/${holdToken}`);
    check(hv.status === 200 && hv.json.team?.name === "Verification FC", "the player sees who is asking");
    check(hv.json.team?.managerEmail === null,
      "🔴 the manager's contact details are withheld until the player says yes");
    check(hv.json.shareCents === shareCents(FEE_CENTS, SQUAD), "and what it would cost them");

    const acc = http("POST", `/api/public/teampay/hold/${holdToken}/accept`);
    check(acc.status === 200 && !!acc.json?.payUrl, "accepting puts them on the squad with their own link");
    check(http("GET", `/api/public/teampay/hold/${holdToken}`).json.team?.managerEmail === "verify+mgr@example.com",
      "🔴 contact details are exchanged at the moment of consent, and not before");
    check(http("POST", `/api/public/teampay/hold/${holdToken}/accept`).status === 400,
      "accepting twice is refused — one roster row, not two");

    // ── declining ─────────────────────────────────────────────────────────
    const dec = http("POST", `/api/public/teampay/pay/${inviteToken}/decline`);
    check(dec.status === 200, "a player can say they can't play");
    const afterDecline = http("GET", `/api/public/teampay/team/${orgToken}`);
    const declined = afterDecline.json.players.find((p: any) => p.name === "Emailed Player");
    check(declined.status === "declined", "the manager sees it immediately");
    check(afterDecline.json.money.outstandingCents === FEE_CENTS,
      "🔴 the team still owes the whole fee — a player dropping out does not reduce it");

  } finally {
    // Everything cascades from the competition and the tournament.
    if (compId) await db.query(`delete from teampay_competitions where id = $1`, [compId]);
    if (tourId) await db.query(`delete from tournaments where id = $1`, [tourId]);
    const left = (await db.query(
      `select count(*)::int n from teampay_entries where competition_id = $1`, [compId ?? 0])).rows[0].n;
    check(left === 0, "the verification cleans up after itself");
    await db.end();
  }

  console.log(
    fails.length
      ? `\n  ${fails.length} FAILED of ${pass + fails.length}:\n` + fails.map((f) => `    · ${f}`).join("\n") + "\n"
      : `\n  ${pass} checks passed.\n`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

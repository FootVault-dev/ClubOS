// Prove, against LIVE production, that both ways of paying work and that
// neither can collect more than the team fee.
//
//   npx tsx --env-file=.env script/_verify-teampay-modes-live.ts
//
// 🔴 This creates REAL entries on production and deletes them at the end. It
// never confirms a payment, so no card is ever charged and no money moves — it
// asserts on the AMOUNT the server would charge, which is the thing that can be
// wrong by a factor that costs a refund.
//
// Why against prod rather than a local server: there is no local Postgres, the
// switches live in the production database, and the failure this is guarding
// against (a charge computed from the wrong number) is only interesting where
// real cards are. The entries it makes are named so a human scanning the board
// can see instantly what they are.
import pg from "pg";

const BASE = process.env.TEAMPAY_VERIFY_BASE || "https://app.usg.co.nz";
const SLUG = "ethnic-cup-2026";
const MARK = `ZZ VERIFY ${Date.now()}`;

const problems: string[] = [];
let checks = 0;

function ok(l: string) { checks++; console.log(`  ✓ ${l}`); }
function bad(l: string) { checks++; problems.push(l); console.log(`  ✗ ${l}`); }
function eq(label: string, actual: unknown, expected: unknown) {
  actual === expected ? ok(`${label} = ${String(actual)}`)
                      : bad(`${label} = ${String(actual)}, expected ${String(expected)}`);
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

async function enterTeam(name: string, paymentMode: string, squadSize: number) {
  const r = await api(`/api/public/teampay/competition/${SLUG}/enter`, {
    method: "POST",
    body: JSON.stringify({
      teamName: `${MARK} ${name}`,
      community: "Verification",
      managerName: "Verify Manager",
      managerEmail: `verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.invalid`,
      squadSize,
      managerPlays: false,
      paymentMode,
    }),
  });
  if (r.status !== 200) throw new Error(`enter failed ${r.status}: ${JSON.stringify(r.body)}`);
  // The dashboard URL ends in the organiser token.
  return String(r.body.dashboardUrl).split("/").pop()!;
}

async function main() {
  console.log(`\n  Team Pay — both ways of paying, against ${BASE}\n`);

  const comp = (await api(`/api/public/teampay/competition/${SLUG}`)).body;
  const FEE = comp.feeCents;
  console.log(`  ${comp.name} — ${money(FEE)} per team\n`);

  eq("entries are open", comp.entriesOpen, true);
  eq("payments are on", comp.paymentsEnabled, true);

  const tokens: string[] = [];

  try {
    // ── 1. whole mode: the manager is asked for the entire fee ──────────────
    console.log(`\n  whole mode`);
    const whole = await enterTeam("whole", "whole", 16);
    tokens.push(whole);

    const wd = (await api(`/api/public/teampay/team/${whole}`)).body;
    eq("mode stored", wd.entry.paymentMode, "whole");
    eq("manager is asked for the whole fee", wd.teamChargeCents, FEE);
    eq("outstanding is the whole fee", wd.money.outstandingCents, FEE);

    const wi = await api(`/api/public/teampay/team/${whole}/pay-intent`, { method: "POST" });
    eq("team pay-intent status", wi.status, 200);
    eq("team intent amount", wi.body.amountCents, FEE);
    wi.body.clientSecret ? ok("team intent returned a client secret") : bad("no client secret");

    // 🔴 The one that costs a double charge: a player on a whole-mode team must
    // be asked for NOTHING, and must be told why rather than shown a card form.
    await api(`/api/public/teampay/team/${whole}/players`, {
      method: "POST",
      body: JSON.stringify({ players: [{ name: "Verify Player", email: `vp-${Date.now()}@example.invalid` }] }),
    });
    const wd2 = (await api(`/api/public/teampay/team/${whole}`)).body;
    const playerToken = String(wd2.players[0].payUrl).split("/").pop()!;

    const pv = (await api(`/api/public/teampay/pay/${playerToken}`)).body;
    eq("player is charged nothing in whole mode", pv.you.chargeCents, 0);
    eq("player page knows the mode", pv.team.paymentMode, "whole");

    const pi = await api(`/api/public/teampay/pay/${playerToken}/intent`, { method: "POST" });
    eq("player intent is REFUSED in whole mode", pi.status, 409);
    String(pi.body.message || "").toLowerCase().includes("manager")
      ? ok(`player told why: "${pi.body.message}"`)
      : bad(`unhelpful refusal: "${pi.body.message}"`);

    // ── 2. split mode: each player is asked for their share ─────────────────
    console.log(`\n  split mode`);
    const split = await enterTeam("split", "split", 16);
    tokens.push(split);

    const sd = (await api(`/api/public/teampay/team/${split}`)).body;
    const SHARE = Math.ceil(FEE / 16);
    eq("mode stored", sd.entry.paymentMode, "split");
    eq("share is fee ÷ squad", sd.shareCents, SHARE);
    eq("manager can still clear the balance", sd.teamChargeCents, FEE);

    await api(`/api/public/teampay/team/${split}/players`, {
      method: "POST",
      body: JSON.stringify({ players: [{ name: "Verify Split", email: `vs-${Date.now()}@example.invalid` }] }),
    });
    const sd2 = (await api(`/api/public/teampay/team/${split}`)).body;
    const spToken = String(sd2.players[0].payUrl).split("/").pop()!;

    const spi = await api(`/api/public/teampay/pay/${spToken}/intent`, { method: "POST" });
    eq("player intent status", spi.status, 200);
    eq("player is charged their share", spi.body.amountCents, SHARE);

    // ── 3. switching mode re-prices the ASK, never the debt ─────────────────
    console.log(`\n  switching`);
    const sw = await api(`/api/public/teampay/team/${split}/payment-mode`, {
      method: "PATCH", body: JSON.stringify({ paymentMode: "whole" }),
    });
    eq("switch to whole accepted", sw.status, 200);
    const sd3 = (await api(`/api/public/teampay/team/${split}`)).body;
    eq("still owes the same fee after switching", sd3.money.outstandingCents, FEE);
    const spi2 = await api(`/api/public/teampay/pay/${spToken}/intent`, { method: "POST" });
    eq("that same player is now refused", spi2.status, 409);

    const back = await api(`/api/public/teampay/team/${split}/payment-mode`, {
      method: "PATCH", body: JSON.stringify({ paymentMode: "split" }),
    });
    eq("switch back accepted", back.status, 200);
    const spi3 = await api(`/api/public/teampay/pay/${spToken}/intent`, { method: "POST" });
    eq("player is asked again, same amount", spi3.body.amountCents, SHARE);

    // ── 4. a nonsense mode is refused ───────────────────────────────────────
    const junk = await api(`/api/public/teampay/team/${split}/payment-mode`, {
      method: "PATCH", body: JSON.stringify({ paymentMode: "free" }),
    });
    eq("an unknown payment mode is refused", junk.status, 400);

    // ── 5. the browser cannot name its own price ────────────────────────────
    const cheeky = await api(`/api/public/teampay/team/${whole}/pay-intent`, {
      method: "POST", body: JSON.stringify({ amountCents: 100 }),
    });
    eq("a browser-supplied amount is ignored", cheeky.body.amountCents, FEE);

  } catch (e: any) {
    bad(`fatal: ${e.message}`);
  } finally {
    // 🔴 Always clean up, even on failure. A verification run must not leave
    // "ZZ VERIFY" teams sitting in the Ethnic Cup draw.
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const del = await client.query(
      `delete from teampay_entries where team_name like $1`, [`${MARK}%`]);
    const left = await client.query(
      `select count(*)::int n from teampay_entries where team_name like 'ZZ VERIFY%'`);
    left.rows[0].n === 0
      ? ok(`cleaned up (${del.rowCount} entries removed)`)
      : bad(`${left.rows[0].n} ZZ VERIFY entries left on production`);
    await client.end();
  }

  console.log(
    problems.length === 0
      ? `\n  ${checks} checks passed against live production.\n`
      : `\n  ${problems.length} problem(s) of ${checks}:\n` + problems.map((p) => `    · ${p}`).join("\n") + "\n",
  );
  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

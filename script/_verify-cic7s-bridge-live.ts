// Live check of the CIC 7's interest → Team Pay bridge, against PRODUCTION.
//
//   npx tsx --env-file=.env script/_verify-cic7s-bridge-live.ts
//   PROBE_ORIGIN=https://join.cicyouth.com  (default)
//
// Walks the exact path a manager takes from cic7s.com: register interest, get a
// token, spend it to create a team, be handed a team page. Then deletes what it
// made. It sends ONE real "New CIC 7's registration" email to info@cic7s.com
// (named as a probe) and one team-page email to delivered@resend.dev.
//
// ⚠️ node's fetch is intermittently dead on this Mac while curl works
// (reference_clubos_node_fetch_broken). If every check fails with a network
// error, that is the Mac, not production — re-run with curl by hand.
import pg from "pg";

const ORIGIN = process.env.PROBE_ORIGIN || "https://join.cicyouth.com";
const APP = "https://app.usg.co.nz";
const SLUG = "cic-summer-7s-2027";
const SITE = "https://cic7s.com";

let n = 0; const fails: string[] = [];
const ok = (l: string) => { n++; console.log(`  ✓ ${l}`); };
const bad = (l: string) => { n++; fails.push(l); console.log(`  ✗ ${l}`); };
const check = (cond: boolean, l: string) => (cond ? ok(l) : bad(l));

async function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method, headers: { "Content-Type": "application/json", Origin: SITE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null; try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, headers: r.headers, json };
}

async function main() {
  console.log(`\n  CIC 7's bridge — live against ${ORIGIN}\n`);

  // 1. the competition is there, open, priced, branded
  const comp = await req("GET", `${APP}/api/public/teampay/competition/${SLUG}`);
  check(comp.status === 200, `competition ${SLUG} answers 200 (got ${comp.status})`);
  check(comp.json?.brand === "cic7s", `brand is cic7s (got ${comp.json?.brand})`);
  check(comp.json?.feeCents === 99000, `fee is $990 (got ${comp.json?.feeCents})`);
  check(comp.json?.defaultSquadSize === 14, `default squad 14 (got ${comp.json?.defaultSquadSize})`);
  check(comp.json?.entriesOpen === true, `entries OPEN`);
  check(comp.json?.paymentsEnabled === true, `payments ON`);
  check(comp.json?.fillinsOpen === false, `fill-ins shut`);

  // 2. CORS for the site
  const opt = await req("OPTIONS", `${ORIGIN}/api/public/cic7s/register-interest`);
  check(opt.status === 204, `OPTIONS register-interest → 204 (got ${opt.status})`);
  check(opt.headers.get("access-control-allow-origin") === SITE, `CORS allows ${SITE}`);
  const opt2 = await req("OPTIONS", `${ORIGIN}/api/public/cic7s/register-interest/probe/enter`);
  check(opt2.status === 204, `OPTIONS …/enter → 204 (got ${opt2.status})`);

  // 3. register interest → token
  const reg = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest`, {
    firstName: "Probe", lastName: "(automated test — ignore)", email: "delivered@resend.dev",
    phone: "+64210000000", location: "Christchurch", category: "Social",
    sourceUrl: "verify-script", eventId: `probe_${Date.now()}`,
    utm_source: "probe", utm_campaign: "verify-cic7s-bridge",
  });
  check(reg.status === 200 && reg.json?.ok === true, `register-interest → 200 ok`);
  const token: string | undefined = reg.json?.token;
  check(typeof token === "string" && /^[a-f0-9]{32}$/.test(token || ""), `…and hands back a 32-hex token`);

  // 4. the bridge refuses what it should
  const bogus = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest/${"0".repeat(32)}/enter`, { teamName: "x", paymentMode: "whole" });
  check(bogus.status === 404, `unknown token → 404 (got ${bogus.status})`);
  const idish = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest/1/enter`, { teamName: "x" });
  check(idish.status === 404, `a row id in place of a token → 404 (got ${idish.status})`);
  if (!token) { finish(); return; }
  const noName = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest/${token}/enter`, { paymentMode: "whole" });
  check(noName.status === 400, `no team name → 400 (got ${noName.status})`);

  // 5. spend the token
  const enter = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest/${token}/enter`, { teamName: "_probe cic7s bridge", paymentMode: "whole" });
  check(enter.status === 200 && enter.json?.ok === true, `enter (whole) → 200 ok (got ${enter.status} ${JSON.stringify(enter.json)})`);
  const dash: string | undefined = enter.json?.dashboardUrl;
  const entryId: number | undefined = enter.json?.entryId;
  check(typeof dash === "string" && dash.startsWith(`${APP}/team/`), `…with a team page URL on ${APP}`);

  // 6. idempotent: a second tap opens the SAME team page, makes no second team
  const again = await req("POST", `${ORIGIN}/api/public/cic7s/register-interest/${token}/enter`, { teamName: "_probe second tap", paymentMode: "split" });
  check(again.status === 200 && again.json?.existing === true && again.json?.dashboardUrl === dash, `second tap → same team page, existing:true`);

  // 7. the team page and its data
  if (dash) {
    const page = await fetch(dash);
    check(page.status === 200, `team page answers 200`);
    const t = dash.split("/team/")[1];
    const team = await req("GET", `${APP}/api/public/teampay/team/${t}`);
    check(team.status === 200, `team API answers 200`);
    const e = team.json?.entry ?? team.json;
    check(e?.paymentMode === "whole", `payment mode is whole (got ${e?.paymentMode})`);
    check(e?.feeCents === 99000, `entry fee copied as $990 (got ${e?.feeCents})`);
    check(e?.community === "Social", `category carried as community (got ${e?.community})`);
    check(e?.managerEmail === "delivered@resend.dev", `manager email from the registration`);
  }

  // 8. the registration row is linked
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const row = (await c.query(`select id, status, teampay_entry_id from cic7s_registrations where enter_token = $1`, [token])).rows[0];
    check(!!row, `registration row found by token`);
    check(row?.status === "entered", `status is 'entered' (got ${row?.status})`);
    check(row?.teampay_entry_id === entryId, `teampay_entry_id = ${entryId} (got ${row?.teampay_entry_id})`);

    // cleanup — children of the entry first, discovered from the FKs
    if (entryId) {
      const kids = (await c.query(`
        select cl.relname as tbl, att.attname as col
          from pg_constraint con
          join pg_class cl on cl.oid = con.conrelid
          join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
         where con.contype = 'f' and con.confrelid = 'teampay_entries'::regclass`)).rows as { tbl: string; col: string }[];
      for (const k of kids) {
        if (k.tbl === "cic7s_registrations") continue; // ON DELETE SET NULL; we delete the row itself below
        await c.query(`delete from ${k.tbl} where ${k.col} = $1`, [entryId]);
      }
      await c.query(`delete from teampay_entries where id = $1`, [entryId]);
    }
    if (row?.id) await c.query(`delete from cic7s_registrations where id = $1`, [row.id]);
    const left = (await c.query(`select count(*)::int as n from cic7s_registrations where enter_token = $1`, [token])).rows[0].n;
    check(left === 0, `probe rows deleted`);
  } finally { await c.end(); }

  finish();
}

function finish() {
  console.log(`\n  ${n} checks, ${fails.length} failed${fails.length ? ":\n   - " + fails.join("\n   - ") : ""}\n`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

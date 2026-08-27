/**
 * Team Pay in a real browser, at phone and desktop sizes.
 *
 *   BASE=http://localhost:5199 npx tsx --env-file=.env script/_verify-teampay-browser.ts
 *
 * These pages are opened by members of the public, on their phones, from a link
 * in an email, usually once. Nobody will file a bug — they will just give up and
 * the manager will go back to chasing people in a group chat.
 *
 * So this checks the things a screenshot alone does not tell you: nothing
 * overflows 390px, nothing interactive is under 44px, and the words on the page
 * are the right words. It builds its own throwaway competition and deletes it.
 */
import pg from "pg";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE || "https://app.usg.co.nz";
const SHOTS = join(process.cwd(), "..", "..", "outputs", "teampay", "screens");

let pass = 0;
const fails: string[] = [];
const ok = (l: string, c: boolean, d = "") => {
  c ? pass++ : fails.push(`${l}${d ? ` — ${d}` : ""}`);
  console.log(`  ${c ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
};

const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESK = { width: 1440, height: 900, deviceScaleFactor: 1 };

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  const slug = `__uiverify-${Date.now().toString(36)}`;
  let compId: number | undefined, tourId: number | undefined;
  let browser: any = null;

  try {
    const org = (await db.query(`select id from organizations where slug='christchurch-international-cup'`)).rows[0];
    tourId = (await db.query(
      `insert into tournaments (organization_id, name, status) values ($1,$2,'draft') returning id`,
      [org.id, `__uiverify_${slug}`])).rows[0].id;
    compId = (await db.query(
      `insert into teampay_competitions
         (organization_id, kind, tournament_id, slug, name, brand, fee_cents, default_squad_size,
          entries_open, payments_enabled, fillins_open)
       values ($1,'tournament',$2,$3,'Christchurch Ethnic Cup','ethniccup',80000,14,true,false,true)
       returning id`, [org.id, tourId, slug])).rows[0].id;

    // A team with a squad in all three states, plus a very long name — the row
    // that actually breaks a phone layout.
    const entryTok = "u".repeat(32);
    const entryId = (await db.query(
      `insert into teampay_entries (competition_id, organization_id, team_name, community,
         manager_name, manager_email, squad_size, fee_cents, organiser_token)
       values ($1,$2,'Ethiopian Community FC','Ethiopian community','Amanuel Tesfaye',
               'a@example.com',14,80000,$3) returning id`, [compId, org.id, entryTok])).rows[0].id;

    const payTok = "p".repeat(32);
    await db.query(
      `insert into teampay_players (entry_id, name, email, invite_token, is_manager, paid_at, paid_cents)
       values ($1,'Amanuel Tesfaye','a@example.com',$2,true, now(), 5715)`, [entryId, "m".repeat(32)]);
    await db.query(
      `insert into teampay_players (entry_id, name, email, invite_token, first_opened_at, open_count, nudge_count, last_nudged_at)
       values ($1,'Bereket Haile','b@example.com',$2, now(), 3, 1, now())`, [entryId, "o".repeat(32)]);
    await db.query(
      `insert into teampay_players (entry_id, name, email, invite_token) values ($1,$2,$3,$4)`,
      [entryId, "Wondwossen Gebremariam-Tekle", "w@example.com", payTok]);
    await db.query(
      `insert into teampay_players (entry_id, name, phone, invite_token)
       values ($1,'Phone Only','+64211234567',$2)`, [entryId, "h".repeat(32)]);
    await db.query(
      `insert into teampay_fillins (competition_id, organization_id, first_name, last_name, email,
         position, ability, from_where, motivation, note, player_token)
       values ($1,$2,'Santiago','Restrepo','s@example.com','Midfielder','Club level',
               'Colombia, here 3 months','Meet people','New in town, keen for a run.',$3)`,
      [compId, org.id, "f".repeat(32)]);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

    const pages: Array<[string, string]> = [
      ["enter", `/enter/${slug}`],
      ["dashboard", `/team/${entryTok}`],
      ["player", `/pay/${payTok}`],
      ["fillin", `/fill-in/${slug}`],
    ];

    for (const [name, path] of pages) {
      for (const [label, vp] of [["phone", PHONE], ["desktop", DESK]] as const) {
        const page = await browser.newPage();
        await page.setViewport(vp as any);
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2", timeout: 45000 });
        await new Promise((r) => setTimeout(r, 900));
        await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`), fullPage: true });

        if (label === "phone") {
          // 🔴 The body must never scroll sideways. A single unbreakable word or
          // a table that escapes its own overflow container does this, and it is
          // invisible in a full-page screenshot.
          const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth);
          ok(`${name}: no horizontal overflow at 390px`, overflow <= 1, `${overflow}px over`);

          // 🔴 Nothing interactive under 44px. A 32px icon button is a miss on a
          // thumb, and every action on the dashboard is an icon button.
          //
          // The tap target of a checkbox is its LABEL, not the 18px box — a tap
          // anywhere on the label toggles it. Measuring the input alone reported
          // a failure where the real target was a comfortable 44px row, so the
          // check climbs to the wrapping label first.
          const small = await page.evaluate(() =>
            Array.from(document.querySelectorAll("button, a, input, select, textarea"))
              .map((el) => {
                const isBox = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
                const target = isBox ? (el.closest("label") ?? el) : el;
                return { el, target, r: target.getBoundingClientRect() };
              })
              .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 44)
              .map(({ el, r }) => `${el.tagName}"${(el.textContent || "").trim().slice(0, 22)}"(${Math.round(r.height)}px)`));
          ok(`${name}: every tap target ≥44px`, small.length === 0, small.slice(0, 4).join(", "));

          // 🔴 16px minimum on typed inputs, or iOS Safari zooms the page the
          // moment the field takes focus and the layout jumps under the person's
          // thumb mid-typing. Checkboxes and radios are exempt — nothing is typed
          // into them, so there is nothing for Safari to zoom to.
          const tiny = await page.evaluate(() =>
            Array.from(document.querySelectorAll("input, select, textarea"))
              .filter((el) => !(el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)))
              .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).length);
          ok(`${name}: inputs are ≥16px (no iOS zoom-jump)`, tiny === 0, `${tiny} too small`);
        }

        const text = await page.evaluate(() => document.body.innerText);

        if (name === "dashboard" && label === "desktop") {
          ok("dashboard: names are shown, not just counts", /Bereket Haile/.test(text));
          ok("dashboard: long names don't get truncated away", /Wondwossen/.test(text));
          ok("dashboard: 'Not opened' is a visible state", /Not opened/.test(text));
          ok("dashboard: 'Opened, not paid' is a visible state", /Opened, not paid/.test(text));
          ok("dashboard: 'Paid' is a visible state", /\bPaid\b/.test(text));
          ok("dashboard: the payments-off notice is shown", /Payment isn't open yet/i.test(text));
          ok("dashboard: the share is $57.15, not $57.14", /\$57\.15/.test(text));
          ok("dashboard: a 'find a fill-in' route exists", /fill-in/i.test(text));
          ok("dashboard: warns the link manages the team", /Anyone with this link/i.test(text));
        }
        if (name === "player" && label === "desktop") {
          ok("player: says who the team is", /Ethiopian Community FC/.test(text));
          ok("player: quotes the share", /\$57\.15/.test(text));
          ok("player: payments-off is explained, not a dead button", /Payment isn't open yet/i.test(text));
          ok("player: offers a way out", /can't play/i.test(text));
          ok("player: shows squad progress", /teammates have paid/i.test(text));
        }
        if (name === "enter" && label === "desktop") {
          ok("enter: says nothing to pay now", /Nothing to pay now/i.test(text));
          ok("enter: shows the per-player split", /\$57\.15|each/i.test(text));
          ok("enter: asks nothing about a card", !/card number|cvc/i.test(text));
        }
        if (name === "fillin" && label === "desktop") {
          ok("fill-in: promises contact details stay private", /stay private|can't see your email/i.test(text));
          ok("fill-in: asks where they're from", /Where are you from/i.test(text));
          ok("fill-in: explains they'd pay a share", /one share|pay one share/i.test(text));
        }
        await page.close();
      }
    }

    // A bad token must not leak that a team exists.
    const p = await browser.newPage();
    await p.setViewport(DESK as any);
    await p.goto(`${BASE}/team/${"z".repeat(32)}`, { waitUntil: "networkidle2", timeout: 45000 });
    await new Promise((r) => setTimeout(r, 700));
    const nf = await p.evaluate(() => document.body.innerText);
    ok("a wrong token shows a dead end, not a team", /couldn't find that/i.test(nf) && !/Ethiopian/.test(nf));
    await p.close();

  } finally {
    if (browser) await browser.close();
    if (compId) await db.query(`delete from teampay_competitions where id=$1`, [compId]);
    if (tourId) await db.query(`delete from tournaments where id=$1`, [tourId]);
    await db.end();
  }

  console.log(
    fails.length
      ? `\n  ${fails.length} FAILED of ${pass + fails.length}:\n` + fails.map((f) => `    · ${f}`).join("\n") + `\n  screenshots: ${SHOTS}\n`
      : `\n  ${pass} checks passed.  screenshots: ${SHOTS}\n`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

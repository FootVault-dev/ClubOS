// UI preflight for the Mailer's Content step — the real live page, in a real
// browser, at phone and laptop size, signed in as an ORDINARY workspace admin.
//
//   npx tsx --env-file=.env script/_verify-mailer-browser.ts
//
// Why this exists: the visual builder is a three-pane shell that cannot work on
// a 390px screen, so it swaps itself for a plain-HTML editor below 768px. That
// fallback lives inside a fixed-height, overflow-hidden box sized for a laptop
// canvas — a combination nothing but a browser at a phone width can judge.
//
// Signs in over the API and injects the cookie: driving ClubOS's SPA login form
// races its submit and screenshots the login page, which reads exactly like a
// permissions failure.
import pg from "pg";
import bcrypt from "bcryptjs";
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";
import { join } from "path";

const BASE = process.env.VERIFY_BASE || "https://app.usg.co.nz";
const WORKSPACE = "christchurch-united";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(process.cwd(), "outputs", "mailer-preflight");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

let pass = 0, fail = 0;
const ok = (l: string, good: boolean, d = "") => {
  console.log(`  ${good ? "ok  " : "FAIL"} ${l}${d ? ` — ${d}` : ""}`);
  good ? pass++ : fail++;
};

const users: number[] = [];
let browser: any = null;

try {
  mkdirSync(OUT, { recursive: true });
  console.log(`\nMailer — browser preflight against ${BASE}\n`);

  const email = `_mailerpreflight_${Date.now()}@usg.co.nz`;
  const password = `T${Math.random().toString(36).slice(2)}!aA9`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, first_name, last_name, password, role, active)
     VALUES ($1,'Preflight','Mailer',$2,'team_member',true) RETURNING id`,
    [email, await bcrypt.hash(password, 10)],
  );
  users.push(rows[0].id);
  await pool.query(
    `INSERT INTO user_organizations (user_id, organization_id, role, tabs)
     VALUES ($1, 2, 'admin', NULL)`,
    [rows[0].id],
  );

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: HTTP ${login.status}`);
  const [cname, cvalue] = (login.headers.get("set-cookie") || "").split(";")[0].split("=");

  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

  for (const [label, width, height, mobile] of [
    ["mailer-desktop", 1440, 900, false],
    ["mailer-mobile", 390, 844, true],
  ] as const) {
    console.log(`\n${label} (${width}×${height})`);
    const page = await browser.newPage();
    await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    if (mobile) await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    await page.setCookie({ name: cname, value: cvalue, domain: "app.usg.co.nz", path: "/", httpOnly: true, secure: true });

    await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate((slug: string) => localStorage.setItem("clubos_workspace", slug), WORKSPACE);
    await page.goto(`${BASE}/admin/mailer`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));

    const body = await page.evaluate(() => document.body.innerText);
    ok("the page is the Mailer, not the login screen", !/Sign in|Forgot password/i.test(body));

    // Setup → Content. "All Contacts" then Next.
    const seg = await page.$('[data-testid="button-segment-all"]');
    ok("the audience picker is present", Boolean(seg));
    if (seg) await seg.click();
    await new Promise((r) => setTimeout(r, 400));
    const next = await page.$('[data-testid="button-next-content"]');
    if (next) await next.click();
    await new Promise((r) => setTimeout(r, 1200));

    // Give the builder a subject and let the lazy chunk land.
    const subj = await page.$('[data-testid="input-subject"]');
    ok("the Content step opened (subject field visible)", Boolean(subj));
    if (subj) { await subj.click(); await page.keyboard.type("Preflight — everything happening this week"); }
    await new Promise((r) => setTimeout(r, 6000));

    // ── the checks that only a browser at this width can make ────────────────
    const m: any = await page.evaluate(`(function () {
      var de = document.documentElement;
      var box = document.querySelector('[data-testid="email-builder"]');
      var inner = box ? box.firstElementChild : null;
      var ta = box ? box.querySelector("textarea") : null;
      var iframe = box ? box.querySelector("iframe") : null;
      var gjs = box ? box.querySelector(".gjs-editor") : null;
      var small = [];
      var nodes = document.querySelectorAll("button, a[href], input, textarea");
      for (var i = 0; i < nodes.length; i++) {
        var b = nodes[i].getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.height < 44) {
          var t = nodes[i].getAttribute("data-testid");
          small.push(nodes[i].tagName.toLowerCase() + (t ? "[" + t + "]" : "") + ":" + Math.round(b.height) + "px");
        }
      }
      return {
        docWidth: de.scrollWidth,
        winWidth: window.innerWidth,
        boxH: box ? box.clientHeight : 0,
        contentH: inner ? inner.scrollHeight : 0,
        boxOverflow: box ? getComputedStyle(box).overflow : "",
        hasTextarea: !!ta,
        textareaValueLen: ta ? ta.value.length : -1,
        hasGrapes: !!gjs,
        iframeBottom: iframe ? iframe.getBoundingClientRect().bottom : null,
        boxBottom: box ? box.getBoundingClientRect().bottom : null,
        small: small.slice(0, 10)
      };
    })()`);

    ok("no horizontal overflow", m.docWidth <= m.winWidth + 1, `${m.docWidth} vs ${m.winWidth}`);

    if (mobile) {
      ok("the narrow fallback is shown (plain-HTML editor, not the 3-pane builder)",
        m.hasTextarea && !m.hasGrapes, `textarea=${m.hasTextarea} grapes=${m.hasGrapes}`);
      ok("the fallback is not clipped by the fixed-height box",
        m.contentH <= m.boxH + 2, `content ${m.contentH}px inside ${m.boxH}px (${m.boxOverflow})`);
      ok("the preview iframe is fully inside the box",
        m.iframeBottom !== null && m.boxBottom !== null && m.iframeBottom <= m.boxBottom + 2,
        `iframe bottom ${Math.round(m.iframeBottom ?? -1)} vs box bottom ${Math.round(m.boxBottom ?? -1)}`);
      // The Mailer's OWN controls must be thumb-sized. The admin shell around
      // it (sidebar toggle, global search, account menu) is every page in
      // ClubOS, not this feature — reported so it stays visible, but a global
      // restyle is not something a mailer change gets to smuggle in.
      const SHELL = ["button-sidebar-toggle", "input-global-search", "button-account-menu"];
      const mine = m.small.filter((s: string) => !SHELL.some((k) => s.includes(k)));
      const shell = m.small.filter((s: string) => SHELL.some((k) => s.includes(k)));
      ok("every Mailer control is at least 44px tall", mine.length === 0, mine.join(", "));
      if (shell.length) console.log(`  note  shared admin chrome under 44px (not this feature): ${shell.join(", ")}`);
    } else {
      ok("the full builder mounted", m.hasGrapes || m.contentH > 0, `grapes=${m.hasGrapes}`);
    }

    // Not clipped is not the same as reachable. ClubOS's admin scrolls in an
    // inner pane, not the document, so this finds whatever actually scrolls and
    // drives it to the bottom — the preview and the Next button have to be
    // somewhere a thumb can get to.
    if (mobile) {
      const reach: any = await page.evaluate(`(function () {
        var box = document.querySelector('[data-testid="email-builder"]');
        var el = box ? box.parentElement : null;
        var scroller = null;
        while (el) {
          var st = getComputedStyle(el);
          if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4) { scroller = el; break; }
          el = el.parentElement;
        }
        if (!scroller && document.scrollingElement && document.scrollingElement.scrollHeight > window.innerHeight + 4) scroller = document.scrollingElement;
        if (!scroller) return { scrolled: false };
        scroller.scrollTop = scroller.scrollHeight;
        var iframe = box ? box.querySelector("iframe") : null;
        var next = document.querySelector('[data-testid="button-next-send"]');
        var ir = iframe ? iframe.getBoundingClientRect() : null;
        var nr = next ? next.getBoundingClientRect() : null;
        return {
          scrolled: true,
          previewOnScreen: !!ir && ir.top < window.innerHeight && ir.bottom > 0,
          nextOnScreen: !!nr && nr.top < window.innerHeight && nr.bottom > 0,
          nextTop: nr ? Math.round(nr.top) : null,
          viewport: window.innerHeight
        };
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      ok("the page scrolls", reach.scrolled === true);
      ok("the live preview can be scrolled to", reach.previewOnScreen === true);
      ok("Next: Review & Send can be reached", reach.nextOnScreen === true,
        `top ${reach.nextTop} of ${reach.viewport}`);
      await page.screenshot({ path: join(OUT, `${label}-scrolled.png`) });
      console.log(`  → ${join(OUT, `${label}-scrolled.png`)}`);
    }

    const shot = join(OUT, `${label}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`  → ${shot}`);
    const full = join(OUT, `${label}-full.png`);
    await page.screenshot({ path: full, fullPage: true });
    console.log(`  → ${full}`);
    await page.close();
  }
} catch (e: any) {
  console.error("\npreflight threw:", e.message);
  fail++;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const id of users) {
    await pool.query(`DELETE FROM user_organizations WHERE user_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {});
  }
  await pool.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

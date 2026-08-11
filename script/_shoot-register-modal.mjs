// Screenshot the mid-count registration sheet WITH THE MODAL OPEN, at the two
// viewports that have actually broken it before.
//
// 🔴 1366×768 is the load-bearing one. That is Dima's Windows laptop (and every
// 125%-DPI-scaled 1920×1080), and a centred sheet taller than the viewport
// clips its own top unreachably there — a bug a full-page screenshot can NEVER
// show, because full-page pretends the viewport is infinite. This sheet grew a
// Rack field on 2026-08-10, so it is taller than the version that shipped.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TARGET = process.env.SHOOT_URL || "http://localhost:5099/admin/warehouse/stock-take";
const OUT = "/Users/danielmeyn/Desktop/AIOS/DanielMeynOS/outputs/ui-preflight/warehouse-register-modal";
mkdirSync(OUT, { recursive: true });

const cookieHeader = process.env.UI_PREFLIGHT_COOKIE ?? "";
const { hostname, protocol } = new URL(TARGET);
const cookies = cookieHeader.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim(), domain: hostname, path: "/", secure: protocol === "https:", httpOnly: true };
});

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
const shoot = async (label, viewport) => {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (cookies.length) await page.setCookie(...cookies);
  await page.evaluateOnNewDocument(() => localStorage.setItem("clubos_workspace", "united-prints"));
  await page.goto(TARGET, { waitUntil: "networkidle0", timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));

  // Open the sheet the way a person does.
  const opened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("New item"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 1200));

  // VIEWPORT-cropped, never fullPage — the whole point is what actually fits.
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: false });

  // Is the top of the sheet reachable, and does the page scroll sideways?
  const report = await page.evaluate(() => {
    const card = document.querySelector('[class*="sm:max-w-lg"]');
    const r = card?.getBoundingClientRect();
    return {
      opened: !!card,
      topOffscreen: r ? Math.round(r.top) : null,
      cardHeight: r ? Math.round(r.height) : null,
      viewportH: window.innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  console.log(label, JSON.stringify({ clicked: opened, ...report }));
  await page.close();
};

await shoot("laptop-1366x768", { width: 1366, height: 768 });
await shoot("mobile-390x844", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await browser.close();
console.log(OUT);

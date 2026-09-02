/**
 * Prove that bare `text-white` is readable everywhere in light mode.
 *
 *   npx vite build && node script/_verify-white-ink.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * `text-white` is the one colour utility that cannot be mapped by a blanket
 * rule: it is correct on a blue button and invisible on a white card. The
 * generated block in index.css darkens it by default and restores white only
 * where the element — or an ancestor — carries a genuinely coloured ground.
 *
 * 🔴 The rule this replaced matched `[class*="bg-blue-"]`, a SUBSTRING, so a
 * 4% wash (`bg-blue-500/[0.04]`) counted as a dark ground. That painted the
 * Academy term cards white-on-white, which is the bug this file locks down.
 *
 * It measures real computed colour in a real browser against WCAG AA (4.5:1),
 * because a CSS rule can be present, valid and still wrong.
 */
import puppeteer from "puppeteer-core";
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.INK_URL || "http://localhost:8791/white-ink.html";

const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const L1 = lum(...a), L2 = lum(...b); const [x, y] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (x + 0.05) / (y + 0.05); };
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);

const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const p = await b.newPage();
await p.goto(URL, { waitUntil: "networkidle0" });
const rows = await p.evaluate(() => {
  const out = [];
  // Walk up for the first ground that actually paints. A gradient paints via
  // background-IMAGE, which has no single colour to measure — report it so it
  // reads as unmeasured rather than silently passing on the page background.
  const groundOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return { gradient: true };
      const m = cs.backgroundColor.match(/[\d.]+/g);
      if (m && (m.length < 4 || parseFloat(m[3]) > 0.85)) return { colour: cs.backgroundColor };
      n = n.parentElement;
    }
    return { colour: "rgb(255,255,255)" };
  };
  document.querySelectorAll(".text-white").forEach((el) => {
    out.push({ label: el.textContent.trim().slice(0, 38), ink: getComputedStyle(el).color, ...groundOf(el) });
  });
  return out;
});
await b.close();

let pass = 0, fail = 0, skip = 0;
for (const r of rows) {
  if (r.gradient) { skip++; console.log(`  – gradient ground, not measurable — ${r.label} (ink ${r.ink})`); continue; }
  const c = contrast(rgb(r.ink), rgb(r.colour));
  const ok = c >= 4.5;
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${c.toFixed(2).padStart(6)}:1  ink ${r.ink.padEnd(20)} on ${r.colour.padEnd(20)} — ${r.label}`);
}
console.log(`\n${pass} pass, ${fail} fail, ${skip} unmeasurable (WCAG AA 4.5:1)`);
process.exit(fail ? 1 : 0);

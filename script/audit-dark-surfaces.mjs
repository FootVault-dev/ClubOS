#!/usr/bin/env node
/**
 * audit-dark-surfaces.mjs — catch dark surfaces the light-mode mapping cannot.
 *
 * WHY THIS EXISTS
 * ---------------
 * `script/build-light-theme.mjs` remaps every dark COLOUR UTILITY to a light
 * equivalent. It works on class names, so it is blind to an inline style:
 *
 *     <div style={{ background: '#02060E' }}>   ← untouchable by CSS mapping
 *
 * On 2026-09-02 there were 47 of those across 25 files. Twelve were admin
 * screens — the academy modal, the session roll, the NZF identity fields, the
 * admin loading screen — each a full-page or full-panel near-black that would
 * keep its background while the mapping correctly flipped the text on top of
 * it to dark ink. Black text on a black panel: the "View ClubOS as…" bug,
 * repeated a dozen times, and invisible to any grep for classes.
 *
 *   npx tsx script/audit-dark-surfaces.mjs      (or: node)
 *
 * Exits 1 if an un-declared dark surface exists.
 *
 * A page that IS meant to be dark declares it, one of two ways:
 *   • its route is listed in `isPublicDarkSurface()` in lib/theme-provider.tsx
 *     — preferred, because it applies before first paint; or
 *   • it renders `<ForceDarkSurface />` — for a page whose URL cannot identify
 *     it, like the SIU camp page, which shares `/{slug}` with the light CUFC
 *     one.
 * Either way it must appear in DECLARED_DARK below, so that "this page is
 * deliberately black" is a decision somebody wrote down.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "client/src");

/**
 * Files allowed to paint their own dark background, each with the reason and
 * how the theme knows. Adding a line here is a deliberate act; the audit only
 * checks that the reason was written down, not that it is a good one.
 */
const DECLARED_DARK = {
  "pages/venue-book.tsx": "USC venue booking — /book, matched by isPublicDarkSurface()",
  "pages/venue-book-success.tsx": "USC venue booking — /book/success",
  "pages/member-booking.tsx": "members' booking page — /members",
  "pages/sign-declaration.tsx": "payables declaration — /declaration/:token",
  "pages/sign-native.tsx": "e-sign signing surface, rendered inside /sign/:token",
  "pages/ref/RefSignup.tsx": "CIC referee portal — /signup, gold on black",
  "pages/mfl-ref/MflRefSignup.tsx": "MFL referee portal — /mfl-ref/signup",
  "pages/cic-skills-landing.tsx": "CIC Skills Challenge — /skills",
  "pages/siu-camp-page.tsx":
    "SIU Unity Black camp page — shares /{slug} with the LIGHT CUFC page, so it renders <ForceDarkSurface /> itself",
  "pages/membership-page.tsx": "membership purchase — /membership",
  "pages/mfl-landing-page.tsx": "MFL public league pages — /league, /league/:slug",
  "pages/venue-split-page.tsx": "venue split pay — /book/split/:code",
  "pages/venue-payshare-pay.tsx": "venue PayShare — /book/payshare/pay/:token",
  "pages/ref/RefHome.tsx": "CIC referee portal home — /login",
  "pages/ref/RefGameDetail.tsx": "CIC referee scoring — /game/:id",
  "pages/mfl-ref/MflRefHome.tsx": "MFL referee portal home — /mfl-ref",
  "pages/mfl-ref/MflRefGameDetail.tsx": "MFL referee scoring — /mfl-ref/game/:id",
  // These two are the exception: staff tools on an /admin route, so no URL
  // rule can reach them. They render <ForceDarkSurface /> themselves.
  "pages/cic-score-game.tsx":
    "CIC office scoring — /admin/cic-score/:id, gold on black, renders <ForceDarkSurface />",
  "pages/mfl-score-game.tsx":
    "MFL office scoring — /admin/mfl-score/:id, gold on black, renders <ForceDarkSurface />",
  "components/match-timer.tsx": "used only by the two score-game screens above",
  "pages/academy-register-page.tsx":
    "NZF academy registration — /academy/:slug, navy and gold. Its dark surfaces come from a BRAND constant, not a literal, so the hex scan below cannot see them.",
};

/**
 * Not a surface. A dark hex used as `color:` ON a bright background (gold
 * button text), or as a data value (a product's colour swatch), is correct and
 * has nothing to do with the theme.
 */
const NOT_A_SURFACE = [
  /color:\s*["'`]#/, // dark ink on a coloured chip
  /swatchHex/, // product colour data
  /\?\?\s*["'`]#/, // a fallback for user-supplied colour data
];

function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length > 6) h = h.slice(0, 6);
  const ch = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch(0)) + 0.7152 * f(ch(2)) + 0.0722 * f(ch(4));
}

// Same threshold as the generated mapping: below this a colour is a surface,
// never a brand colour. Verified against the real palette — the darkest brand
// colour in use is #013590 at L=0.046.
const DARK_MAX_L = 0.05;

function grepLines(pattern) {
  try {
    return execSync(`grep -rnE ${JSON.stringify(pattern)} ${JSON.stringify(SRC)}`, {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const lines = grepLines(
  "style=\\{\\{[^}]*(background|backgroundColor)[^}]*#[0-9a-fA-F]{3,6}",
);

// 🔴 The mirror bug, and the one that actually shipped. An inline
// `style={{ color: "#fff" }}` is just as unreachable by the CSS mapping as an
// inline background — so on a light panel it is white text on white. Five of
// them were sitting in the NZF identity fields, which the office walk-up form
// and the public academy checkout both use.
const whiteInk = [
  ...grepLines("style=\\{\\{[^}]*color[^}]*(#fff\\b|#ffffff|#FFF\\b|#FFFFFF)"),
  ...grepLines("style=\\{\\{[^}]*color[^}]*rgba?\\(255, ?255, ?255"),
];

const violations = [];
for (const line of lines) {
  const [file, lineNo, ...rest] = line.split(":");
  const text = rest.join(":");
  const rel = relative(SRC, file);

  if (NOT_A_SURFACE.some((re) => re.test(text))) continue;

  // Only look at the hexes inside the style block, not elsewhere on the line.
  const style = text.match(/style=\{\{[^}]*\}?\}?/)?.[0] ?? text;
  const darkHexes = (style.match(/#[0-9a-fA-F]{3,6}\b/g) ?? []).filter(
    (h) => luminance(h) < DARK_MAX_L,
  );
  if (darkHexes.length === 0) continue;

  if (rel in DECLARED_DARK) continue;
  violations.push({ rel, lineNo, hexes: [...new Set(darkHexes)].join(" "), text: text.trim().slice(0, 90) });
}

for (const line of whiteInk) {
  const [file, lineNo, ...rest] = line.split(":");
  const text = rest.join(":");
  const rel = relative(SRC, file);
  if (rel in DECLARED_DARK) continue; // a dark page's white ink is correct
  violations.push({
    rel,
    lineNo,
    hexes: "white ink",
    text: text.trim().slice(0, 90),
  });
}

// A declared file that no longer paints anything dark is stale bookkeeping —
// worth knowing, but never a failure.
const seen = new Set(
  lines.map((l) => relative(SRC, l.split(":")[0])).filter((r) => r in DECLARED_DARK),
);
const stale = Object.keys(DECLARED_DARK).filter((k) => !seen.has(k));

// The theme provider must actually still have the escape hatches this audit
// tells people to use. A rename would otherwise leave the advice pointing at
// nothing.
const themeSrc = readFileSync(join(SRC, "lib/theme-provider.tsx"), "utf8");
const missingHooks = [];
if (!themeSrc.includes("function isPublicDarkSurface")) missingHooks.push("isPublicDarkSurface()");
if (!themeSrc.includes("export function ForceDarkSurface")) missingHooks.push("<ForceDarkSurface />");

console.log(
  `Scanned ${lines.length} inline background styles and ${whiteInk.length} inline white-ink styles under client/src.`,
);
console.log(`${Object.keys(DECLARED_DARK).length} files declared deliberately dark.\n`);

if (stale.length) {
  console.log("Declared dark but no longer painting a dark background (tidy up when convenient):");
  for (const s of stale) console.log(`  · ${s}`);
  console.log("");
}

if (missingHooks.length) {
  console.log(`✗ theme-provider.tsx no longer exports: ${missingHooks.join(", ")}`);
}

if (violations.length === 0 && missingHooks.length === 0) {
  console.log("✓ No un-declared dark surfaces.");
  process.exit(0);
}

console.log(`✗ ${violations.length} un-declared dark surface(s):\n`);
for (const v of violations) {
  console.log(`  ${v.rel}:${v.lineNo}  ${v.hexes}`);
  console.log(`      ${v.text}`);
}
console.log(`
Each one paints its own dark background, which the light-mode mapping cannot
reach — the text on top WILL be flipped to dark ink and become unreadable.

Fix it by using a theme token (hsl(var(--card)) / hsl(var(--background))), or,
if the page really is meant to be dark, declare it: add its route to
isPublicDarkSurface() (preferred) or render <ForceDarkSurface />, and add the
file to DECLARED_DARK in this script with the reason.`);
process.exit(1);

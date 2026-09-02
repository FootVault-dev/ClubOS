#!/usr/bin/env node
/**
 * build-light-theme.mjs — generate the light-mode colour mapping layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * ClubOS's admin console was written dark-first: ~15,000 hardcoded
 * `text-white/40`, `bg-white/[0.03]`, `border-white/10` utilities and ~280
 * hardcoded near-black panel backgrounds (`bg-[#0a0e1a]`, `bg-[#02060E]`…).
 * When the app went light-only (2026-09-02) those utilities had to be
 * remapped to dark-ink-on-light equivalents.
 *
 * That remapping used to be a hand-written list in index.css. A hand-written
 * list is an ALLOWLIST, and an allowlist has holes: `bg-[#070C16]` was never
 * added, so the "View ClubOS as…" panel kept its near-black background while
 * the text polyfill correctly flipped its text to dark ink — black on black,
 * an unreadable popup, shipped and complained about.
 *
 * So the list is now GENERATED from the source. Every colour utility that
 * actually appears in client/src gets a rule. A new dark panel added tomorrow
 * is picked up by re-running this; it cannot silently fall through.
 *
 *   npm run build:light-theme          # rewrite the generated block
 *   npm run build:light-theme -- --check   # CI: fail if out of date
 *
 * The output is written into client/src/index.css between the two marker
 * comments. Everything outside those markers is left alone.
 *
 * SCOPE: every rule is scoped `html:not(.dark)`. The public booking flow
 * (book.*, /skills, cicyouth) still sets `.dark` deliberately and is
 * untouched by all of this — see client/src/lib/theme-provider.tsx.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "client/src");
const CSS = join(SRC, "index.css");

const START = "/* === GENERATED: light-theme mapping — do not edit by hand === */";
const END = "/* === END GENERATED light-theme mapping === */";

// ── the ink we map white onto ───────────────────────────────────────────────
const INK = "15 23 42"; // slate-900, the app's foreground
const SURFACE = "255 255 255"; // white card

// ── alpha curves ────────────────────────────────────────────────────────────
// White text on a dark panel reads fine at 30% opacity. Dark text on a white
// panel needs ~65% to be equally legible, so low alphas are compressed
// upward. These anchor points were tuned by eye against real pages; values
// between them are interpolated so ANY alpha in the source gets a sensible
// result, including ones nobody has used yet.
const TEXT_ANCHORS = [
  [0, 0], [0.1, 0.5], [0.2, 0.58], [0.3, 0.66], [0.4, 0.74],
  [0.5, 0.82], [0.6, 0.88], [0.7, 0.92], [0.8, 0.96], [0.9, 0.98], [1, 1],
];

function interp(anchors, a) {
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (a <= x1) return y0 + ((a - x0) / (x1 - x0)) * (y1 - y0);
  }
  return anchors[anchors.length - 1][1];
}

const round = (n) => +n.toFixed(3);
const textAlpha = (a) => round(interp(TEXT_ANCHORS, a));
// A translucent white FILL on dark is a subtle lift; on light it must become
// a subtle dark tint, much weaker or it reads as a grey block.
const bgAlpha = (a) => round(Math.min(a * 0.5 + 0.01, 0.16));
// Borders sit between the two — visible, never heavy.
const borderAlpha = (a) => round(Math.min(a * 0.45 + 0.04, 0.28));

// ── scan the source ─────────────────────────────────────────────────────────
function grep(pattern) {
  try {
    return execSync(`grep -rhoE ${JSON.stringify(pattern)} ${JSON.stringify(SRC)}`, {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // grep exits 1 on no matches
  }
}

// Escape a Tailwind class name for use in a CSS selector. `#` matters most:
// an unescaped `.bg-[#02060E]` parses as `.bg-` followed by the attribute
// selector `[#02060E]`, which is invalid — the browser drops the whole rule
// silently and the panel stays black. Matches Tailwind's own escaping.
const esc = (cls) => cls.replace(/([.#/[\]()%,:])/g, "\\$1");

// Turn a Tailwind modifier prefix into the selector suffix it compiles to.
const MODIFIERS = {
  "": (sel) => sel,
  "hover:": (sel) => `${sel}:hover`,
  "focus:": (sel) => `${sel}:focus`,
  "focus-within:": (sel) => `${sel}:focus-within`,
  "group-hover:": (sel) => `.group:hover ${sel}`,
  "placeholder:": (sel) => `${sel}::placeholder`,
  "file:": (sel) => `${sel}::file-selector-button`,
  "after:": (sel) => `${sel}::after`,
  "before:": (sel) => `${sel}::before`,
};

// Parse `hover:text-white/40` → { mod:'hover:', prop:'text', alpha:0.4 }
function parseWhite(token) {
  const m = token.match(
    /^((?:[a-z-]+:)*)(text|bg|border|divide|ring|outline|fill|stroke|decoration|shadow|from|via|to)-white(?:\/(\[[0-9.]+\]|[0-9]+))?$/
  );
  if (!m) return null;
  const [, mod, prop, rawAlpha] = m;
  if (!(mod in MODIFIERS)) return null;
  let alpha = null;
  if (rawAlpha) {
    alpha = rawAlpha.startsWith("[")
      ? parseFloat(rawAlpha.slice(1, -1))
      : parseInt(rawAlpha, 10) / 100;
  }
  return { token, mod, prop, alpha };
}

function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length === 8) h = h.slice(0, 6);
  const ch = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(ch(0)) + 0.7152 * f(ch(2)) + 0.0722 * f(ch(4));
}

// A hex this dark is a panel/page surface, never a brand colour. Measured
// against the real codebase there is a clean gap: the darkest brand colour in
// use is #013590 at L=0.046, the lightest surface is #1c1e24 at L=0.013.
const DARK_SURFACE_MAX_L = 0.02;

function build() {
  const out = [];
  const push = (...s) => out.push(...s);

  push(START);
  push("/*");
  push(" * Generated by script/build-light-theme.mjs — DO NOT EDIT BY HAND.");
  push(" * Re-run `npm run build:light-theme` after adding colour utilities.");
  push(" * Scoped html:not(.dark) so the public dark booking flow is untouched.");
  push(" */");

  // ── 1. white-family utilities ────────────────────────────────────────────
  const whiteTokens = [
    ...new Set(
      grep(
        "[a-zA-Z0-9_:-]*(text|bg|border|divide|ring|outline|fill|stroke|decoration|shadow|from|via|to)-white(/[0-9]+|/\\[[0-9.]+\\])?"
      )
    ),
  ]
    .map(parseWhite)
    .filter(Boolean)
    // Longest class first so `text-white/40` can't be shadowed by `text-white`.
    .sort((a, b) => a.token.localeCompare(b.token));

  const rules = [];
  let nAlpha = 0;
  for (const { token, mod, prop, alpha } of whiteTokens) {
    // Bare `text-white` (no alpha) is handled by the hand-written surgery
    // block below — it depends on the ancestor's background, which cannot be
    // derived from the class name alone.
    if (alpha === null) continue;
    const sel = MODIFIERS[mod](`.${esc(token)}`);
    let decl = null;
    if (prop === "text" || prop === "decoration") {
      decl = `color: rgb(${INK} / ${textAlpha(alpha)})`;
      if (prop === "decoration") decl = `text-decoration-color: rgb(${INK} / ${textAlpha(alpha)})`;
    } else if (prop === "bg") {
      // A mostly-opaque white fill is a genuine white surface (a card, a
      // sticky header) — it must stay white. Only translucent lifts flip.
      decl =
        alpha >= 0.5
          ? `background-color: rgb(${SURFACE} / ${alpha})`
          : `background-color: rgb(${INK} / ${bgAlpha(alpha)})`;
    } else if (prop === "border" || prop === "divide") {
      decl = `border-color: rgb(${INK} / ${borderAlpha(alpha)})`;
    } else if (prop === "ring") {
      decl = `--tw-ring-color: rgb(${INK} / ${borderAlpha(alpha)})`;
    } else if (prop === "outline") {
      decl = `outline-color: rgb(${INK} / ${borderAlpha(alpha)})`;
    } else if (prop === "fill") {
      decl = `fill: rgb(${INK} / ${textAlpha(alpha)})`;
    } else if (prop === "stroke") {
      decl = `stroke: rgb(${INK} / ${textAlpha(alpha)})`;
    } else if (prop === "from" || prop === "via" || prop === "to") {
      // Gradient stops: a white-tinted gradient on dark becomes an
      // ink-tinted one on light, at the fill strength.
      const v = `rgb(${INK} / ${bgAlpha(alpha)})`;
      decl =
        prop === "from"
          ? `--tw-gradient-from: ${v} var(--tw-gradient-from-position)`
          : prop === "via"
            ? `--tw-gradient-to: rgb(${INK} / 0); --tw-gradient-stops: var(--tw-gradient-from), ${v} var(--tw-gradient-via-position), var(--tw-gradient-to)`
            : `--tw-gradient-to: ${v} var(--tw-gradient-to-position)`;
    } else if (prop === "shadow") {
      continue; // shadow-white is never used meaningfully here
    }
    if (!decl) continue;
    rules.push(`html:not(.dark) ${sel} { ${decl} !important; }`);
    nAlpha++;
  }
  push("");
  push(`/* ${nAlpha} translucent white utilities → dark ink on light */`);
  push(...rules);

  // ── 2. hardcoded dark panel surfaces ─────────────────────────────────────
  // Any arbitrary hex dark enough to be a surface rather than a brand colour.
  const hexTokens = [
    ...new Set(grep("\\b(bg|border|from|via|to|ring|divide)-\\[#[0-9a-fA-F]{3,8}\\]")),
  ];
  const darkHexRules = [];
  const mappedHexes = [];
  for (const token of hexTokens) {
    const prop = token.slice(0, token.indexOf("-["));
    const hex = token.match(/#[0-9a-fA-F]{3,8}/)[0];
    if (luminance(hex) > DARK_SURFACE_MAX_L) continue; // brand colour — leave it
    mappedHexes.push(`${token} (L=${luminance(hex).toFixed(4)})`);
    const sel = `.${esc(token)}`;
    if (prop === "bg") {
      darkHexRules.push(
        `html:not(.dark) ${sel} { background-color: hsl(var(--card)) !important; }`
      );
    } else if (prop === "border" || prop === "divide") {
      darkHexRules.push(
        `html:not(.dark) ${sel} { border-color: rgb(${INK} / 0.10) !important; }`
      );
    } else if (prop === "ring") {
      darkHexRules.push(
        `html:not(.dark) ${sel} { --tw-ring-color: rgb(${INK} / 0.10) !important; }`
      );
    } else {
      // gradient stop on a dark surface → flatten to the card colour
      darkHexRules.push(
        `html:not(.dark) ${sel} { --tw-gradient-${prop === "from" ? "from" : "to"}: hsl(var(--card)) !important; }`
      );
    }
  }
  push("");
  push(
    `/* ${darkHexRules.length} hardcoded dark surfaces → light card. Luminance < ${DARK_SURFACE_MAX_L}.`
  );
  push(`   ${mappedHexes.sort().join(", ")} */`);
  push(...darkHexRules.sort());

  // ── 3. dark palette surfaces (zinc/slate/neutral 800-950, solid black) ───
  const paletteTokens = [
    ...new Set(
      grep("\\b(bg|border)-(zinc|slate|neutral|gray|stone)-(8|9)[0-9]0\\b")
    ),
  ];
  const paletteRules = [];
  for (const token of paletteTokens) {
    const prop = token.slice(0, token.indexOf("-"));
    const sel = `.${esc(token)}`;
    paletteRules.push(
      prop === "bg"
        ? `html:not(.dark) ${sel} { background-color: hsl(var(--card)) !important; }`
        : `html:not(.dark) ${sel} { border-color: rgb(${INK} / 0.10) !important; }`
    );
  }
  // Solid `bg-black` (no alpha) is a panel and must flip. `bg-black/40` is a
  // modal scrim and is correct on a light page too, so it must NOT flip —
  // and it doesn't: Tailwind compiles that to the single class token
  // `bg-black\/40`, which the `.bg-black` selector below cannot match.
  paletteRules.push(
    `html:not(.dark) .bg-black { background-color: hsl(var(--card)) !important; }`
  );
  push("");
  push(`/* ${paletteRules.length} dark palette surfaces → light card.`);
  push(`   bg-black/NN scrims are deliberately untouched — a dim scrim is`);
  push(`   correct on a light page too. */`);
  push(...paletteRules.sort());

  // ── 4. harden the design tokens against third-party :root blocks ─────────
  //
  // 🔴 Found live on app.usg.co.nz, 2026-09-02: a browser extension injects
  // its own `:root { --primary: #009AF7; --secondary: …; --background: … }`
  // into every page. Same specificity as ours, later in the cascade, so it
  // WINS — and `hsl(var(--primary))` becomes `hsl(#009AF7)`, which is invalid
  // and paints nothing. On Daniel's machine that silently blanked every
  // `bg-primary` button and every chart stroke in ClubOS.
  //
  // ~510 utilities across 62 files ride on these tokens, so a stranger's
  // stylesheet could repaint most of the admin. Re-declaring them at
  // `:root:not(.dark)` / `:root.dark` raises specificity from (0,1,0) to
  // (0,2,0), which any plain `:root` loses to.
  //
  // Generated from the real token blocks in this same file, so the hardened
  // copy cannot drift from the source of truth.
  // Read the file fresh here — the module-level `css` const is initialised
  // after build() runs, and the tokens must come from the CURRENT file.
  const selfCss = readFileSync(CSS, "utf8");
  const tokenBlock = (selector) => {
    const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`, "m");
    const m = re.exec(selfCss);
    if (!m) return null;
    return m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("--") && l.endsWith(";"))
      .filter((l) => !l.includes("hsl(from")); // relative-colour fallbacks re-derive themselves
  };

  const light = tokenBlock(":root");
  const dark = tokenBlock(".dark");
  push("");
  push("/* Design tokens re-declared at higher specificity so a third-party");
  push("   `:root` block (a browser extension's theme, say) cannot silently");
  push("   repaint the admin. Observed live: an extension setting");
  push("   `--primary: #009AF7` made hsl(var(--primary)) invalid, which blanked");
  push("   every bg-primary button and every chart stroke. */");
  if (light?.length) {
    push(`:root:not(.dark) {`);
    for (const l of light) push(`  ${l}`);
    push(`}`);
  }
  // After the light block, so `.dark` still wins when it is present.
  if (dark?.length) {
    push(`:root.dark {`);
    for (const l of dark) push(`  ${l}`);
    push(`}`);
  }

  push("");
  push(END);
  return out.join("\n");
}

const generated = build();
const css = readFileSync(CSS, "utf8");
const s = css.indexOf(START);
const e = css.indexOf(END);
if (s === -1 || e === -1) {
  console.error(
    `Markers not found in ${CSS}. Add:\n${START}\n${END}\nwhere the generated block should live.`
  );
  process.exit(1);
}
const next = css.slice(0, s) + generated + css.slice(e + END.length);

if (process.argv.includes("--check")) {
  if (next !== css) {
    console.error(
      "✗ light-theme mapping is out of date. Run: npm run build:light-theme"
    );
    process.exit(1);
  }
  console.log("✓ light-theme mapping is up to date");
} else {
  writeFileSync(CSS, next);
  const n = generated.split("\n").filter((l) => l.startsWith("html:not")).length;
  console.log(`✓ wrote ${n} light-mode mapping rules into client/src/index.css`);
}

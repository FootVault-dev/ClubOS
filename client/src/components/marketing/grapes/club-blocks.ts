// ─────────────────────────────────────────────────────────────────────────────
// grapes/club-blocks.ts — the CUFC/USG-specific email block palette. Adds a
// "Club blocks" category of on-brand, football-club-flavoured MJML blocks on
// top of the core palette (./blocks.ts): hero, fixture card, result card,
// product card (+2-up), video/stream thumbnail, countdown, social row, stats.
//
// Follows the EXTENSION POINT contract documented at the top of blocks.ts:
//   • every block's `content` is valid MJML (section/wrapper → column → content)
//     so it compiles clean through grapesjs-mjml — proven by the throwaway
//     mjml-browser compile script run while building this file.
//   • every colour/font comes from brandCanvasTheme(brandKey) — nothing hardcoded,
//     so a block opens on-brand no matter which workspace is editing.
//   • every element sets colour/font EXPLICITLY (no reliance on <mj-attributes>
//     defaults — grapesjs-mjml renders those as stray visible components in the
//     canvas, breaking WYSIWYG; same rule brand.ts's starter template follows).
//   • merge tags ({{first_name}} etc.) are used ONLY where the send engine
//     actually fills them (server/marketing/{flow-graph,worker}.ts support
//     exactly: first_name, last_name, email, unsubscribe_url, preferences_url).
//     Match/product/date facts aren't real merge tags today, so they're baked
//     as real, editable football copy instead of invented placeholders.
//
// Wired in from editor.ts with one line, right after the core registerBlocks call:
//   registerClubBlocks(editor, brandKey);
// ─────────────────────────────────────────────────────────────────────────────

import type { Editor } from "grapesjs";
import { registerBlock, type EmailBlockDef } from "./blocks";
import { brandCanvasTheme, type BrandCanvas } from "./brand";

const CAT_CLUB = "Club blocks";

/** Register the club block palette. Call once, after the core registerBlocks(). */
export function registerClubBlocks(editor: Editor, brandKey: string): void {
  const b = brandCanvasTheme(brandKey);
  for (const def of clubBlocks(b)) registerBlock(editor, def);
}

function clubBlocks(b: BrandCanvas): EmailBlockDef[] {
  return [
    heroBlock(b),
    fixtureCardBlock(b),
    resultCardBlock(b),
    productCardBlock(b),
    productTwoUpBlock(b),
    videoThumbBlock(b),
    countdownBlock(b),
    socialRowBlock(b),
    statStripBlock(b),
  ];
}

// ── placeholder copy (real, editable — not lorem) ───────────────────────────

const OPPONENT = "Nelson Suburbs";
const COMPETITION = "NZ National League";
const VENUE = "English Park, Christchurch";
const FIXTURE_DATE = "SAT 12 JUL · 2:00PM";

// ── 1. Hero with background image ───────────────────────────────────────────

function heroBlock(b: BrandCanvas): EmailBlockDef {
  return {
    id: "club-hero",
    label: "Hero (background image)",
    category: CAT_CLUB,
    media: svgHero(),
    content: `<mj-hero mode="fixed-height" height="300px" background-url="${overlayBg(b, 1200, 600)}" background-color="#05060a" background-position="center center" padding="60px 26px">
  <mj-text align="center" color="#ffffff" font-family="${b.font}" font-size="12px" font-weight="800" letter-spacing="2.5px" text-transform="uppercase" padding-bottom="10px">Match Day</mj-text>
  <mj-text align="center" color="#ffffff" font-family="${b.font}" font-size="32px" font-weight="800" line-height="1.15" padding-bottom="10px">${escapeText(b.name)} are back at home this Saturday</mj-text>
  <mj-text align="center" color="#f4f4f5" font-family="${b.font}" font-size="15px" line-height="1.6" padding-bottom="22px">Kick-off 2:00pm — get behind the team, {{first_name}}. Double-click to edit this line, or swap the background image for a real match photo.</mj-text>
  <mj-button align="center" background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="14px 30px">Get tickets</mj-button>
</mj-hero>`,
  };
}

// ── 2. Fixture card ──────────────────────────────────────────────────────────

function fixtureCardBlock(b: BrandCanvas): EmailBlockDef {
  const crest = crestPlaceholder();
  return {
    id: "club-fixture-card",
    label: "Fixture card",
    category: CAT_CLUB,
    media: svgFixture(),
    content: `<mj-wrapper background-color="${b.surface}" border="1px solid ${b.border}" border-radius="16px" padding="22px 18px 20px">
  <mj-section padding="0 0 10px">
    <mj-column width="32%" vertical-align="middle">
      <mj-image src="${crest}" alt="Home crest" width="56px" padding="0" align="center" />
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="13px" font-weight="800" text-transform="uppercase" letter-spacing="0.3px" padding="8px 4px 0">${escapeText(b.name)}</mj-text>
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="10px" font-weight="700" letter-spacing="1.2px" text-transform="uppercase" padding-top="2px">Home</mj-text>
    </mj-column>
    <mj-column width="36%" vertical-align="middle">
      <mj-text align="center" color="${b.accent}" font-family="${b.font}" font-size="12px" font-weight="800" letter-spacing="2px" padding-bottom="8px">VS</mj-text>
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="18px" font-weight="800" line-height="1.2" padding-bottom="2px">${FIXTURE_DATE}</mj-text>
    </mj-column>
    <mj-column width="32%" vertical-align="middle">
      <mj-image src="${crest}" alt="Away crest" width="56px" padding="0" align="center" />
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="13px" font-weight="800" text-transform="uppercase" letter-spacing="0.3px" padding="8px 4px 0">${escapeText(OPPONENT)}</mj-text>
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="10px" font-weight="700" letter-spacing="1.2px" text-transform="uppercase" padding-top="2px">Away</mj-text>
    </mj-column>
  </mj-section>
  <mj-section padding="0">
    <mj-column>
      <mj-divider border-color="${b.border}" border-width="1px" padding="2px 0 14px" />
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="12px" font-weight="600" letter-spacing="0.2px" padding-bottom="16px">${escapeText(COMPETITION)} · ${escapeText(VENUE)}</mj-text>
      <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="12px 26px" align="center">Get tickets</mj-button>
    </mj-column>
  </mj-section>
</mj-wrapper>`,
  };
}

// ── 3. Result card ───────────────────────────────────────────────────────────

function resultCardBlock(b: BrandCanvas): EmailBlockDef {
  const crest = crestPlaceholder();
  return {
    id: "club-result-card",
    label: "Result card",
    category: CAT_CLUB,
    media: svgTrophy(),
    content: `<mj-wrapper background-color="${b.surface}" border="1px solid ${b.border}" border-radius="16px" padding="22px 18px 20px">
  <mj-section padding="0 0 10px">
    <mj-column width="32%" vertical-align="middle">
      <mj-image src="${crest}" alt="Home crest" width="56px" padding="0" align="center" />
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="13px" font-weight="800" text-transform="uppercase" letter-spacing="0.3px" padding="8px 4px 0">${escapeText(b.name)}</mj-text>
    </mj-column>
    <mj-column width="36%" vertical-align="middle">
      <mj-text align="center" color="${b.accent}" font-family="${b.font}" font-size="11px" font-weight="800" letter-spacing="2px" padding-bottom="6px">FULL TIME</mj-text>
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="32px" font-weight="800" line-height="1">3 — 1</mj-text>
    </mj-column>
    <mj-column width="32%" vertical-align="middle">
      <mj-image src="${crest}" alt="Away crest" width="56px" padding="0" align="center" />
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="13px" font-weight="800" text-transform="uppercase" letter-spacing="0.3px" padding="8px 4px 0">${escapeText(OPPONENT)}</mj-text>
    </mj-column>
  </mj-section>
  <mj-section padding="0">
    <mj-column>
      <mj-divider border-color="${b.border}" border-width="1px" padding="2px 0 14px" />
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="12px" font-weight="600" letter-spacing="0.2px" padding-bottom="16px">${escapeText(COMPETITION)} · Full time</mj-text>
      <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="12px 26px" align="center">Match report</mj-button>
    </mj-column>
  </mj-section>
</mj-wrapper>`,
  };
}

// ── 4. Product card ───────────────────────────────────────────────────────────

function productCardBlock(b: BrandCanvas): EmailBlockDef {
  return {
    id: "club-product-card",
    label: "Product card",
    category: CAT_CLUB,
    media: svgBag(),
    content: `<mj-section background-color="${b.surface}" padding="8px 28px">
  <mj-column border="1px solid ${b.border}" border-radius="14px" padding="0 0 20px">
    <mj-image src="${productPlaceholder()}" alt="2026 Home Kit" padding="0" border-radius="14px 14px 0 0" />
    <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="16px" font-weight="800" padding="16px 18px 2px">2026 Home Kit</mj-text>
    <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="14px" font-weight="600" padding="0 18px 14px">$49.99</mj-text>
    <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="11px 24px" align="center">Shop now</mj-button>
  </mj-column>
</mj-section>`,
  };
}

// ── 4b. Product card — 2-up ──────────────────────────────────────────────────

function productTwoUpBlock(b: BrandCanvas): EmailBlockDef {
  const img = productPlaceholder();
  // Two bordered "cards" side by side with a visible gap between them. A column's
  // padding sits INSIDE its border (normal CSS box model), so a gutter can't be
  // padding on the same bordered column — it needs its own thin spacer column,
  // the standard MJML pattern for a two-up card row.
  const card = (name: string, price: string) => `
    <mj-column width="47%" border="1px solid ${b.border}" border-radius="14px" padding="0 0 16px">
      <mj-image src="${img}" alt="${escapeAttr(name)}" padding="0" border-radius="14px 14px 0 0" />
      <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="14px" font-weight="800" padding="12px 12px 2px">${escapeText(name)}</mj-text>
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="13px" font-weight="600" padding="0 12px 12px">${price}</mj-text>
      <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="9px" font-weight="700" inner-padding="9px 18px" align="center" font-size="12px">Shop now</mj-button>
    </mj-column>`;
  return {
    id: "club-product-2up",
    label: "Product card (2-up)",
    category: CAT_CLUB,
    media: svgBagPair(),
    content: `<mj-section background-color="${b.surface}" padding="8px 28px">${card("2026 Home Kit", "$49.99")}
  <mj-column width="6%"></mj-column>${card("2026 Away Kit", "$49.99")}
</mj-section>`,
  };
}

// ── 5. Video / stream thumbnail ─────────────────────────────────────────────

function videoThumbBlock(b: BrandCanvas): EmailBlockDef {
  return {
    id: "club-video-thumb",
    label: "Video thumbnail",
    category: CAT_CLUB,
    media: svgPlay(),
    content: `<mj-hero mode="fixed-height" height="220px" background-url="${overlayBg(b, 1200, 675)}" background-color="#05060a" background-position="center center" padding="0">
  <mj-image src="${playButtonIcon(b)}" alt="Watch" width="60px" padding="0" align="center" />
  <mj-text align="center" color="#ffffff" font-family="${b.font}" font-size="18px" font-weight="800" line-height="1.3" padding="14px 24px 4px">Match Highlights: Round 14</mj-text>
  <mj-text align="center" color="#e4e4e7" font-family="${b.font}" font-size="12px" font-weight="700" letter-spacing="1px" text-transform="uppercase" padding-bottom="18px">Watch on United TV</mj-text>
</mj-hero>
<mj-section background-color="${b.surface}" padding="16px 28px 8px">
  <mj-column>
    <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="12px 26px" align="center">Watch now</mj-button>
  </mj-column>
</mj-section>`,
  };
}

// ── 6. Event countdown / date block ─────────────────────────────────────────

function countdownBlock(b: BrandCanvas): EmailBlockDef {
  return {
    id: "club-countdown",
    label: "Event countdown",
    category: CAT_CLUB,
    media: svgCalendar(),
    content: `<mj-section background-color="${b.surface}" padding="8px 28px">
  <mj-column border="1px solid ${b.border}" border-radius="14px" padding="26px 20px">
    <mj-text align="center" color="${b.accent}" font-family="${b.font}" font-size="12px" font-weight="800" letter-spacing="2px" text-transform="uppercase" padding-bottom="8px">Save the date</mj-text>
    <mj-text align="center" color="${b.heading}" font-family="${b.font}" font-size="26px" font-weight="800" letter-spacing="-0.3px" line-height="1.2" padding-bottom="6px">${FIXTURE_DATE}</mj-text>
    <mj-text align="center" color="${b.text}" font-family="${b.font}" font-size="16px" font-weight="700" padding-bottom="2px">Home Opener vs ${escapeText(OPPONENT)}</mj-text>
    <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="13px" font-weight="600" padding-bottom="18px">${escapeText(VENUE)} — see you there, {{first_name}}</mj-text>
    <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="12px 26px" align="center">Register now</mj-button>
  </mj-column>
</mj-section>`,
  };
}

// ── 7. Social row ─────────────────────────────────────────────────────────────

function socialRowBlock(b: BrandCanvas): EmailBlockDef {
  return {
    id: "club-social-row",
    label: "Social row",
    category: CAT_CLUB,
    media: svgSocialNodes(),
    content: `<mj-section background-color="${b.surface}" padding="10px 28px">
  <mj-column>
    <mj-social font-size="13px" icon-size="28px" mode="horizontal" align="center">
      <mj-social-element name="instagram-noshare" href="https://instagram.com/" background-color="${b.accent}" border-radius="14px"></mj-social-element>
      <mj-social-element name="facebook-noshare" href="https://facebook.com/" background-color="${b.accent}" border-radius="14px"></mj-social-element>
      <mj-social-element src="${tiktokIcon(b)}" href="https://tiktok.com/" alt="TikTok" border-radius="14px"></mj-social-element>
      <mj-social-element name="youtube-noshare" href="https://youtube.com/" background-color="${b.accent}" border-radius="14px"></mj-social-element>
    </mj-social>
  </mj-column>
</mj-section>`,
  };
}

// ── 8. Stat strip ─────────────────────────────────────────────────────────────

function statStripBlock(b: BrandCanvas): EmailBlockDef {
  const stat = (num: string, label: string) => `
    <mj-column width="33.33%">
      <mj-text align="center" color="${b.accent}" font-family="${b.font}" font-size="28px" font-weight="800" line-height="1">${num}</mj-text>
      <mj-text align="center" color="${b.muted}" font-family="${b.font}" font-size="11px" font-weight="700" letter-spacing="0.6px" text-transform="uppercase" padding-top="4px">${escapeText(label)}</mj-text>
    </mj-column>`;
  return {
    id: "club-stat-strip",
    label: "Stat strip",
    category: CAT_CLUB,
    media: svgBars(),
    content: `<mj-section background-color="${b.surface}" padding="22px 28px">${stat("50+", "Teams")}${stat("4", "Nights")}${stat("1", "Community")}
</mj-section>`,
  };
}

// ── placeholder images (data-URI SVGs — no external image service needed) ────

function dataUriSvg(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Dark, on-brand gradient background — a tasteful stand-in until a real photo
 *  is dropped in. Always dark enough for white overlay text to stay readable,
 *  regardless of whether the brand's own theme is light or dark. */
function overlayBg(b: BrandCanvas, w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#05060a"/>
    <circle cx="${Math.round(w * 0.82)}" cy="${Math.round(h * 0.22)}" r="${Math.round(h * 0.55)}" fill="${b.accent}" opacity="0.22"/>
    <circle cx="${Math.round(w * 0.12)}" cy="${Math.round(h * 0.85)}" r="${Math.round(h * 0.45)}" fill="${b.accent}" opacity="0.14"/>
  </svg>`;
  return dataUriSvg(svg);
}

/** Round grey crest placeholder — swapped for a real club crest by the user. */
function crestPlaceholder(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
    <circle cx="60" cy="60" r="58" fill="#d4d4d8"/>
    <circle cx="60" cy="60" r="58" fill="none" stroke="#a1a1aa" stroke-width="2"/>
    <path d="M60 30l8 16 18 3-13 13 3 18-16-8-16 8 3-18-13-13 18-3z" fill="#a1a1aa" opacity="0.6"/>
  </svg>`;
  return dataUriSvg(svg);
}

/** Square neutral product placeholder — swapped for a real product photo. */
function productPlaceholder(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="100%" height="100%" fill="#e5e7eb"/>
    <path d="M0 320l120-90 90 65 90-50 100 90v65H0z" fill="#cbd5e1"/>
    <circle cx="110" cy="130" r="26" fill="#cbd5e1"/>
  </svg>`;
  return dataUriSvg(svg);
}

/** Accent-coloured play button — sits centred over a video/stream thumbnail. */
function playButtonIcon(b: BrandCanvas): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120">
    <circle cx="60" cy="60" r="58" fill="${b.accent}"/>
    <path d="M48 38l38 22-38 22z" fill="${b.onAccent}"/>
  </svg>`;
  return dataUriSvg(svg);
}

/** Custom TikTok glyph — MJML's built-in mj-social icon set has no TikTok entry
 *  (verified against mjml-browser@4.18.0), so this is a small on-brand circular
 *  icon rather than a broken/missing image. */
function tiktokIcon(b: BrandCanvas): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
    <circle cx="14" cy="14" r="14" fill="${b.accent}"/>
    <path d="M16.2 7.5c.5 1.7 1.7 2.8 3.4 3v2.4c-1.2 0-2.3-.4-3.4-1.1v5.1a4.6 4.6 0 1 1-4.6-4.6c.3 0 .6 0 .9.1v2.5a2.1 2.1 0 1 0 1.5 2v-9.4h2.2Z" fill="${b.onAccent}"/>
  </svg>`;
  return dataUriSvg(svg);
}

// ── inline SVG icons (24×24, stroke=currentColor — same convention as blocks.ts) ─

function wrap(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function svgHero() {
  return wrap(`<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M2.5 14.5h19"/><circle cx="12" cy="10" r="1.1" fill="currentColor" stroke="none"/>`);
}
function svgFixture() {
  return wrap(`<circle cx="6" cy="12" r="3.4"/><circle cx="18" cy="12" r="3.4"/><path d="M10.2 12h3.6"/>`);
}
function svgTrophy() {
  return wrap(`<path d="M7 4h10v3a5 5 0 0 1-10 0V4Z"/><path d="M9 15h6l1 5H8l1-5Z"/><path d="M12 15v-3"/><path d="M7 5H4a3 3 0 0 0 3 4"/><path d="M17 5h3a3 3 0 0 1-3 4"/>`);
}
function svgBag() {
  return wrap(`<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>`);
}
function svgBagPair() {
  return wrap(`<rect x="2.5" y="6" width="8" height="12" rx="1.5"/><rect x="13.5" y="6" width="8" height="12" rx="1.5"/>`);
}
function svgPlay() {
  return wrap(`<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M10 9.2l6 2.8-6 2.8V9.2Z" fill="currentColor" stroke="none"/>`);
}
function svgCalendar() {
  return wrap(`<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/>`);
}
function svgSocialNodes() {
  return wrap(`<circle cx="5" cy="12" r="1.9"/><circle cx="10.3" cy="6.2" r="1.9"/><circle cx="10.3" cy="17.8" r="1.9"/><circle cx="17.5" cy="12" r="1.9"/><path d="M6.6 10.9l2.2-3.1M6.6 13.1l2.2 3.1M12.2 12h3.3"/>`);
}
function svgBars() {
  return wrap(`<path d="M5 19V10"/><path d="M12 19V5"/><path d="M19 19v-7"/>`);
}

// ── escaping helpers (same behaviour as blocks.ts's private copies) ─────────

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

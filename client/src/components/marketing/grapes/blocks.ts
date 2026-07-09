// ─────────────────────────────────────────────────────────────────────────────
// grapes/blocks.ts — the core email block palette (drag-onto-canvas tiles).
//
// Every block's `content` is MJML, so everything the user drops compiles to
// email-safe, Outlook-hardened HTML. Structure blocks (Section / 2-Column /
// 3-Column) are full <mj-section> rows; content blocks (Heading / Text / Button /
// Image / Logo / Divider / Spacer) are bare MJML elements that drop INTO a column
// (the email-safe nesting model — GrapesJS only highlights valid drop targets).
//
// ── EXTENSION POINT (for the club-blocks agent) ──────────────────────────────
// Add new blocks WITHOUT touching this file's core:
//
//   import { registerBlock, type EmailBlockDef } from "./blocks";
//   import { brandCanvasTheme } from "./brand";
//
//   export function registerClubBlocks(editor, brandKey) {
//     const b = brandCanvasTheme(brandKey);
//     const fixtureCard: EmailBlockDef = {
//       id: "club-fixture-card",
//       label: "Fixture card",
//       category: "Club blocks",
//       media: `<svg ...>`,               // 24×24 line icon, stroke="currentColor"
//       content: `<mj-section ...>…</mj-section>`,  // MJML; use {{merge_tags}} freely
//     };
//     registerBlock(editor, fixtureCard);
//   }
//
// Then call registerClubBlocks(editor, brandKey) after createEmailEditor(...).
// Rules for a good club block:
//   • content MUST be valid MJML (section→column→content) so it compiles.
//   • pull brand colours from brandCanvasTheme(brandKey) — never hardcode hex.
//   • category "Club blocks" keeps them grouped under their own header.
//   • real data is baked at insert-time OR left as {{merge_tags}} the send engine fills.
//
// The "Highlight card" at the bottom is a working example of the pattern.
// ─────────────────────────────────────────────────────────────────────────────

import type { Editor } from "grapesjs";
import { brandCanvasTheme, type BrandCanvas } from "./brand";

/** A palette block. `content` is an MJML string; `media` is an inline SVG icon. */
export interface EmailBlockDef {
  /** unique block id, e.g. "email-heading" or "club-fixture-card" */
  id: string;
  /** palette label */
  label: string;
  /** category header the tile groups under (e.g. "Layout", "Club blocks") */
  category: string;
  /** inline SVG string for the tile icon (24×24, stroke="currentColor") */
  media: string;
  /** MJML content dropped onto the canvas */
  content: string;
  /** optional attributes applied to the dropped component */
  attributes?: Record<string, unknown>;
}

/** Context handed to block builders — the resolved brand canvas theme. */
export interface BlockContext {
  brand: BrandCanvas;
}

/**
 * Register ONE block. The public extension primitive — call this from a club-blocks
 * module to add a block without editing the core palette.
 */
export function registerBlock(editor: Editor, def: EmailBlockDef): void {
  editor.BlockManager.add(def.id, {
    label: def.label,
    category: def.category,
    media: def.media,
    content: def.content,
    attributes: { class: "ce-block-tile", ...(def.attributes ?? {}) },
  });
}

/**
 * Register the full core palette. Called once by createEmailEditor. Pass a `ctx`
 * to override the resolved brand (otherwise derived from brandKey).
 */
export function registerBlocks(editor: Editor, brandKey: string, ctx?: Partial<BlockContext>): void {
  const brand = ctx?.brand ?? brandCanvasTheme(brandKey);
  const c: BlockContext = { brand };
  // Registration order drives category + tile order in the palette.
  for (const def of coreBlocks(c)) registerBlock(editor, def);
}

// ── the core palette ─────────────────────────────────────────────────────────

const CAT_LAYOUT = "Layout";
const CAT_CONTENT = "Content";
const CAT_BLOCKS = "Blocks";
const CAT_CLUB = "Club blocks";

const IMG_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='560'%20height='280'%3E%3Crect%20width='100%25'%20height='100%25'%20fill='%23e5e7eb'/%3E%3Cpath%20d='M0%20220l160-120%20120%2090%20120-70%20160%20120v40H0z'%20fill='%23cbd5e1'/%3E%3Ccircle%20cx='150'%20cy='90'%20r='34'%20fill='%23cbd5e1'/%3E%3C/svg%3E";

function coreBlocks(c: BlockContext): EmailBlockDef[] {
  const b = c.brand;
  return [
    // ── Layout ────────────────────────────────────────────────────────────
    {
      id: "email-section",
      label: "Section",
      category: CAT_LAYOUT,
      media: svgSection(),
      content: `<mj-section background-color="${b.surface}" padding="20px 28px">
  <mj-column>
    <mj-text color="${b.text}" font-size="15px" line-height="1.7">New section — double-click to edit this text, or drop blocks into it.</mj-text>
  </mj-column>
</mj-section>`,
    },
    {
      id: "email-2col",
      label: "2 columns",
      category: CAT_LAYOUT,
      media: svgCols(2),
      content: `<mj-section background-color="${b.surface}" padding="20px 28px">
  <mj-column width="50%"><mj-text color="${b.text}" font-size="15px" line-height="1.7">Left column.</mj-text></mj-column>
  <mj-column width="50%"><mj-text color="${b.text}" font-size="15px" line-height="1.7">Right column.</mj-text></mj-column>
</mj-section>`,
    },
    {
      id: "email-3col",
      label: "3 columns",
      category: CAT_LAYOUT,
      media: svgCols(3),
      content: `<mj-section background-color="${b.surface}" padding="20px 24px">
  <mj-column width="33.33%"><mj-text color="${b.text}" font-size="14px" line-height="1.6">One.</mj-text></mj-column>
  <mj-column width="33.33%"><mj-text color="${b.text}" font-size="14px" line-height="1.6">Two.</mj-text></mj-column>
  <mj-column width="33.33%"><mj-text color="${b.text}" font-size="14px" line-height="1.6">Three.</mj-text></mj-column>
</mj-section>`,
    },
    {
      id: "email-divider",
      label: "Divider",
      category: CAT_LAYOUT,
      media: svgDivider(),
      content: `<mj-divider border-color="${b.border}" border-width="1px" padding="10px 0" />`,
    },
    {
      id: "email-spacer",
      label: "Spacer",
      category: CAT_LAYOUT,
      media: svgSpacer(),
      content: `<mj-spacer height="24px" />`,
    },

    // ── Content ───────────────────────────────────────────────────────────
    {
      id: "email-heading",
      label: "Heading",
      category: CAT_CONTENT,
      media: svgHeading(),
      content: `<mj-text color="${b.heading}" font-family="${b.font}" font-size="26px" font-weight="800" line-height="1.25" letter-spacing="-0.4px">Section heading</mj-text>`,
    },
    {
      id: "email-text",
      label: "Text",
      category: CAT_CONTENT,
      media: svgText(),
      content: `<mj-text color="${b.text}" font-family="${b.font}" font-size="15px" line-height="1.7">Body copy. Double-click to edit. Keep it short and human — one idea per paragraph reads best on a phone.</mj-text>`,
    },
    {
      id: "email-button",
      label: "Button",
      category: CAT_CONTENT,
      media: svgButton(),
      content: `<mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="13px 26px" align="left">Click here</mj-button>`,
    },
    {
      id: "email-image",
      label: "Image",
      category: CAT_CONTENT,
      media: svgImage(),
      content: `<mj-image src="${IMG_PLACEHOLDER}" alt="" border-radius="8px" padding="10px 0" />`,
    },
    {
      id: "email-logo",
      label: "Logo",
      category: CAT_CONTENT,
      media: svgLogo(),
      content: `<mj-image src="${b.logoUrl ?? IMG_PLACEHOLDER}" alt="${escapeAttr(b.name)}" width="150px" align="left" padding="6px 0" />`,
    },

    // ── Blocks ────────────────────────────────────────────────────────────
    {
      id: "email-social",
      label: "Social row",
      category: CAT_BLOCKS,
      media: svgSocial(),
      content: `<mj-section background-color="${b.surface}" padding="8px 28px">
  <mj-column>
    <mj-social font-size="13px" icon-size="28px" mode="horizontal" align="center">
      <mj-social-element name="facebook-noshare" href="https://facebook.com/" background-color="${b.accent}"></mj-social-element>
      <mj-social-element name="instagram-noshare" href="https://instagram.com/" background-color="${b.accent}"></mj-social-element>
      <mj-social-element name="web" href="https://" background-color="${b.accent}"></mj-social-element>
    </mj-social>
  </mj-column>
</mj-section>`,
    },
    {
      id: "email-footer",
      label: "Footer",
      category: CAT_BLOCKS,
      media: svgFooter(),
      content: `<mj-section background-color="${b.bg}" padding="18px 28px 26px">
  <mj-column>
    <mj-text color="${b.muted}" font-family="${b.font}" font-size="12px" line-height="1.6" align="center">
      ${escapeText(b.name)} · Christchurch, New Zealand<br />
      You're receiving this because you're part of ${escapeText(b.name)}.<br />
      <a href="{{unsubscribe_url}}" style="color:${b.muted};text-decoration:underline;">Unsubscribe</a>
    </mj-text>
  </mj-column>
</mj-section>`,
    },

    // ── Club blocks (example of the extension pattern) ──────────────────────
    {
      id: "email-highlight-card",
      label: "Highlight card",
      category: CAT_CLUB,
      media: svgStar(),
      content: `<mj-section background-color="${b.surface}" padding="8px 28px">
  <mj-column border="1px solid ${b.accent}" border-radius="14px" padding="22px">
    <mj-text color="${b.accent}" font-family="${b.font}" font-size="12px" font-weight="800" letter-spacing="1.5px" text-transform="uppercase">Highlight</mj-text>
    <mj-text color="${b.heading}" font-family="${b.font}" font-size="20px" font-weight="800" line-height="1.3" padding-top="6px">Something worth shouting about</mj-text>
    <mj-text color="${b.text}" font-family="${b.font}" font-size="14px" line-height="1.6" padding-top="6px">Use this card to draw the eye to your most important message — a signing, a result, a limited offer.</mj-text>
    <mj-button background-color="${b.accent}" color="${b.onAccent}" href="https://" font-family="${b.font}" border-radius="10px" align="left" padding-top="14px" inner-padding="11px 22px">Learn more</mj-button>
  </mj-column>
</mj-section>`,
    },
  ];
}

// ── inline SVG icons (24×24, stroke=currentColor — coloured by premium.css) ────

function wrap(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function svgSection() {
  return wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/>`);
}
function svgCols(n: number) {
  if (n === 3)
    return wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>`);
  return wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="12" y1="5" x2="12" y2="19"/>`);
}
function svgDivider() {
  return wrap(`<line x1="3" y1="12" x2="21" y2="12"/>`);
}
function svgSpacer() {
  return wrap(`<line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><path d="M12 10v4"/>`);
}
function svgHeading() {
  return wrap(`<path d="M6 5v14"/><path d="M18 5v14"/><path d="M6 12h12"/>`);
}
function svgText() {
  return wrap(`<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/>`);
}
function svgButton() {
  return wrap(`<rect x="4" y="8" width="16" height="8" rx="4"/><line x1="9" y1="12" x2="15" y2="12"/>`);
}
function svgImage() {
  return wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-6 6"/>`);
}
function svgLogo() {
  return wrap(`<circle cx="12" cy="12" r="8"/><path d="M8 12l3 3 5-6"/>`);
}
function svgSocial() {
  return wrap(`<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-4.2M8.2 13.2l7.6 4.2"/>`);
}
function svgFooter() {
  return wrap(`<rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="7" y1="17.5" x2="17" y2="17.5"/>`);
}
function svgStar() {
  return wrap(`<path d="M12 4l2.3 4.7 5.2.8-3.8 3.7.9 5.1L12 16l-4.6 2.4.9-5.1L4.5 9.5l5.2-.8z"/>`);
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

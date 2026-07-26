// ─────────────────────────────────────────────────────────────────────────────
// grapes/brand.ts — maps a brandKey → the GrapesJS canvas theme.
//
// Everything on-brand-before-you-touch-it lives here:
//   • brandCanvasTheme(key)  — the flat colour/font row the blocks + starter read.
//   • buildStarterMjml(key)  — a beautiful, on-brand starter email (header + hero +
//     body + button + footer-with-unsubscribe) so a blank campaign opens looking
//     designed, not empty. Carries <mj-attributes> defaults so EVERY block dropped
//     afterwards inherits brand fonts/colours automatically.
//   • brandColorPalette(key) — swatch rows injected into the Style Manager colour
//     pickers (via the editor's `colorPicker.palette`), so brand colours are one
//     click away wherever a colour is edited.
//   • applyBrandTheme(editor, key) — best-effort injection of brand font options
//     into the Style Manager typography dropdown (defensive; never throws).
//
// Palette source of truth is ../brand-themes.ts (getBrandMeta) — the SAME rows the
// live brand email shells use — so the builder and the sent email agree.
// ─────────────────────────────────────────────────────────────────────────────

import type { Editor } from "grapesjs";
import { getBrandMeta, type BrandTheme } from "../brand-themes";

/** Email-safe font stack — brand display faces (Anton/Kanit…) can't be relied on
 *  across email clients without hosted web-fonts, so the CANVAS/email uses this. */
export const EMAIL_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface BrandCanvas {
  key: string;
  name: string;
  isDark: boolean;
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  heading: string;
  accent: string;
  onAccent: string;
  logoUrl?: string;
  font: string;
}

/** The flat brand row the blocks + starter read. Derived from getBrandMeta so it
 *  always matches the live brand email shells. */
export function brandCanvasTheme(brandKey: string | null | undefined): BrandCanvas {
  const b: BrandTheme = getBrandMeta(brandKey);
  return {
    key: b.key,
    name: b.name,
    isDark: b.isDark,
    bg: b.bg,
    surface: b.surface,
    border: b.border,
    text: b.text,
    muted: b.muted,
    heading: b.heading,
    accent: b.accent,
    onAccent: b.onAccent,
    logoUrl: b.logoUrl,
    font: EMAIL_FONT,
  };
}

/** Swatch rows for the colour pickers: brand colours first, then a neutral ramp. */
export function brandColorPalette(brandKey: string | null | undefined): string[][] {
  const b = brandCanvasTheme(brandKey);
  return [
    [b.accent, b.heading, b.text, b.muted, b.surface, b.bg],
    ["#ffffff", "#f4f4f5", "#d4d4d8", "#a1a1aa", "#52525b", "#000000"],
  ];
}

/**
 * The brand starter email. This is what a fresh campaign opens as — designed, not
 * blank. Every element carries EXPLICIT brand colours + font so the live canvas is
 * true WYSIWYG (no <mj-head><mj-attributes> — grapesjs-mjml renders those as stray
 * visible components in the canvas, and their compile-time defaults don't preview).
 */
export function buildStarterMjml(brandKey: string | null | undefined): string {
  const b = brandCanvasTheme(brandKey);
  const logo = b.logoUrl
    ? `<mj-image src="${b.logoUrl}" alt="${escapeAttr(b.name)}" width="150px" padding="0" align="left" />`
    : `<mj-text color="${b.heading}" font-family="${b.font}" font-size="22px" font-weight="800" letter-spacing="-0.3px" padding="0">${escapeText(b.name)}</mj-text>`;

  return `<mjml>
  <mj-body background-color="${b.bg}">
    <mj-section background-color="${b.surface}" padding="28px 28px 8px">
      <mj-column>
        ${logo}
      </mj-column>
    </mj-section>

    <mj-section background-color="${b.surface}" padding="8px 28px 4px">
      <mj-column>
        <mj-text color="${b.heading}" font-family="${b.font}" font-size="30px" font-weight="800" line-height="1.2" letter-spacing="-0.5px">
          Your headline goes here
        </mj-text>
      </mj-column>
    </mj-section>

    <mj-section background-color="${b.surface}" padding="4px 28px 20px">
      <mj-column>
        <mj-text color="${b.text}" font-family="${b.font}" font-size="16px" line-height="1.7">
          Write a warm opening line here — tell them what this email is about in one clear sentence. Then drag blocks from the left to build the rest.
        </mj-text>
        <mj-button href="https://" align="left" background-color="${b.accent}" color="${b.onAccent}" font-family="${b.font}" border-radius="10px" font-weight="700" inner-padding="13px 26px" padding-top="18px">
          Register now
        </mj-button>
      </mj-column>
    </mj-section>

    <mj-section background-color="${b.surface}" padding="0 28px">
      <mj-column>
        <mj-divider border-color="${b.border}" border-width="1px" padding="8px 0" />
      </mj-column>
    </mj-section>

    <mj-section background-color="${b.bg}" padding="16px 28px 28px">
      <mj-column>
        <mj-text color="${b.muted}" font-family="${b.font}" font-size="12px" line-height="1.6" align="center">
          You're receiving this because you're part of ${escapeText(b.name)}.<br />
          <a href="{{unsubscribe_url}}" style="color:${b.muted};text-decoration:underline;">Unsubscribe</a>
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
}

/**
 * Best-effort brand tailoring after init. Injects brand-safe font options into the
 * Style Manager's font-family dropdown so the brand's own stack is pickable. Wrapped
 * defensively — the Style Manager sector/property shape varies across minor GrapesJS
 * versions, and a failure here must never break the editor.
 */
export function applyBrandTheme(editor: Editor, brandKey: string | null | undefined): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm: any = editor.StyleManager;
    const fontProp =
      sm?.getProperty?.("typography", "font-family") ??
      findFontProperty(sm);
    if (!fontProp?.set) return;
    const b = brandCanvasTheme(brandKey);
    const existing: Array<{ value: string; name?: string }> =
      (typeof fontProp.get === "function" ? fontProp.get("options") : fontProp.options) || [];
    const brandOption = { value: b.font, name: `${b.name} (email-safe)` };
    const hasBrand = existing.some((o) => o.value === b.font);
    fontProp.set("options", hasBrand ? existing : [brandOption, ...existing]);
  } catch {
    /* non-fatal — brand fonts are a nicety, not a requirement */
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findFontProperty(sm: any): any {
  try {
    const sectors = sm?.getSectors?.() ?? [];
    for (const sec of sectors) {
      const p = sec?.getProperty?.("font-family");
      if (p) return p;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

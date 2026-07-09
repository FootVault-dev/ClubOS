// ─────────────────────────────────────────────────────────────────────────────
// grapes/templates/sections.ts — reusable, email-safe MJML section builders.
//
// Every template composes these so the whole gallery shares one visual language:
// generous whitespace, an eyebrow → heading → body → CTA hierarchy, hairline
// dividers, a brand header, and a compliant footer with {{unsubscribe_url}}.
//
// Email-safe rules baked in (per the email-builder-UX research):
//   • 600px body (MJML default) → compiles to Outlook-hardened tables.
//   • EVERY element carries an explicit colour + font inline — no <mj-head>
//     <mj-attributes> (grapesjs-mjml renders those as stray visible components
//     in the canvas, and their compile-time defaults don't preview). This keeps
//     the canvas true-WYSIWYG and defends dark-mode (explicit colours resist
//     Gmail/Outlook inversion).
//   • Lean markup (short, deduped) → stays well under Gmail's ~102KB clip.
// ─────────────────────────────────────────────────────────────────────────────

import { brandCanvasTheme, type BrandCanvas } from "../brand";

export type Brand = BrandCanvas;

/** Resolve the flat brand row for a key (colours, logo, email-safe font). */
export function brand(brandKey: string): Brand {
  return brandCanvasTheme(brandKey);
}

// ── escaping ──────────────────────────────────────────────────────────────────
export function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// ── document shell ──────────────────────────────────────────────────────────────
/** Wrap section markup in <mjml><mj-body>. `preview` becomes the hidden preheader
 *  (drives the inbox preview snippet — a big open-rate lever). */
export function mjmlDoc(b: Brand, sections: string, preview?: string): string {
  const pre = preview
    ? `<mj-raw><div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escText(
        preview,
      )}</div></mj-raw>\n`
    : "";
  return `<mjml>
  <mj-body background-color="${b.bg}" width="600px">
${pre}${sections}
  </mj-body>
</mjml>`;
}

// ── header (logo or wordmark) ────────────────────────────────────────────────────
export function header(b: Brand, align: "left" | "center" = "left"): string {
  const logo = b.logoUrl
    ? `<mj-image src="${escAttr(b.logoUrl)}" alt="${escAttr(
        b.name,
      )}" width="148px" padding="0" align="${align}" />`
    : `<mj-text color="${b.heading}" font-family="${b.font}" font-size="21px" font-weight="800" letter-spacing="-0.3px" align="${align}" padding="0">${escText(
        b.name,
      )}</mj-text>`;
  return `    <mj-section background-color="${b.surface}" padding="26px 30px 12px">
      <mj-column>
        ${logo}
      </mj-column>
    </mj-section>`;
}

// ── eyebrow → heading → body building blocks ─────────────────────────────────────
export function eyebrow(b: Brand, label: string, opts: { align?: string; bg?: string } = {}): string {
  const align = opts.align ?? "left";
  const bg = opts.bg ?? b.surface;
  return `    <mj-section background-color="${bg}" padding="14px 30px 0">
      <mj-column>
        <mj-text color="${b.accent}" font-family="${b.font}" font-size="12px" font-weight="700" letter-spacing="1.4px" text-transform="uppercase" align="${align}" padding="0">${escText(
          label,
        )}</mj-text>
      </mj-column>
    </mj-section>`;
}

export function heading(
  b: Brand,
  text: string,
  opts: { size?: number; align?: string; bg?: string; padding?: string } = {},
): string {
  const size = opts.size ?? 30;
  const align = opts.align ?? "left";
  const bg = opts.bg ?? b.surface;
  const padding = opts.padding ?? "6px 30px 0";
  return `    <mj-section background-color="${bg}" padding="${padding}">
      <mj-column>
        <mj-text color="${b.heading}" font-family="${b.font}" font-size="${size}px" font-weight="800" line-height="1.18" letter-spacing="-0.6px" align="${align}" padding="0">${text}</mj-text>
      </mj-column>
    </mj-section>`;
}

export function paragraph(
  b: Brand,
  html: string,
  opts: { align?: string; bg?: string; size?: number; muted?: boolean; padding?: string } = {},
): string {
  const align = opts.align ?? "left";
  const bg = opts.bg ?? b.surface;
  const size = opts.size ?? 16;
  const color = opts.muted ? b.muted : b.text;
  const padding = opts.padding ?? "12px 30px 0";
  return `    <mj-section background-color="${bg}" padding="${padding}">
      <mj-column>
        <mj-text color="${color}" font-family="${b.font}" font-size="${size}px" line-height="1.7" align="${align}" padding="0">${html}</mj-text>
      </mj-column>
    </mj-section>`;
}

// ── CTA button ──────────────────────────────────────────────────────────────────
export function button(
  b: Brand,
  label: string,
  href = "https://",
  opts: { align?: string; bg?: string; padding?: string } = {},
): string {
  const align = opts.align ?? "left";
  const bg = opts.bg ?? b.surface;
  const padding = opts.padding ?? "22px 30px 6px";
  return `    <mj-section background-color="${bg}" padding="${padding}">
      <mj-column>
        <mj-button href="${escAttr(
          href,
        )}" align="${align}" background-color="${b.accent}" color="${b.onAccent}" font-family="${b.font}" font-size="15px" font-weight="700" border-radius="10px" inner-padding="14px 30px" padding="0">${escText(
          label,
        )}</mj-button>
      </mj-column>
    </mj-section>`;
}

// ── a bold accent lead-in line (Morning-Brew-style list item) ────────────────────
// A robust, premium alternative to emoji bullets: a bold coloured lead phrase
// then the sentence. Renders identically in every client (no emoji font needed).
export function leadLine(
  b: Brand,
  lead: string,
  rest: string,
  opts: { bg?: string; padding?: string } = {},
): string {
  const bg = opts.bg ?? b.surface;
  const padding = opts.padding ?? "10px 30px 0";
  return `    <mj-section background-color="${bg}" padding="${padding}">
      <mj-column>
        <mj-text color="${b.text}" font-family="${b.font}" font-size="15px" line-height="1.6" padding="0"><strong style="color:${b.heading};">${escText(
          lead,
        )}</strong>&nbsp; ${escText(rest)}</mj-text>
      </mj-column>
    </mj-section>`;
}

// ── divider + spacer ────────────────────────────────────────────────────────────
export function divider(b: Brand, opts: { bg?: string; padding?: string } = {}): string {
  const bg = opts.bg ?? b.surface;
  const padding = opts.padding ?? "22px 30px";
  return `    <mj-section background-color="${bg}" padding="${padding}">
      <mj-column>
        <mj-divider border-color="${b.border}" border-width="1px" padding="0" />
      </mj-column>
    </mj-section>`;
}

export function spacer(b: Brand, height = 8, bg?: string): string {
  return `    <mj-section background-color="${bg ?? b.surface}" padding="0">
      <mj-column>
        <mj-spacer height="${height}px" />
      </mj-column>
    </mj-section>`;
}

// ── footer with the compliant unsubscribe ────────────────────────────────────────
export function footer(b: Brand, note?: string): string {
  const line =
    note ?? `You're receiving this because you're part of ${escText(b.name)}.`;
  return `    <mj-section background-color="${b.bg}" padding="26px 30px 34px">
      <mj-column>
        <mj-text color="${b.muted}" font-family="${b.font}" font-size="12px" line-height="1.7" align="center" padding="0">
          ${line}<br />
          <a href="{{unsubscribe_url}}" style="color:${b.muted};text-decoration:underline;">Unsubscribe</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="{{unsubscribe_url}}" style="color:${b.muted};text-decoration:underline;">Manage preferences</a>
        </mj-text>
        <mj-text color="${b.muted}" font-family="${b.font}" font-size="11px" line-height="1.6" align="center" padding="10px 0 0">
          ${escText(b.name)} · Christchurch, New Zealand
        </mj-text>
      </mj-column>
    </mj-section>`;
}

// ── a label:value detail row (fixtures, camp details) ────────────────────────────
export function detailRow(b: Brand, label: string, value: string, last = false): string {
  const border = last ? "" : `border-bottom:1px solid ${b.border};`;
  return `<tr>
    <td style="padding:11px 0;${border}font-family:${b.font};font-size:12px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${b.muted};">${escText(
      label,
    )}</td>
    <td style="padding:11px 0;${border}font-family:${b.font};font-size:15px;font-weight:600;color:${b.heading};text-align:right;">${escText(
      value,
    )}</td>
  </tr>`;
}

/** A framed card of label:value rows (uses mj-table so it renders everywhere). */
export function detailCard(b: Brand, rows: Array<[string, string]>, bg?: string): string {
  const body = rows
    .map(([l, v], i) => detailRow(b, l, v, i === rows.length - 1))
    .join("\n");
  return `    <mj-section background-color="${bg ?? b.surface}" padding="18px 30px 0">
      <mj-column background-color="${b.bg}" border="1px solid ${b.border}" border-radius="12px" padding="6px 20px">
        <mj-table cellpadding="0" cellspacing="0" width="100%">
${body}
        </mj-table>
      </mj-column>
    </mj-section>`;
}

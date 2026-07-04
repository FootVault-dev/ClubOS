// e-Sign v2 native typesetter. Renders a template-driven agreement (structured
// sections + merged variables + signer-filled details + signatures) straight
// to a clean A4 PDF — no uploaded source document. Used twice per document:
// at send time (blank details = the "what was sent" record that gets hashed)
// and at finalize (filled details + signatures; the certificate page is then
// appended by buildSignedPdf). The web signing page renders the SAME content
// JSON, so the page a signer reads and the PDF we archive can never diverge.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

export interface NativeTemplateContent {
  docTitle: string;
  partiesIntro: string[]; // lines; {{vars}} merged
  sections: { heading: string; items: { kind: "p" | "bullet" | "numbered"; text: string }[] }[];
  signAck: string;
  appendix?: { title: string; intro?: string; sections: { heading: string; items: { kind: "p" | "bullet"; text: string }[] }[] };
}

export interface NativeFormField {
  key: string; label: string; type: string; required?: boolean; help?: string;
}

export interface NativePartyBlock {
  role: string;                 // "The League" | "The Referee"
  name: string | null;          // typed legal name (null → unsigned placeholder)
  signatureImage?: string | null;
  signedAt?: Date | string | null;
}

export interface NativeGuardianBlock {
  name: string; relationship: string | null; signatureImage: string | null; signedAt?: Date | string | null;
}

export interface RenderNativeOpts {
  brand: Record<string, any>;   // { orgLabel, accent, accentDeep, ... }
  settings?: Record<string, any>; // { detailsHeading, counterSignerRole, ... }
  content: NativeTemplateContent;
  values: Record<string, string>; // merged variable + form values for {{key}} substitution
  formSpec: NativeFormField[];    // details schedule rows (rendered in order)
  formData: Record<string, any> | null; // null → blank lines (unsigned source render)
  refereeEmail?: string | null;
  parties: NativePartyBlock[];
  guardian?: NativeGuardianBlock | null;
  logoBytes?: Uint8Array | null;
  envelopeId?: number | null;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 56;                 // page margin
const BODY = 9.8;             // body size
const LH = 14.2;              // body line height

function hexRgb(hex: string | undefined, fallback: RGB): RGB {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function subst(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = values[k];
    return v != null && String(v).trim() !== "" ? String(v) : "______________";
  });
}

function decodePng(b64: string): Uint8Array {
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return Uint8Array.from(Buffer.from(raw, "base64"));
}

function fmtNz(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "long", timeStyle: "short" }) + " NZT";
}

export async function renderNativePdf(opts: RenderNativeOpts): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const INK = rgb(0.09, 0.09, 0.08);
  const MUTE = rgb(0.44, 0.43, 0.40);
  const LINE = rgb(0.86, 0.84, 0.79);
  const ACCENT = hexRgb(opts.brand?.accentDeep, rgb(0.66, 0.57, 0.35));   // deep gold for text accents
  const ACCENT_BRIGHT = hexRgb(opts.brand?.accent, rgb(0.82, 0.73, 0.43)); // bright gold for rules

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M;

  const newPage = () => { page = pdf.addPage([A4.w, A4.h]); y = A4.h - M; };
  const ensure = (need: number) => { if (y - need < M + 10) newPage(); };

  const wrap = (text: string, f: PDFFont, size: number, maxW: number): string[] => {
    const out: string[] = [];
    for (const hard of String(text).split("\n")) {
      const words = hard.split(/\s+/).filter(Boolean);
      if (!words.length) { out.push(""); continue; }
      let line = "";
      for (const w of words) {
        const probe = line ? `${line} ${w}` : w;
        if (f.widthOfTextAtSize(probe, size) <= maxW) line = probe;
        else { if (line) out.push(line); line = w; }
      }
      if (line) out.push(line);
    }
    return out;
  };

  const para = (text: string, o?: { size?: number; font?: PDFFont; color?: RGB; indent?: number; hang?: string; gap?: number; lh?: number }) => {
    const size = o?.size ?? BODY;
    const f = o?.font ?? font;
    const color = o?.color ?? INK;
    const indent = o?.indent ?? 0;
    const lh = o?.lh ?? LH;
    const maxW = A4.w - M * 2 - indent - (o?.hang ? f.widthOfTextAtSize(o.hang, size) : 0);
    const lines = wrap(text, f, size, maxW);
    for (let i = 0; i < lines.length; i++) {
      ensure(lh);
      const x = M + indent + (o?.hang && i > 0 ? f.widthOfTextAtSize(o.hang, size) : 0);
      const s = o?.hang && i === 0 ? `${o.hang}${lines[i]}` : lines[i];
      page.drawText(s, { x: o?.hang && i === 0 ? M + indent : x, y, size, font: f, color });
      y -= lh;
    }
    y -= o?.gap ?? 0;
  };

  const rule = (color = LINE, thickness = 0.8, gap = 14) => {
    ensure(gap + 4);
    page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness, color });
    y -= gap;
  };

  const heading = (text: string) => {
    ensure(40);
    y -= 8;
    page.drawRectangle({ x: M, y: y - 3.5, width: 18, height: 3, color: ACCENT_BRIGHT });
    y -= 16;
    para(text, { size: 12, font: bold, gap: 4 });
  };

  // ── Document header ─────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: A4.h - 10, width: A4.w, height: 10, color: ACCENT_BRIGHT });
  if (opts.logoBytes) {
    try {
      const logo = await pdf.embedPng(opts.logoBytes);
      const s = Math.min(64 / logo.width, 64 / logo.height);
      page.drawImage(logo, { x: (A4.w - logo.width * s) / 2, y: y - logo.height * s + 6, width: logo.width * s, height: logo.height * s });
      y -= logo.height * s + 14;
    } catch { /* logo optional */ }
  }
  const orgLabel = String(opts.brand?.orgLabel || "");
  if (orgLabel) {
    const w = bold.widthOfTextAtSize(orgLabel.toUpperCase(), 8.5);
    page.drawText(orgLabel.toUpperCase(), { x: (A4.w - w) / 2, y, size: 8.5, font: bold, color: ACCENT });
    y -= 22;
  }
  const titleLines = wrap(opts.content.docTitle, bold, 19, A4.w - M * 2);
  for (const l of titleLines) {
    const w = bold.widthOfTextAtSize(l, 19);
    page.drawText(l, { x: (A4.w - w) / 2, y, size: 19, font: bold, color: INK });
    y -= 24;
  }
  y -= 4;
  rule(ACCENT_BRIGHT, 1.2, 20);

  // ── Parties ─────────────────────────────────────────────────────────────
  for (const line of opts.content.partiesIntro) para(subst(line, opts.values), { gap: 2 });
  y -= 8;

  // ── Sections ────────────────────────────────────────────────────────────
  for (const sec of opts.content.sections) {
    heading(sec.heading);
    let n = 0;
    for (const item of sec.items) {
      const text = subst(item.text, opts.values);
      if (item.kind === "bullet") para(text, { hang: "•   ", indent: 6, gap: 3 });
      else if (item.kind === "numbered") { n += 1; para(text, { hang: `${n}.   `, indent: 6, gap: 3 }); }
      else para(text, { gap: 5 });
    }
    y -= 6;
  }

  // ── Details schedule ────────────────────────────────────────────────────
  if (opts.formSpec.length) {
    heading(opts.settings?.detailsHeading || "Referee Details");
    const labelW = 168;
    for (const f of opts.formSpec) {
      const raw = opts.formData?.[f.key];
      const val = raw != null && String(raw).trim() !== "" ? String(raw) : null;
      ensure(20);
      page.drawText(f.label, { x: M, y, size: 8.6, font: bold, color: MUTE });
      if (val) {
        const lines = wrap(val, font, 10, A4.w - M * 2 - labelW);
        for (let i = 0; i < lines.length; i++) {
          page.drawText(lines[i], { x: M + labelW, y, size: 10, font, color: INK });
          if (i < lines.length - 1) { y -= 13; ensure(16); }
        }
      } else {
        page.drawLine({ start: { x: M + labelW, y: y - 1.5 }, end: { x: A4.w - M, y: y - 1.5 }, thickness: 0.7, color: LINE });
      }
      y -= 19;
    }
    if (opts.refereeEmail) {
      ensure(20);
      page.drawText("Email", { x: M, y, size: 8.6, font: bold, color: MUTE });
      page.drawText(opts.refereeEmail, { x: M + labelW, y, size: 10, font, color: INK });
      y -= 19;
    }
    y -= 6;
  }

  // ── Signatures ──────────────────────────────────────────────────────────
  heading("Signatures");
  para(subst(opts.content.signAck, opts.values), { size: 9, color: MUTE, gap: 10 });

  const sigBlock = async (roleLabel: string, name: string | null, img: string | null | undefined, when: Date | string | null | undefined, sub?: string | null) => {
    ensure(96);
    const top = y;
    page.drawRectangle({ x: M, y: y - 84, width: A4.w - M * 2, height: 84, borderColor: LINE, borderWidth: 1, color: rgb(0.99, 0.985, 0.972) });
    page.drawText(roleLabel.toUpperCase(), { x: M + 14, y: top - 18, size: 8, font: bold, color: ACCENT });
    page.drawText(name || "Name: ______________________", { x: M + 14, y: top - 36, size: 11, font: bold, color: INK });
    if (sub) page.drawText(sub, { x: M + 14, y: top - 50, size: 8.5, font, color: MUTE });
    page.drawText(when ? `Signed ${fmtNz(when)}` : "Date: ______________________", { x: M + 14, y: top - 70, size: 8.5, font, color: when ? INK : MUTE });
    if (img) {
      try {
        const png = await pdf.embedPng(decodePng(img));
        const s = Math.min(180 / png.width, 54 / png.height);
        page.drawImage(png, { x: A4.w - M - 16 - png.width * s, y: top - 16 - png.height * s, width: png.width * s, height: png.height * s });
      } catch { /* bad image — leave blank */ }
    } else if (name) {
      page.drawText(name, { x: A4.w - M - 200, y: top - 46, size: 16, font: italic, color: INK });
    } else {
      page.drawLine({ start: { x: A4.w - M - 200, y: top - 52 }, end: { x: A4.w - M - 16, y: top - 52 }, thickness: 0.8, color: LINE });
      page.drawText("signature", { x: A4.w - M - 130, y: top - 62, size: 7, font, color: MUTE });
    }
    y -= 96;
  };

  for (const p of opts.parties) await sigBlock(p.role, p.name, p.signatureImage, p.signedAt);
  if (opts.guardian) {
    await sigBlock(
      "Parent / Legal Guardian (Referee is under 18)",
      opts.guardian.name,
      opts.guardian.signatureImage,
      opts.guardian.signedAt,
      opts.guardian.relationship ? `Relationship to the Referee: ${opts.guardian.relationship}` : null,
    );
    para("As parent/legal guardian of the Referee, I consent to the Referee entering into this Agreement on the terms above.", { size: 8.5, color: MUTE, gap: 6 });
  }

  // ── Appendix ────────────────────────────────────────────────────────────
  const ap = opts.content.appendix;
  if (ap) {
    newPage();
    page.drawRectangle({ x: 0, y: A4.h - 10, width: A4.w, height: 10, color: ACCENT_BRIGHT });
    const tl = wrap(ap.title, bold, 15, A4.w - M * 2);
    for (const l of tl) {
      const w = bold.widthOfTextAtSize(l, 15);
      page.drawText(l, { x: (A4.w - w) / 2, y, size: 15, font: bold, color: INK });
      y -= 20;
    }
    y -= 6;
    rule(ACCENT_BRIGHT, 1.2, 18);
    if (ap.intro) para(subst(ap.intro, opts.values), { color: MUTE, size: 9.4, gap: 8 });
    for (const sec of ap.sections) {
      heading(sec.heading);
      for (const item of sec.items) {
        const text = subst(item.text, opts.values);
        if (item.kind === "bullet") para(text, { hang: "•   ", indent: 6, gap: 3 });
        else para(text, { gap: 5 });
      }
      y -= 6;
    }
  }

  // ── Page footer ─────────────────────────────────────────────────────────
  const pages = pdf.getPages();
  pages.forEach((pg, i) => {
    const label = `${opts.content.docTitle}${opts.envelopeId ? `  ·  CLUBOS-${opts.envelopeId}` : ""}  ·  Page ${i + 1} of ${pages.length}`;
    pg.drawText(label, { x: M, y: 26, size: 7, font, color: MUTE });
  });

  return pdf.save();
}

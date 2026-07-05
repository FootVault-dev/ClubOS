// OFC Payables Declaration (Document F.05) master-PDF engine.
//
// Produces ONE collated PDF that mirrors the OFC F.05 template and carries all
// the proof:
//   1. Master declaration — branded header, the confirmation statement, the
//      "Name of Player | Signature" table, the "Name of Club Staff | Signature"
//      table (each signed member's drawn signature stamped in-cell), then the
//      club's authorised-signatory certification block.
//   2. Individual proof — one entry per member: typed name, drawn signature,
//      first-viewed + signed timestamps (NZT + UTC), IP, electronic-consent.
//   3. Certificate of Completion — envelope id, content fingerprint (SHA-256),
//      signed counts, legal basis (Contract and Commercial Law Act 2017 Pt 4).
//
// Rendered with pdf-lib in the SIU brand (gold on near-black header, cream body).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";

export interface DeclSignatory {
  name: string;
  email: string | null;
  group: "player" | "staff";
  roleTitle?: string | null;
  status: string;
  signatureName: string | null;
  signatureImage: string | null; // base64 png (with or without data: prefix)
  viewedAt?: Date | string | null;
  signedAt: Date | string | null;
  ip: string | null;
}

export interface RenderPayablesOpts {
  brand: { orgLabel: string; accent: string; accentDeep: string };
  logoBytes?: Uint8Array | null;
  title: string;            // e.g. "Confirmation of No Overdue Payables towards Players and Club Staff"
  criterion: string;        // e.g. "F.05"
  season: string | null;    // e.g. "2026/27"
  clubName: string;
  asOfDateLabel: string | null; // human date the payables are confirmed paid up to
  statement: string;        // fully-merged confirmation wording (no {{ }} left)
  signatory: {
    name: string | null;
    title: string | null;
    signatureName: string | null;
    signatureImage: string | null;
    signedAt: Date | string | null;
  };
  players: DeclSignatory[];
  staff: DeclSignatory[];
  envelopeId: number;
  docHash: string;
  completedAt: Date | string;
}

const A4 = { w: 595.28, h: 841.89 };
const M = 54;
const BODY = 10;
const LH = 14.5;

function hexRgb(hex: string | undefined, fallback: RGB): RGB {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = parseInt(hex.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function decodePng(b64: string): Uint8Array {
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return Uint8Array.from(Buffer.from(raw, "base64"));
}

function fmtNz(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "medium", timeStyle: "short" }) + " NZT";
}
function fmtStamp(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  const nz = dt.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "medium", timeStyle: "short" });
  return `${nz} (NZT)  ·  ${dt.toISOString()}`;
}

export async function renderPayablesMasterPdf(opts: RenderPayablesOpts): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const INK = rgb(0.09, 0.09, 0.08);
  const MUTE = rgb(0.44, 0.43, 0.40);
  const LINE = rgb(0.84, 0.82, 0.77);
  const PAPER = rgb(0.99, 0.985, 0.972);
  const HEADFILL = rgb(0.95, 0.95, 0.95);
  const ACCENT = hexRgb(opts.brand?.accentDeep, rgb(0.66, 0.57, 0.35));
  const ACCENT_BRIGHT = hexRgb(opts.brand?.accent, rgb(0.77, 0.6, 0.29));

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M;

  const newPage = () => { page = pdf.addPage([A4.w, A4.h]); y = A4.h - M; };
  const ensure = (need: number) => { if (y - need < M + 8) newPage(); };

  const wrap = (text: string, f: PDFFont, size: number, maxW: number): string[] => {
    const out: string[] = [];
    for (const hard of String(text ?? "").split("\n")) {
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

  const para = (text: string, o?: { size?: number; font?: PDFFont; color?: RGB; indent?: number; gap?: number; lh?: number }) => {
    const size = o?.size ?? BODY;
    const f = o?.font ?? font;
    const color = o?.color ?? INK;
    const indent = o?.indent ?? 0;
    const lh = o?.lh ?? LH;
    const lines = wrap(text, f, size, A4.w - M * 2 - indent);
    for (const l of lines) {
      ensure(lh);
      page.drawText(l, { x: M + indent, y, size, font: f, color });
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
    ensure(38);
    y -= 6;
    page.drawRectangle({ x: M, y: y - 3.5, width: 18, height: 3, color: ACCENT_BRIGHT });
    y -= 15;
    para(text, { size: 12.5, font: bold, gap: 4 });
  };

  // ── Branded header ───────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: A4.h - 10, width: A4.w, height: 10, color: ACCENT_BRIGHT });
  if (opts.logoBytes) {
    try {
      const logo = await pdf.embedPng(opts.logoBytes);
      const s = Math.min(58 / logo.width, 58 / logo.height);
      page.drawImage(logo, { x: (A4.w - logo.width * s) / 2, y: y - logo.height * s + 4, width: logo.width * s, height: logo.height * s });
      y -= logo.height * s + 12;
    } catch { /* logo optional */ }
  }
  const orgLabel = String(opts.brand?.orgLabel || "").toUpperCase();
  if (orgLabel) {
    const w = bold.widthOfTextAtSize(orgLabel, 8.5);
    page.drawText(orgLabel, { x: (A4.w - w) / 2, y, size: 8.5, font: bold, color: ACCENT });
    y -= 20;
  }
  // Criterion chip
  const chip = `OFC CLUB LICENSING · DOCUMENT ${opts.criterion}`;
  const chipW = bold.widthOfTextAtSize(chip, 7.5) + 16;
  page.drawRectangle({ x: (A4.w - chipW) / 2, y: y - 3, width: chipW, height: 15, color: rgb(0.12, 0.12, 0.11) });
  page.drawText(chip, { x: (A4.w - chipW) / 2 + 8, y, size: 7.5, font: bold, color: rgb(0.85, 0.7, 0.36) });
  y -= 24;
  // Title
  for (const l of wrap(opts.title, bold, 18, A4.w - M * 2)) {
    const w = bold.widthOfTextAtSize(l, 18);
    page.drawText(l, { x: (A4.w - w) / 2, y, size: 18, font: bold, color: INK });
    y -= 22;
  }
  y -= 4;
  rule(ACCENT_BRIGHT, 1.2, 18);

  // ── Statement ────────────────────────────────────────────────────────────
  para(opts.statement, { gap: 6 });
  const metaLine = [opts.season ? `Season: ${opts.season}` : null, opts.asOfDateLabel ? `Paid up to: ${opts.asOfDateLabel}` : null]
    .filter(Boolean).join("      ");
  if (metaLine) para(metaLine, { size: 9, color: MUTE, gap: 6 });
  y -= 4;

  // ── Roster table ─────────────────────────────────────────────────────────
  const nameW = (A4.w - M * 2) * 0.58;
  const sigW = (A4.w - M * 2) - nameW;
  const ROWH = 32;

  const tableHeader = (leftLabel: string) => {
    ensure(ROWH + 6);
    page.drawRectangle({ x: M, y: y - 20, width: A4.w - M * 2, height: 20, color: HEADFILL, borderColor: LINE, borderWidth: 0.8 });
    page.drawText(leftLabel, { x: M + 8, y: y - 14, size: 9, font: bold, color: INK });
    page.drawText("Signature", { x: M + nameW + sigW / 2 - bold.widthOfTextAtSize("Signature", 9) / 2, y: y - 14, size: 9, font: bold, color: INK });
    // vertical divider header
    page.drawLine({ start: { x: M + nameW, y }, end: { x: M + nameW, y: y - 20 }, thickness: 0.8, color: LINE });
    y -= 20;
  };

  const tableRow = async (s: DeclSignatory, index: number) => {
    if (y - ROWH < M + 8) { newPage(); }
    const top = y;
    const signed = s.status === "signed" && (s.signatureImage || s.signatureName);
    // row border
    page.drawRectangle({ x: M, y: top - ROWH, width: A4.w - M * 2, height: ROWH, borderColor: LINE, borderWidth: 0.7, color: index % 2 ? PAPER : rgb(1, 1, 1) });
    page.drawLine({ start: { x: M + nameW, y: top }, end: { x: M + nameW, y: top - ROWH }, thickness: 0.7, color: LINE });
    // name (+ optional role)
    page.drawText(String(s.name).slice(0, 60), { x: M + 8, y: top - 14, size: 10, font: bold, color: INK });
    const sub = [s.roleTitle || null, s.signedAt ? `signed ${fmtNz(s.signedAt)}` : (signed ? null : "not yet signed")].filter(Boolean).join("  ·  ");
    if (sub) page.drawText(sub.slice(0, 70), { x: M + 8, y: top - 25, size: 7, font, color: MUTE });
    // signature
    if (signed && s.signatureImage) {
      try {
        const png = await pdf.embedPng(decodePng(s.signatureImage));
        const scale = Math.min((sigW - 16) / png.width, (ROWH - 8) / png.height);
        page.drawImage(png, { x: M + nameW + 8, y: top - ROWH + (ROWH - png.height * scale) / 2, width: png.width * scale, height: png.height * scale });
      } catch { /* fall through to typed */ }
    } else if (signed && s.signatureName) {
      page.drawText(s.signatureName.slice(0, 32), { x: M + nameW + 10, y: top - 20, size: 13, font: italic, color: INK });
    } else {
      page.drawText("—", { x: M + nameW + sigW / 2 - 3, y: top - 20, size: 10, font, color: LINE });
    }
    y -= ROWH;
  };

  // Players
  heading(`Players  (${opts.players.filter((p) => p.status === "signed").length}/${opts.players.length} signed)`);
  if (opts.players.length) {
    tableHeader("Name of Player");
    for (let i = 0; i < opts.players.length; i++) await tableRow(opts.players[i], i);
  } else {
    para("No players added.", { size: 9, color: MUTE });
  }
  y -= 12;

  // Staff
  heading(`Club Staff  (${opts.staff.filter((p) => p.status === "signed").length}/${opts.staff.length} signed)`);
  if (opts.staff.length) {
    tableHeader("Name of Club Staff");
    for (let i = 0; i < opts.staff.length; i++) await tableRow(opts.staff[i], i);
  } else {
    para("No club staff added.", { size: 9, color: MUTE });
  }
  y -= 14;

  // ── Certification block ──────────────────────────────────────────────────
  heading("Certification by the Club");
  para("I certify that the information provided above is true and correct to the best of my knowledge.", { size: 9.5, gap: 10 });
  {
    ensure(104);
    const top = y;
    page.drawRectangle({ x: M, y: top - 92, width: A4.w - M * 2, height: 92, borderColor: LINE, borderWidth: 1, color: PAPER });
    page.drawText("AUTHORISED SIGNATORY OF THE CLUB", { x: M + 14, y: top - 18, size: 8, font: bold, color: ACCENT });
    page.drawText(opts.signatory.name || "Name: ______________________", { x: M + 14, y: top - 36, size: 11, font: bold, color: INK });
    if (opts.signatory.title) page.drawText(opts.signatory.title, { x: M + 14, y: top - 50, size: 8.5, font, color: MUTE });
    page.drawText(opts.clubName, { x: M + 14, y: top - 62, size: 8.5, font, color: MUTE });
    page.drawText(opts.signatory.signedAt ? `Signed ${fmtNz(opts.signatory.signedAt)}` : "Date: ______________________",
      { x: M + 14, y: top - 78, size: 8.5, font, color: opts.signatory.signedAt ? INK : MUTE });
    if (opts.signatory.signatureImage) {
      try {
        const png = await pdf.embedPng(decodePng(opts.signatory.signatureImage));
        const s = Math.min(190 / png.width, 58 / png.height);
        page.drawImage(png, { x: A4.w - M - 16 - png.width * s, y: top - 16 - png.height * s, width: png.width * s, height: png.height * s });
      } catch { /* ignore */ }
    } else if (opts.signatory.signatureName) {
      page.drawText(opts.signatory.signatureName, { x: A4.w - M - 210, y: top - 46, size: 16, font: italic, color: INK });
    }
    y -= 104;
  }

  // ── Individual proof ─────────────────────────────────────────────────────
  newPage();
  page.drawRectangle({ x: 0, y: A4.h - 10, width: A4.w, height: 10, color: ACCENT_BRIGHT });
  para("Individual Declarations — Proof of Signature", { size: 15, font: bold, gap: 2 });
  para("Each person below signed the confirmation statement electronically on their own device. This is the per-person evidence supporting the roster above.",
    { size: 8.6, color: MUTE, gap: 8 });
  rule(ACCENT_BRIGHT, 1, 14);

  const all = [
    ...opts.players.map((p) => ({ ...p, groupLabel: "Player" })),
    ...opts.staff.map((p) => ({ ...p, groupLabel: "Club Staff" })),
  ].filter((s) => s.status === "signed");

  let n = 0;
  for (const s of all) {
    n += 1;
    const cardH = 88;
    if (y - (cardH + 12) < M + 8) newPage();
    const top = y;
    page.drawRectangle({ x: M, y: top - cardH, width: A4.w - M * 2, height: cardH, borderColor: LINE, borderWidth: 1, color: PAPER });
    let cy = top - 16;
    page.drawText(`${n}.  ${s.name}`, { x: M + 12, y: cy, size: 10.5, font: bold, color: INK });
    page.drawText(s.groupLabel, { x: A4.w - M - 12 - font.widthOfTextAtSize(s.groupLabel, 8), y: cy, size: 8, font, color: ACCENT });
    cy -= 14;
    if (s.email) { page.drawText(s.email, { x: M + 12, y: cy, size: 8.5, font, color: MUTE }); cy -= 14; } else { cy -= 2; }
    const rows: [string, string][] = [];
    if (s.viewedAt) rows.push(["First viewed", fmtStamp(s.viewedAt)]);
    rows.push(["Signed", fmtStamp(s.signedAt)]);
    rows.push(["IP address", s.ip || "—"]);
    rows.push(["Typed name", s.signatureName || "—"]);
    for (const [k, v] of rows) {
      page.drawText(k, { x: M + 12, y: cy, size: 7.5, font: bold, color: MUTE });
      page.drawText(v, { x: M + 74, y: cy, size: 7.7, font, color: INK });
      cy -= 11.5;
    }
    // signature thumb
    if (s.signatureImage) {
      try {
        const png = await pdf.embedPng(decodePng(s.signatureImage));
        const scale = Math.min(150 / png.width, 50 / png.height);
        page.drawImage(png, { x: A4.w - M - 12 - png.width * scale, y: top - cardH + 12, width: png.width * scale, height: png.height * scale });
      } catch { /* ignore */ }
    }
    y -= cardH + 12;
  }
  if (!all.length) para("No individual signatures captured yet.", { size: 9, color: MUTE });

  // ── Certificate of Completion ────────────────────────────────────────────
  newPage();
  page.drawRectangle({ x: 0, y: A4.h - 10, width: A4.w, height: 10, color: ACCENT_BRIGHT });
  para("Certificate of Completion", { size: 16, font: bold, gap: 2 });
  para("Electronic signature record", { size: 9, color: MUTE, gap: 8 });
  rule(ACCENT_BRIGHT, 1, 16);
  const pSigned = opts.players.filter((p) => p.status === "signed").length;
  const sSigned = opts.staff.filter((p) => p.status === "signed").length;
  const certMeta: [string, string][] = [
    ["Document", `${opts.title} (F.${opts.criterion.replace(/^F\./, "")})`.replace("F.F.", "F.")],
    ["Envelope ID", `CLUBOS-DECL-${opts.envelopeId}`],
    ["Content fingerprint (SHA-256)", opts.docHash || "—"],
    ["Players signed", `${pSigned} of ${opts.players.length}`],
    ["Club staff signed", `${sSigned} of ${opts.staff.length}`],
    ["Certified by", opts.signatory.name ? `${opts.signatory.name}${opts.signatory.title ? `, ${opts.signatory.title}` : ""}` : "—"],
    ["Completed", fmtStamp(opts.completedAt)],
  ];
  for (const [k, v] of certMeta) {
    ensure(18);
    page.drawText(k, { x: M, y, size: 8, font: bold, color: MUTE });
    const val = v.length > 64 ? (v.match(/.{1,64}/g) || [v]) : [v];
    page.drawText(val[0], { x: M + 190, y, size: 8.5, font, color: INK });
    for (let i = 1; i < val.length; i++) { y -= 11; page.drawText(val[i], { x: M + 190, y, size: 8.5, font, color: INK }); }
    y -= 17;
  }
  y -= 6;
  rule(LINE, 1, 16);
  const legal = [
    "Each person consented to do business electronically and to sign this declaration by electronic means.",
    "This electronic signature record is made under Part 4 of the Contract and Commercial Law Act 2017 (New Zealand).",
    "The content fingerprint above lets any party verify the signed roster and statement have not been altered.",
  ];
  for (const l of legal) { ensure(12); para(l, { size: 7.6, color: MUTE, lh: 11 }); }

  // ── Footers ──────────────────────────────────────────────────────────────
  const pages = pdf.getPages();
  pages.forEach((pg, i) => {
    const label = `${opts.title}  ·  OFC ${opts.criterion}  ·  CLUBOS-DECL-${opts.envelopeId}  ·  Page ${i + 1} of ${pages.length}`;
    pg.drawText(label.slice(0, 120), { x: M, y: 24, size: 6.6, font, color: MUTE });
  });

  return pdf.save();
}

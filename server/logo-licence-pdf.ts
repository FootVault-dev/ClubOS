// Signed Club Crest & Logo Licence — PDF proof.
// Renders one clean, formal A4 document per signed consent: the full licence
// text the club agreed to, the signatory's details, and a Certificate of Signing
// (typed e-signature, timestamp in NZT + UTC, IP, device, licence version and a
// SHA-256 fingerprint of exactly what was signed). This is the artefact we hand
// an Apple App Store / Google Play reviewer as evidence we hold rights to display
// each third-party club crest in the CIC Youth app. Built with the same pdf-lib
// approach as the e-Sign certificate (server/esign-native-pdf.ts).
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { LogoLicence } from "./logo-licence";

const A4 = { w: 595.28, h: 841.89 };
const M = 54;                     // page margin
const CONTENT_W = A4.w - M * 2;
const GOLD: RGB = rgb(0.788, 0.643, 0.243);   // #C9A43E
const INK: RGB = rgb(0.078, 0.082, 0.067);    // #141511
const MUTE: RGB = rgb(0.42, 0.42, 0.40);
const HAIR: RGB = rgb(0.85, 0.85, 0.82);

export interface LogoLicencePdfInput {
  licence: LogoLicence;
  consentId: number;
  clubName: string;
  repName: string;
  repRole?: string | null;
  repEmail: string;
  repPhone?: string | null;
  signatureName: string;
  licenceVersion: string;
  agreedAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
  documentHash: string;
  logoPngBytes?: Uint8Array | null; // crest, pre-converted to PNG by the caller
}

function wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxW && line) { out.push(line); line = w; }
      else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

const nzDate = (d: Date) =>
  d.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true }) + " NZT";

export async function buildLogoLicencePdf(input: LogoLicencePdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Club Crest & Logo Licence — ${input.clubName}`);
  pdf.setAuthor("Christchurch United Football Club Incorporated");
  pdf.setSubject(`Signed logo licence v${input.licenceVersion}`);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M;

  const newPage = () => { page = pdf.addPage([A4.w, A4.h]); y = A4.h - M; };
  const need = (h: number) => { if (y - h < M + 40) newPage(); };

  const text = (s: string, x: number, size: number, f: PDFFont, color: RGB) =>
    page.drawText(s, { x, y, size, font: f, color });

  const paragraph = (s: string, size: number, f: PDFFont, color: RGB, lh: number, maxW = CONTENT_W, x = M) => {
    for (const line of wrap(s, f, size, maxW)) {
      need(lh);
      page.drawText(line, { x, y, size, font: f, color });
      y -= lh;
    }
  };

  // ── Header band ──
  page.drawRectangle({ x: 0, y: A4.h - 96, width: A4.w, height: 96, color: INK });
  page.drawRectangle({ x: 0, y: A4.h - 100, width: A4.w, height: 4, color: GOLD });
  page.drawText("CHRISTCHURCH INTERNATIONAL CUP", { x: M, y: A4.h - 44, size: 13, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Club Crest & Logo Licence", { x: M, y: A4.h - 66, size: 10.5, font: font, color: GOLD });
  page.drawText(`v${input.licenceVersion}`, { x: A4.w - M - font.widthOfTextAtSize(`v${input.licenceVersion}`, 10), y: A4.h - 44, size: 10, font: font, color: rgb(0.75, 0.75, 0.72) });
  page.drawText(`Ref CIC-LL-${String(input.consentId).padStart(4, "0")}`, { x: A4.w - M - font.widthOfTextAtSize(`Ref CIC-LL-${String(input.consentId).padStart(4, "0")}`, 9), y: A4.h - 62, size: 9, font: font, color: rgb(0.6, 0.6, 0.58) });
  y = A4.h - 100 - 26;

  // ── Parties / intro ──
  paragraph(
    `This agreement records the permission granted by ${input.clubName} ("the Club") to Christchurch United Football Club Incorporated and its related clubs, brands and affiliated entities.`,
    10, font, INK, 14);
  y -= 6;
  paragraph(input.licence.intro, 9.5, font, MUTE, 13);
  y -= 12;

  // ── Licence clauses ──
  input.licence.clauses.forEach((c, i) => {
    need(40);
    page.drawText(`${i + 1}.  ${c.h}`, { x: M, y, size: 10.5, font: bold, color: INK });
    y -= 15;
    paragraph(c.p, 9.5, font, rgb(0.2, 0.2, 0.18), 13.5, CONTENT_W - 8, M + 8);
    y -= 10;
  });

  // ── Signatory + crest block ──
  need(150);
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.8, color: HAIR });
  y -= 22;
  page.drawText("SIGNED BY", { x: M, y, size: 9, font: bold, color: GOLD });
  y -= 18;

  const field = (label: string, value: string) => {
    need(16);
    page.drawText(label, { x: M, y, size: 9, font: font, color: MUTE });
    page.drawText(value, { x: M + 120, y, size: 10, font: bold, color: INK });
    y -= 16;
  };
  field("Club", input.clubName);
  field("Representative", input.repName);
  if (input.repRole) field("Role", input.repRole);
  field("Email", input.repEmail);
  if (input.repPhone) field("Phone", input.repPhone);

  // Embedded crest (right side of the signatory block), if provided.
  if (input.logoPngBytes) {
    try {
      const img = await pdf.embedPng(input.logoPngBytes);
      const box = 92;
      const scale = Math.min(box / img.width, box / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      const bx = A4.w - M - box, by = y + 16 + (box - h) / 2;
      page.drawRectangle({ x: A4.w - M - box, y: y + 16, width: box, height: box, color: rgb(0.97, 0.97, 0.95), borderColor: HAIR, borderWidth: 0.8 });
      page.drawImage(img, { x: bx + (box - w) / 2, y: by, width: w, height: h });
    } catch { /* ignore un-embeddable crest */ }
  }

  y -= 8;
  page.drawText("Digital signature", { x: M, y, size: 9, font: font, color: MUTE });
  y -= 20;
  page.drawText(input.signatureName, { x: M + 6, y, size: 20, font: italic, color: INK });
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + 240, y }, thickness: 0.8, color: HAIR });
  y -= 26;

  // ── Certificate of signing ──
  need(150);
  page.drawRectangle({ x: M, y: y - 128, width: CONTENT_W, height: 132, color: rgb(0.98, 0.98, 0.96), borderColor: HAIR, borderWidth: 0.8 });
  const cy0 = y;
  y -= 4;
  page.drawText("CERTIFICATE OF SIGNING", { x: M + 14, y: y - 12, size: 9, font: bold, color: GOLD });
  y -= 30;
  const cert = (label: string, value: string) => {
    page.drawText(label, { x: M + 14, y, size: 8.5, font: font, color: MUTE });
    for (const [i, line] of wrap(value, font, 8.5, CONTENT_W - 170).entries()) {
      page.drawText(line, { x: M + 150, y: y - i * 11, size: 8.5, font: i === 0 ? bold : font, color: INK });
    }
    const lines = wrap(value, font, 8.5, CONTENT_W - 170).length;
    y -= Math.max(15, lines * 11 + 4);
  };
  cert("Signed at", nzDate(input.agreedAt) + `  (${input.agreedAt.toISOString()} UTC)`);
  cert("Licence version", `v${input.licenceVersion}`);
  cert("IP address", input.ipAddress || "—");
  cert("Device", (input.userAgent || "—").slice(0, 120));
  cert("Document SHA-256", input.documentHash);
  void cy0;
  y -= 14;

  // ── Governing-law footer on every page ──
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(input.licence.governingLaw, { x: M, y: 40, size: 7, font: font, color: MUTE, maxWidth: CONTENT_W, lineHeight: 9 });
    p.drawText(`Christchurch United Football Club Incorporated · Christchurch, New Zealand · Page ${i + 1} of ${pages.length}`, { x: M, y: 22, size: 7, font: font, color: rgb(0.6, 0.6, 0.58) });
  });

  return pdf.save();
}

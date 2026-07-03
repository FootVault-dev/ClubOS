// e-Sign PDF engine. Takes the original document and produces the final signed
// PDF = original pages + an appended "Certificate of Completion" page that
// records every signer's identity, signature (typed + drawn), timestamp, IP,
// and the document's SHA-256 — the tamper-evidence + audit artefact that gives
// the electronic signature its weight under the Contract and Commercial Law
// Act 2017 (Part 4).
import crypto from "crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface CertSigner {
  name: string;
  email: string;
  signatureName: string | null;
  signatureImage: string | null; // data URL or raw base64 PNG
  signedAt: Date | string | null;
  viewedAt?: Date | string | null; // first opened — evidences the review window before signing
  ip: string | null;
}

const GOLD = rgb(0.788, 0.643, 0.243); // #C9A43E
const INK = rgb(0.08, 0.08, 0.07);
const MUTE = rgb(0.42, 0.42, 0.40);
const LINE = rgb(0.85, 0.83, 0.78);

function fmtStamp(d: Date | string | null): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  // NZ local + UTC for an unambiguous record.
  const nz = dt.toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", dateStyle: "medium", timeStyle: "short" });
  return `${nz} (NZT)  ·  ${dt.toISOString()}`;
}

function decodePng(b64: string): Uint8Array {
  const raw = b64.includes(",") ? b64.split(",")[1] : b64;
  return Uint8Array.from(Buffer.from(raw, "base64"));
}

export interface FieldStamp {
  page: number; x: number; y: number; w: number; h: number;
  type: string; value: string | null; valueImage: string | null;
}

/**
 * Build the final signed PDF: stamps the filled fields onto the original
 * pages, then appends the Certificate of Completion.
 */
export async function buildSignedPdf(opts: {
  sourcePdf: Uint8Array | Buffer;
  title: string;
  docHash: string;
  envelopeId: number;
  signers: CertSigner[];
  fields?: FieldStamp[];
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(opts.sourcePdf);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // ── Stamp filled fields onto the original pages (before the certificate). ──
  // Coordinates arrive normalized 0..1 with y from the top; PDF origin is
  // bottom-left, so we flip y.
  if (opts.fields?.length) {
    const pages = pdf.getPages();
    for (const f of opts.fields) {
      const pg = pages[f.page];
      if (!pg) continue;
      const { width: pw, height: ph } = pg.getSize();
      const bx = f.x * pw, bw = f.w * pw, bh = f.h * ph;
      const byBottom = ph - (f.y * ph) - bh;
      try {
        if (f.type === "signature" || f.type === "initials") {
          if (f.valueImage) {
            const img = await pdf.embedPng(decodePng(f.valueImage));
            const scale = Math.min(bw / img.width, bh / img.height);
            const dw = img.width * scale, dh = img.height * scale;
            pg.drawImage(img, { x: bx + (bw - dw) / 2, y: byBottom + (bh - dh) / 2, width: dw, height: dh });
          } else if (f.value) {
            pg.drawText(f.value, { x: bx + 2, y: byBottom + bh * 0.28, size: Math.min(bh * 0.7, 16), font, color: INK });
          }
        } else if (f.type === "checkbox") {
          if (f.value === "true") pg.drawText("X", { x: bx + bw * 0.2, y: byBottom + bh * 0.15, size: Math.min(bh, bw) * 0.85, font: bold, color: INK });
        } else if (f.value) { // text | date
          pg.drawText(String(f.value).slice(0, 200), { x: bx + 2, y: byBottom + bh * 0.28, size: Math.min(bh * 0.62, 11), font, color: INK });
        }
      } catch { /* skip a bad field/image, keep going */ }
    }
  }

  const A4 = { w: 595.28, h: 841.89 };
  const margin = 48;
  let page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - margin;

  const text = (s: string, x: number, yy: number, size = 10, f: PDFFont = font, color = INK) =>
    page.drawText(s, { x, y: yy, size, font: f, color });

  const ensureSpace = (need: number) => {
    if (y - need < margin) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - margin;
      header(true);
    }
  };

  const header = (cont = false) => {
    page.drawRectangle({ x: 0, y: A4.h - 8, width: A4.w, height: 8, color: GOLD });
    text("CERTIFICATE OF COMPLETION", margin, y, 16, bold, INK);
    y -= 16;
    text(`Electronic signature record${cont ? " (continued)" : ""}`, margin, y, 9, font, MUTE);
    y -= 22;
    page.drawLine({ start: { x: margin, y }, end: { x: A4.w - margin, y }, thickness: 1, color: LINE });
    y -= 20;
  };

  header();

  // Document summary
  text("Document", margin, y, 8, bold, MUTE); y -= 14;
  text(opts.title.slice(0, 90), margin, y, 12, bold, INK); y -= 20;

  const meta: [string, string][] = [
    ["Envelope ID", `CLUBOS-${opts.envelopeId}`],
    ["Document fingerprint (SHA-256)", opts.docHash],
    ["Signers", String(opts.signers.length)],
    ["Completed", fmtStamp(new Date())],
  ];
  for (const [k, v] of meta) {
    ensureSpace(16);
    text(k, margin, y, 8, bold, MUTE);
    // wrap long hash
    const val = v.length > 70 ? v.match(/.{1,70}/g)! : [v];
    text(val[0], margin + 170, y, 8.5, font, INK);
    for (let i = 1; i < val.length; i++) { y -= 11; text(val[i], margin + 170, y, 8.5, font, INK); }
    y -= 16;
  }

  y -= 6;
  ensureSpace(24);
  page.drawLine({ start: { x: margin, y }, end: { x: A4.w - margin, y }, thickness: 1, color: LINE });
  y -= 22;
  text("Signers", margin, y, 11, bold, INK); y -= 20;

  for (let i = 0; i < opts.signers.length; i++) {
    const s = opts.signers[i];
    const cardH = s.viewedAt ? 109 : 96;
    ensureSpace(cardH + 16);
    // card border
    const cardTop = y;
    page.drawRectangle({ x: margin, y: y - cardH, width: A4.w - margin * 2, height: cardH, borderColor: LINE, borderWidth: 1, color: rgb(0.99, 0.985, 0.97) });
    let cy = cardTop - 16;
    text(`${i + 1}.  ${s.name}`, margin + 12, cy, 11, bold, INK); cy -= 14;
    text(s.email, margin + 12, cy, 9, font, MUTE); cy -= 16;
    if (s.viewedAt) { text("First viewed", margin + 12, cy, 8, bold, MUTE); text(fmtStamp(s.viewedAt), margin + 70, cy, 8, font, INK); cy -= 13; }
    text("Signed", margin + 12, cy, 8, bold, MUTE); text(fmtStamp(s.signedAt), margin + 70, cy, 8, font, INK); cy -= 13;
    text("IP address", margin + 12, cy, 8, bold, MUTE); text(s.ip || "—", margin + 70, cy, 8, font, INK); cy -= 13;
    text("Typed name", margin + 12, cy, 8, bold, MUTE); text(s.signatureName || "—", margin + 70, cy, 9, bold, INK);

    // drawn signature image, right side of card
    if (s.signatureImage) {
      try {
        const png = await pdf.embedPng(decodePng(s.signatureImage));
        const maxW = 170, maxH = 56;
        const scaled = png.scale(Math.min(maxW / png.width, maxH / png.height));
        page.drawImage(png, { x: A4.w - margin - 12 - scaled.width, y: cardTop - 12 - scaled.height, width: scaled.width, height: scaled.height });
        text("signature", A4.w - margin - 12 - 60, cardTop - cardH + 10, 7, font, MUTE);
      } catch { /* ignore bad image */ }
    }
    y -= cardH + 14;
  }

  // Legal footer
  ensureSpace(60);
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: A4.w - margin, y }, thickness: 1, color: LINE });
  y -= 16;
  const legal = [
    "Each signer consented to do business electronically and to sign this document by electronic means.",
    "This electronic signature record is made under Part 4 of the Contract and Commercial Law Act 2017 (NZ).",
    "The document fingerprint above lets any party verify the signed content has not been altered.",
  ];
  for (const l of legal) { ensureSpace(12); text(l, margin, y, 7.5, font, MUTE); y -= 11; }

  return pdf.save();
}

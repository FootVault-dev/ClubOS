// ─────────────────────────────────────────────────────────────────────────────
// Minimal reader for Office files (.docx / .pptx) — enough to pull their TEXT.
//
// An OOXML file is a ZIP containing XML. Node ships zlib, so this needs no new
// dependency: find the entry in the central directory, inflate it, strip tags.
// 1,052 of the club's imported documents are .docx or .pptx — a quarter of the
// drive — and without this they are findable only by filename.
//
// Deliberately NOT a general ZIP library. It reads stored (0) and deflated (8)
// entries, which is everything Word and PowerPoint produce, and refuses
// anything else rather than guessing.
// ─────────────────────────────────────────────────────────────────────────────
import { inflateRawSync } from "zlib";

interface ZipEntry { name: string; offset: number; method: number; compSize: number; }

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;

/** Walk the central directory. Returns every entry's name and where its data is. */
function readCentralDirectory(buf: Buffer): ZipEntry[] {
  // The EOCD sits at the end, after a comment of up to 64KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");

  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate
  // record. Large .pptx decks genuinely hit this.
  if (cdOffset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === SIG_EOCD64_LOCATOR) {
        const eocd64 = Number(buf.readBigUInt64LE(i + 8));
        count = Number(buf.readBigUInt64LE(eocd64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(eocd64 + 48));
        break;
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      offset: localOffset, method, compSize,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's — always re-read them here.
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${e.method}`);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");   // last, so &amp;lt; doesn't become <
}

/**
 * Pull the actual TEXT RUNS out, rather than stripping every tag.
 *
 * 🔴 Blanket tag-stripping looks equivalent and isn't: OOXML carries drawing
 * and layout XML whose numeric attributes end up glued to real words
 * ("6070608138160GENERAL MANAGER"), which pollutes the search index and makes
 * snippets unreadable. Word and PowerPoint both put visible text in <w:t> and
 * <a:t> elements, so reading only those gives clean prose.
 *
 * Paragraph ends and breaks become newlines so the result reads like the
 * document rather than one run-on line.
 */
function xmlToText(xml: string): string {
  const out: string[] = [];
  // Text runs, paragraph ends, tabs and breaks, in document order.
  const re = /<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>|<\/(?:w|a):p>|<w:tab[^>]*\/>|<(?:w|a):br[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) out.push(unescapeXml(m[1]));
    else if (m[0].startsWith("<w:tab")) out.push("\t");
    else out.push("\n");
  }
  return out.join("");
}

/** Text of a .docx, or null if this isn't one. */
export function docxText(buf: Buffer): string | null {
  const entries = readCentralDirectory(buf);
  const parts: string[] = [];
  // The body, plus headers/footers where a lot of club letterhead detail lives.
  for (const e of entries) {
    if (e.name === "word/document.xml" || /^word\/(header|footer)\d*\.xml$/.test(e.name)) {
      parts.push(xmlToText(readEntry(buf, e).toString("utf8")));
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Text of a .pptx — every slide, plus its speaker notes. */
export function pptxText(buf: Buffer): string | null {
  const entries = readCentralDirectory(buf)
    .filter((e) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(e.name))
    // slide2 must not sort before slide10 as a string would have it.
    .sort((a, b) => (Number(a.name.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.name.match(/(\d+)\.xml$/)?.[1] ?? 0)));
  const parts = entries.map((e) => xmlToText(readEntry(buf, e).toString("utf8")));
  return parts.length ? parts.join("\n\n") : null;
}

/** Dispatch on the file's own name. Returns null when it isn't an OOXML type. */
export function ooxmlText(buf: Buffer, filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "docx") return docxText(buf);
  if (ext === "pptx") return pptxText(buf);
  return null;
}

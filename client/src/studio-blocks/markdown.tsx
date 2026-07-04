// USG Studio — SAFE-SUBSET markdown renderer.
//
// `bodyMd` fields are a constrained markdown subset. This renderer produces
// React elements ONLY — it NEVER uses dangerouslySetInnerHTML, so no raw HTML,
// scripts, or event handlers in the source can ever execute. No markdown lib is
// a ClubOS dependency, so this is a tiny hand-written parser.
//
// Supported: paragraphs, unordered lists (- / *), ordered lists (1.),
// **bold**, *italic* / _italic_, and [text](url) links (http/https/mailto/
// relative only — every other scheme, incl. javascript:, is rendered as plain
// text). Anything else is passed through verbatim as text.
import { type ReactNode } from "react";

/** Only allow safe link targets. Returns null for anything suspicious. */
function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (!href) return null;
  // relative paths and in-page anchors are fine
  if (href.startsWith("/") || href.startsWith("#")) return href;
  // explicit safe schemes only
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:[^\s]+@[^\s]+/i.test(href)) return href;
  return null; // javascript:, data:, vbscript:, etc. → not a link
}

/** Inline parse: **bold**, *italic* / _italic_, [text](url). Recurses safely. */
function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: links, then bold, then the two italic forms.
  const re = /(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+?)\*\*)|(\*([^*\n]+?)\*)|(_([^_\n]+?)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      const href = safeHref(m[3]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {m[2]}
          </a>
        ) : (
          // unsafe target — keep the visible text, drop the link
          <span key={k}>{m[2]}</span>
        ),
      );
    } else if (m[4] !== undefined) {
      out.push(<strong key={k}>{parseInline(m[5], k)}</strong>);
    } else if (m[6] !== undefined) {
      out.push(<em key={k}>{parseInline(m[7], k)}</em>);
    } else if (m[8] !== undefined) {
      out.push(<em key={k}>{parseInline(m[9], k)}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const UL_RE = /^\s*[-*]\s+(.*)$/;
const OL_RE = /^\s*\d+\.\s+(.*)$/;

/**
 * Render a safe-subset markdown string to React nodes. Blocks are separated by
 * blank lines; a block whose lines are all list items becomes a <ul>/<ol>.
 */
export function renderBodyMd(md: string): ReactNode {
  if (!md) return null;
  const blocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return blocks.map((block, bi) => {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;

    const allUl = lines.every((l) => UL_RE.test(l));
    const allOl = lines.every((l) => OL_RE.test(l));

    if (allUl) {
      return (
        <ul key={`b${bi}`}>
          {lines.map((l, li) => (
            <li key={li}>{parseInline(l.replace(UL_RE, "$1"), `b${bi}-${li}`)}</li>
          ))}
        </ul>
      );
    }
    if (allOl) {
      return (
        <ol key={`b${bi}`}>
          {lines.map((l, li) => (
            <li key={li}>{parseInline(l.replace(OL_RE, "$1"), `b${bi}-${li}`)}</li>
          ))}
        </ol>
      );
    }
    // paragraph — join wrapped lines with spaces
    return <p key={`b${bi}`}>{parseInline(lines.join(" "), `b${bi}`)}</p>;
  });
}

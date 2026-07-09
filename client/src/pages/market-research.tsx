import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Telescope, AlertTriangle, CheckCircle2, XCircle, Link2,
  DollarSign, Map, Gift, Lightbulb, FileWarning, Quote, Layers,
} from "lucide-react";

// ── Types (match /api/admin/market-research) ─────────────────────────────────
interface SourceRow { source: string; status: "working" | "rate_limited" | "blocked"; detail: string }
interface SourcesPayload {
  probedAt: string;
  working: SourceRow[];
  // Rate-limited is NOT blocked: the source works, our own fleet saturated it.
  // Listing it as blocked would claim its data isn't in the report, when it is.
  rate_limited?: SourceRow[];
  blocked: SourceRow[];
  note: string;
}
interface Vertical {
  slug: string;
  title: string;
  vertical: string;
  competitors_analysed?: number;
  competitors_unreachable?: number;
  price_ladder: string;
  positioning_map: string;
  offer_patterns?: string;
  white_space: string;
  our_position?: string;
  evidence_gaps: string;
  notable_verbatims?: string[];
}
interface Response {
  seeded: boolean;
  message?: string;
  generatedAt?: string;
  sources: SourcesPayload | null;
  master: { markdown: string } | null;
  verticals: Vertical[];
}

const fmtDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

// ── Minimal markdown renderer ────────────────────────────────────────────────
// Deliberately dependency-free. Handles exactly what the research briefs emit:
// headings, tables, lists, bold, inline code, links, paragraphs. Anything else
// falls through as plain text rather than rendering broken markup.
function inline(s: string, key: string) {
  const nodes: React.ReactNode[] = [];
  // Split on links first, then style what's left. Order matters: a link label
  // can contain bold, but a bold run must not swallow a link's brackets.
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  const styled = (txt: string, k: string) => {
    const out: React.ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let l = 0, mm: RegExpExecArray | null, j = 0;
    while ((mm = re.exec(txt))) {
      if (mm.index > l) out.push(txt.slice(l, mm.index));
      const t = mm[0];
      if (t.startsWith("**")) out.push(<strong key={`${k}b${j++}`} className="text-white/90 font-semibold">{t.slice(2, -2)}</strong>);
      else out.push(<code key={`${k}c${j++}`} className="px-1 py-0.5 rounded bg-white/[0.06] text-[11px] text-cyan-200/90">{t.slice(1, -1)}</code>);
      l = mm.index + t.length;
    }
    if (l < txt.length) out.push(txt.slice(l));
    return out;
  };
  while ((m = linkRe.exec(s))) {
    if (m.index > last) nodes.push(...styled(s.slice(last, m.index), `${key}s${i}`));
    nodes.push(
      <a key={`${key}l${i++}`} href={m[2]} target="_blank" rel="noreferrer"
         className="text-cyan-300/90 hover:text-cyan-200 underline underline-offset-2 break-all">
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < s.length) nodes.push(...styled(s.slice(last), `${key}s${i}`));
  return nodes;
}

function Md({ text }: { text: string }) {
  if (!text?.trim()) return <p className="text-white/30 text-sm italic">Nothing recorded.</p>;
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Table: header | --- | rows
    if (line.trim().startsWith("|") && lines[i + 1]?.includes("---")) {
      const head = line.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <div key={`t${i}`} className="my-3 overflow-x-auto rounded-xl border border-white/[0.06]">
          <table className="w-full text-[12px] min-w-[520px]">
            <thead>
              <tr className="bg-white/[0.03]">
                {head.map((h, x) => (
                  <th key={x} className="text-left px-3 py-2 font-medium text-white/50 whitespace-nowrap">{inline(h, `th${x}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y} className="border-t border-white/[0.04]">
                  {r.map((c, x) => (
                    <td key={x} className="px-3 py-2 text-white/70 align-top">{inline(c, `td${y}-${x}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Headings
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl === 2 ? "text-lg font-semibold text-white/90 mt-6 mb-2"
                : lvl === 3 ? "text-[15px] font-semibold text-white/80 mt-5 mb-1.5"
                : "text-[13px] font-semibold text-white/70 mt-4 mb-1";
      blocks.push(<div key={`h${i}`} className={cls}>{inline(h[2], `h${i}`)}</div>);
      i++;
      continue;
    }

    // Lists
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`u${i}`} className="my-2 space-y-1.5">
          {items.map((it, x) => (
            <li key={x} className="flex gap-2 text-[13px] text-white/70 leading-relaxed">
              <span className="text-white/25 select-none mt-[3px]">•</span>
              <span>{inline(it, `li${i}-${x}`)}</span>
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*[-*]\s+/.test(lines[i]) && !lines[i].trim().startsWith("|") && !/^#{2,4}\s/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    blocks.push(<p key={`p${i}`} className="my-2 text-[13px] text-white/70 leading-relaxed">{inline(para.join(" "), `p${i}`)}</p>);
  }
  return <div>{blocks}</div>;
}

function Section({ icon, title, accent, children }: { icon: React.ReactNode; title: string; accent: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: accent }}>{icon}</span>
        <h3 className="text-[13px] font-semibold text-white/80">{title}</h3>
      </div>
      {children}
    </div>
  );
}

export default function MarketResearch() {
  const { data, isLoading, error } = useQuery<Response>({ queryKey: ["/api/admin/market-research"] });
  const [active, setActive] = useState<string | null>(null);

  const current = useMemo(
    () => data?.verticals?.find((v) => v.slug === active) ?? null,
    [data, active],
  );

  if (isLoading) return <div className="p-6 text-white/40 text-sm">Loading research…</div>;
  if (error) return <div className="p-6 text-red-300/80 text-sm">Failed to load market research.</div>;

  if (!data?.seeded) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.04] p-5">
          <div className="flex items-center gap-2 text-amber-300/90 mb-2">
            <FileWarning className="w-4 h-4" />
            <h2 className="font-semibold text-sm">No research seeded</h2>
          </div>
          <p className="text-[13px] text-white/60 leading-relaxed">{data?.message ?? "Nothing to show yet."}</p>
        </div>
      </div>
    );
  }

  const src = data.sources;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl">
      <div className="flex items-start gap-3">
        <Telescope className="w-5 h-5 text-cyan-300/80 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-white/90">Market Research</h1>
          <p className="text-[12px] text-white/40 mt-0.5">
            Competitor &amp; category intelligence · research run {fmtDate(data.generatedAt)}
          </p>
        </div>
      </div>

      {/* Source honesty banner. This sits ABOVE the findings on purpose: a reader must
          never mistake a blocked source for an absence of complaints. */}
      {src && (
        <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.03] p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-300/90" />
            <h2 className="text-[13px] font-semibold text-amber-200/90">What this report is built on</h2>
          </div>
          <p className="text-[12.5px] text-white/60 leading-relaxed mb-3">{src.note}</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-white/35 mb-1.5">Collected</div>
              <ul className="space-y-1">
                {src.working.map((s) => (
                  <li key={s.source} className="flex gap-2 text-[12px] text-white/65">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/80 mt-0.5 shrink-0" />
                    <span><span className="text-white/85">{s.source}</span> — {s.detail}</span>
                  </li>
                ))}
              </ul>
              {!!src.rate_limited?.length && (
                <>
                  <div className="text-[11px] uppercase tracking-wide text-white/35 mt-3 mb-1.5">
                    Working, but rate-limited at probe time
                  </div>
                  <ul className="space-y-1">
                    {src.rate_limited.map((s) => (
                      <li key={s.source} className="flex gap-2 text-[12px] text-white/65">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70 mt-0.5 shrink-0" />
                        <span><span className="text-white/85">{s.source}</span> — {s.detail}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wide text-white/35 mb-1.5">Blocked — no data in this report</div>
              <ul className="space-y-1">
                {src.blocked.map((s) => (
                  <li key={s.source} className="flex gap-2 text-[12px] text-white/65">
                    <XCircle className="w-3.5 h-3.5 text-red-400/70 mt-0.5 shrink-0" />
                    <span><span className="text-white/85">{s.source}</span> — {s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Vertical switcher */}
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setActive(null)}
          className={`px-3 py-1.5 rounded-lg text-[12px] border transition ${
            active === null
              ? "bg-white/[0.08] border-white/15 text-white/90"
              : "bg-white/[0.02] border-white/[0.06] text-white/50 hover:text-white/75"
          }`}
        >
          <Layers className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
          Master report
        </button>
        {data.verticals.map((v) => (
          <button
            key={v.slug}
            onClick={() => setActive(v.slug)}
            className={`px-3 py-1.5 rounded-lg text-[12px] border transition ${
              active === v.slug
                ? "bg-white/[0.08] border-white/15 text-white/90"
                : "bg-white/[0.02] border-white/[0.06] text-white/50 hover:text-white/75"
            }`}
          >
            {v.title}
            {typeof v.competitors_analysed === "number" && (
              <span className="ml-1.5 text-white/30">{v.competitors_analysed}</span>
            )}
          </button>
        ))}
      </div>

      {current ? (
        <div className="space-y-4">
          <Section icon={<DollarSign className="w-4 h-4" />} title="Price ladder" accent="#22c55e">
            <Md text={current.price_ladder} />
          </Section>
          <Section icon={<Map className="w-4 h-4" />} title="Positioning map" accent="#3b82f6">
            <Md text={current.positioning_map} />
          </Section>
          {current.offer_patterns && (
            <Section icon={<Gift className="w-4 h-4" />} title="Offer mechanics in this market" accent="#a855f7">
              <Md text={current.offer_patterns} />
            </Section>
          )}
          <Section icon={<Lightbulb className="w-4 h-4" />} title="White space" accent="#f59e0b">
            <Md text={current.white_space} />
          </Section>
          {current.our_position && (
            <Section icon={<Telescope className="w-4 h-4" />} title="Where we sit" accent="#06b6d4">
              <Md text={current.our_position} />
            </Section>
          )}
          <Section icon={<FileWarning className="w-4 h-4" />} title="Evidence gaps" accent="#ef4444">
            <Md text={current.evidence_gaps} />
          </Section>
          {!!current.notable_verbatims?.length && (
            <Section icon={<Quote className="w-4 h-4" />} title="Their words, verbatim" accent="#ec4899">
              <ul className="space-y-2">
                {current.notable_verbatims.map((q, i) => (
                  <li key={i} className="border-l-2 border-white/10 pl-3 text-[13px] text-white/65 italic">“{q}”</li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-6">
          {data.master?.markdown
            ? <Md text={data.master.markdown} />
            : <p className="text-white/35 text-sm">Master report not seeded.</p>}
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-white/25 pt-2">
        <Link2 className="w-3 h-3" />
        Every price and quote in this report links to the page it was read from. Fields with no source are shown as “—”, never estimated.
      </div>
    </div>
  );
}

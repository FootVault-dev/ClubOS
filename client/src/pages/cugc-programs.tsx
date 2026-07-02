// CUGC — Programs (Gymnastics workspace → Programs tab).
// Shows the LIVE cugc.co.nz program lineup — served from the same server config
// (server/cugc-pricing.ts) that prices the website's enrol flow, so this page
// can never drift from the site. Website enrolments flow into the Registrations
// tab automatically; this page is the structure + numbers overview. Program
// names/prices/times are changed in the config (ask Claude), not here.
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { GraduationCap, Clock, ExternalLink, ClipboardCheck, Sparkles, CalendarDays } from "lucide-react";

const SITE = "https://cugc.co.nz";

interface Registration {
  id: number;
  programSlug: string;
  priceCents: number;
  status: string;
}
interface ProgramConfig {
  term: { name: string; start: string; end: string; weeks: number };
  programs: {
    slug: string; title: string; ages: string; image: string;
    annual?: boolean; inviteOnly?: boolean;
    options: { label: string; price: number; times: string[] }[];
  }[];
}

function money(cents: number): string {
  const dollars = (cents || 0) / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString("en-NZ")}`
    : `$${dollars.toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtRange(startIso: string, endIso: string): string {
  const f = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
  try { return `${f(startIso)} – ${f(endIso)}`; } catch { return `${startIso} – ${endIso}`; }
}

export default function CugcPrograms() {
  const { data: cfg, isLoading } = useQuery<ProgramConfig>({ queryKey: ["/api/admin/cugc/programs"] });
  const { data: regos = [] } = useQuery<Registration[]>({ queryKey: ["/api/admin/cugc/registrations"] });

  const statsFor = (slug: string) => {
    const rows = regos.filter((r) => r.programSlug === slug);
    return {
      paid: rows.filter((r) => r.status === "paid").length,
      pending: rows.filter((r) => r.status === "pending_payment").length,
      revenue: rows.filter((r) => r.status === "paid").reduce((sum, r) => sum + (r.priceCents || 0), 0),
    };
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white/90 flex items-center gap-2.5">
            <GraduationCap className="w-6 h-6 text-blue-400" />
            Programs{cfg ? ` · ${cfg.term.name}` : ""}
          </h1>
          <p className="text-sm text-white/40 mt-1">
            The live cugc.co.nz lineup — this page mirrors the website, and enrolments land in Registrations automatically.
            {cfg && (
              <span className="ml-2 inline-flex items-center gap-1.5 text-white/50">
                <CalendarDays className="w-3.5 h-3.5" /> {fmtRange(cfg.term.start, cfg.term.end)} · {cfg.term.weeks} weeks
              </span>
            )}
          </p>
        </div>
        <a
          href={`${SITE}/programs`}
          target="_blank"
          rel="noopener"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/[0.04] text-white/60 hover:text-white/90 text-xs transition-colors"
        >
          View on cugc.co.nz <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      {isLoading || !cfg ? (
        <div className="text-white/40 text-sm py-16 text-center">Loading programs…</div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          {cfg.programs.map((p) => {
            const s = statsFor(p.slug);
            return (
              <div key={p.slug} className="rounded-2xl border border-white/[0.08] bg-white/[0.03] overflow-hidden flex flex-col" data-testid={`program-${p.slug}`}>
                <div className="relative h-36">
                  <img src={`${SITE}${p.image}`} alt={p.title} className="absolute inset-0 w-full h-full object-cover" />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0d1117] via-[#0d1117]/40 to-transparent" />
                  <div className="absolute bottom-3 left-4 right-4">
                    <h2 className="text-lg font-semibold text-white">{p.title}</h2>
                    <p className="text-xs text-white/60">{p.ages}{p.annual ? " · annual program" : ""}{p.inviteOnly ? " · by invitation" : ""}</p>
                  </div>
                </div>

                <div className="p-4 flex-1 flex flex-col gap-4">
                  <div className="flex items-center gap-4">
                    <div>
                      <p className="text-2xl font-semibold text-white/90">{s.paid}</p>
                      <p className="text-[11px] uppercase tracking-wider text-white/35">Enrolled</p>
                    </div>
                    <div>
                      <p className="text-2xl font-semibold text-emerald-300/90">{money(s.revenue)}</p>
                      <p className="text-[11px] uppercase tracking-wider text-white/35">Paid revenue</p>
                    </div>
                    {s.pending > 0 && (
                      <div>
                        <p className="text-2xl font-semibold text-amber-300/90">{s.pending}</p>
                        <p className="text-[11px] uppercase tracking-wider text-white/35">Pending</p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2.5">
                    {p.options.map((o, i) => (
                      <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm text-white/80">{o.label}</span>
                          <span className="text-sm font-semibold text-white/90 whitespace-nowrap">${o.price} <span className="text-white/35 font-normal">/ term</span></span>
                        </div>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-white/40">
                          <Clock className="w-3 h-3" /> {o.times.join(" · ")}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-auto flex items-center gap-2 pt-1">
                    <Link
                      href={`/admin/cugc-registrations?program=${p.slug}`}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-500/15 border border-blue-400/40 text-blue-200 hover:bg-blue-500/25 text-sm font-medium transition-colors"
                    >
                      <ClipboardCheck className="w-4 h-4" /> View roster
                    </Link>
                    <a
                      href={`${SITE}/programs/${p.slug}`}
                      target="_blank"
                      rel="noopener"
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.04] text-white/60 hover:text-white/90 text-sm transition-colors"
                    >
                      Page <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs text-white/30">
        <Sparkles className="w-3.5 h-3.5" /> Program names, prices and times are managed in the website config — change them there and this page updates itself.
      </p>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Fingerprint, Users, Mail, Phone, LayoutGrid, Search,
  ShieldCheck, Sparkles, ClipboardList, Building2, Download,
} from "lucide-react";

// ── Types (match /api/admin/club-dossier) ────────────────────────────────────
interface Totals { records: number; unique_emails: number; unique_phones: number; programs: number; }
interface ProgramRow { program: string; records: number; unique_emails: number; contactable: number; }
interface Person { program: string; name: string | null; email: string | null; phone: string | null; created_at: string | null; }
interface DossierResponse {
  generatedAt: string;
  totals: Totals;
  programs: ProgramRow[];
  people: Person[];
  truncated: boolean;
  cap: number;
}

const RENDER_CAP = 300;

const fmtNum = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-NZ");
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "2-digit" }) : "—";

// Stable colour per program for the bars/pills.
const PROGRAM_COLORS = ["#3b82f6", "#8b5cf6", "#06b6d4", "#a855f7", "#22c55e", "#f59e0b", "#ec4899", "#f97316", "#eab308", "#14b8a6"];
const colorFor = (i: number) => PROGRAM_COLORS[i % PROGRAM_COLORS.length];

function Kpi({ label, value, icon, accent, sub }: { label: string; value: string; icon: React.ReactNode; accent: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4" data-testid={`kpi-${label.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-2 text-[11px] text-white/40 font-medium">
        <span style={{ color: accent }}>{icon}</span> {label}
      </div>
      <div className="text-2xl font-semibold mt-1.5 text-white/90">{value}</div>
      {sub && <div className="text-[10px] text-white/30 mt-1">{sub}</div>}
    </div>
  );
}

export default function ClubDossier() {
  const { data, isLoading, error } = useQuery<DossierResponse>({ queryKey: ["/api/admin/club-dossier"] });

  const [search, setSearch] = useState("");
  const [programFilter, setProgramFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const people = data?.people ?? [];
    const q = search.trim().toLowerCase();
    return people.filter((p) => {
      if (programFilter && p.program !== programFilter) return false;
      if (!q) return true;
      return (
        (p.name || "").toLowerCase().includes(q) ||
        (p.email || "").toLowerCase().includes(q) ||
        (p.phone || "").toLowerCase().includes(q) ||
        (p.program || "").toLowerCase().includes(q)
      );
    });
  }, [data?.people, search, programFilter]);

  const maxRecords = Math.max(1, ...(data?.programs ?? []).map((p) => p.records));

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto" data-testid="page-club-dossier">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500/20 to-blue-700/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
            <Fingerprint className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-white/90">Club Dossier</h1>
              <span className="text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-300 border border-blue-500/20">First-party · v1</span>
            </div>
            <p className="text-[12px] text-white/40 mt-0.5 max-w-2xl">
              Every person we already hold, unified and sorted by program — the foundation for club-wide
              audience insight and sponsor pitches. {data ? `Generated ${new Date(data.generatedAt).toLocaleString("en-NZ")}.` : ""}
            </p>
          </div>
        </div>
      </div>

      {isLoading && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-10 text-center text-white/40 text-sm" data-testid="dossier-loading">
          Compiling the dossier across every program…
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6 text-red-300 text-sm" data-testid="dossier-error">
          Couldn't load the dossier: {(error as any)?.message || "unknown error"}
        </div>
      )}

      {data && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
            <Kpi label="Total records" value={fmtNum(data.totals.records)} icon={<LayoutGrid className="w-4 h-4" />} accent="#3b82f6" sub="across all programs" />
            <Kpi label="Unique people" value={fmtNum(data.totals.unique_emails)} icon={<Users className="w-4 h-4" />} accent="#22c55e" sub="de-duplicated by email" />
            <Kpi label="Phone numbers" value={fmtNum(data.totals.unique_phones)} icon={<Phone className="w-4 h-4" />} accent="#a855f7" sub="unique contactable" />
            <Kpi label="Programs" value={fmtNum(data.totals.programs)} icon={<Building2 className="w-4 h-4" />} accent="#f59e0b" sub="data sources merged" />
          </div>

          {/* By program */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 mb-6">
            <div className="flex items-center gap-2 mb-4">
              <ClipboardList className="w-4 h-4 text-blue-400" />
              <h2 className="text-[13px] font-semibold text-white/80">By program</h2>
              <span className="text-[11px] text-white/30">— click to filter the list below</span>
            </div>
            <div className="space-y-2">
              {data.programs.map((p, i) => {
                const active = programFilter === p.program;
                return (
                  <button
                    key={p.program}
                    onClick={() => setProgramFilter(active ? null : p.program)}
                    className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all cursor-pointer ${active ? "border-blue-500/40 bg-blue-500/[0.06]" : "border-white/[0.05] bg-white/[0.01] hover:bg-white/[0.03]"}`}
                    data-testid={`program-row-${p.program.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-1.5">
                      <span className="flex items-center gap-2 text-[13px] text-white/80 font-medium min-w-0">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: colorFor(i) }} />
                        <span className="truncate">{p.program}</span>
                      </span>
                      <span className="text-[12px] text-white/50 flex-shrink-0">
                        <span className="text-white/90 font-semibold">{fmtNum(p.records)}</span> records
                        <span className="text-white/25"> · </span>
                        {fmtNum(p.unique_emails)} people
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${(p.records / maxRecords) * 100}%`, background: colorFor(i) }} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* People */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sm:p-5 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-400" />
                <h2 className="text-[13px] font-semibold text-white/80">People</h2>
                <span className="text-[11px] text-white/30">
                  {fmtNum(filtered.length)}{programFilter ? ` in ${programFilter}` : ""}
                  {data.truncated ? ` (capped at ${fmtNum(data.cap)})` : ""}
                </span>
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, email, phone…"
                  className="w-full rounded-lg bg-white/[0.03] border border-white/10 pl-9 pr-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50"
                  data-testid="input-dossier-search"
                />
              </div>
            </div>

            {programFilter && (
              <button onClick={() => setProgramFilter(null)} className="mb-3 text-[11px] text-blue-300 hover:text-blue-200 cursor-pointer" data-testid="button-clear-program-filter">
                ✕ Clear filter: {programFilter}
              </button>
            )}

            <div className="overflow-x-auto -mx-1">
              <table className="w-full min-w-[640px] text-[13px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-white/30 border-b border-white/[0.06]">
                    <th className="text-left font-medium py-2 px-2">Name</th>
                    <th className="text-left font-medium py-2 px-2">Email</th>
                    <th className="text-left font-medium py-2 px-2">Phone</th>
                    <th className="text-left font-medium py-2 px-2">Program</th>
                    <th className="text-right font-medium py-2 px-2">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, RENDER_CAP).map((p, i) => (
                    <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]" data-testid={`person-row-${i}`}>
                      <td className="py-2 px-2 text-white/85 whitespace-nowrap">{p.name || "—"}</td>
                      <td className="py-2 px-2 text-white/55">{p.email || "—"}</td>
                      <td className="py-2 px-2 text-white/55 whitespace-nowrap">{p.phone || "—"}</td>
                      <td className="py-2 px-2"><span className="text-[11px] text-white/50">{p.program}</span></td>
                      <td className="py-2 px-2 text-right text-white/35 whitespace-nowrap">{fmtDate(p.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && (
                <div className="py-8 text-center text-white/30 text-sm">No people match your search.</div>
              )}
              {filtered.length > RENDER_CAP && (
                <div className="pt-3 text-center text-[11px] text-white/30">
                  Showing first {fmtNum(RENDER_CAP)} of {fmtNum(filtered.length)} — refine your search to narrow it.
                </div>
              )}
            </div>
          </div>

          {/* What's next — grounded in the chosen approach */}
          <div className="rounded-2xl border border-blue-500/15 bg-blue-500/[0.03] p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="w-4 h-4 text-blue-400" />
              <h2 className="text-[13px] font-semibold text-white/80">Where this goes next</h2>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-[12px]">
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 text-white/80 font-medium mb-1"><ClipboardList className="w-3.5 h-3.5 text-emerald-400" /> Club Census</div>
                <p className="text-white/45 leading-relaxed">A consented, incentivised survey — the highest-confidence data and the source of sponsor-grade audience stats.</p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 text-white/80 font-medium mb-1"><ShieldCheck className="w-3.5 h-3.5 text-blue-400" /> Confidence tiers</div>
                <p className="text-white/45 leading-relaxed">Every enriched fact scored Verified / Probable / Unverified — sub-threshold matches are quarantined, never merged.</p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-center gap-2 text-white/80 font-medium mb-1"><Building2 className="w-3.5 h-3.5 text-amber-400" /> Audience segments</div>
                <p className="text-white/45 leading-relaxed">Suburb-level Stats NZ + deprivation join → media-agency-grade demographics with zero individual profiling.</p>
              </div>
            </div>
            <p className="text-[11px] text-white/30 mt-3">
              v1 shown here is 100% first-party (data families gave us directly). No external or third-party data is touched until the census + compliant enrichment phases ship.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

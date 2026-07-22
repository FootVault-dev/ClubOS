// Friendly Manager Competitions — 11 years of tournaments + social leagues,
// imported 2026-07-17. Read-only archive: browse every CIC + social-league
// season, its teams/clubs/games/scores/placings, and the CIC club-loyalty
// ledger (who came back every year). CUFC workspace, SUPER_ADMIN_ONLY.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Trophy, Users, ChevronRight, X, Loader2, Search, Crown, MapPin,
  CalendarDays, ListOrdered, Medal, Star,
} from "lucide-react";

type Stats = {
  competitions: number; teams: number; games: number; scoredGames: number;
  placings: number; clubs: number; firstYear: number | null; lastYear: number | null;
  segments: { segment: string; competitions: number; teams: number }[];
  byYear: { year: number | null; competitions: number; teams: number }[];
};
type Comp = {
  id: number; name: string; segment: string; seasonYear: number | null;
  start: string | null; end: string | null; teams: number; games: number; scored: number; placings: number;
};
type Detail = {
  comp: { id: number; name: string; segment: string; seasonYear: number | null; start: string | null; end: string | null };
  teams: { division: string | null; team: string; club: string | null; manager: string | null; phone: string | null; email: string | null; players: number | null }[];
  games: { divisionId: number | null; roundId: number | null; pool: string | null; date: string | null; time: string | null; venue: string | null; home: string; away: string; homeScore: number | null; awayScore: number | null; status: string }[];
  placings: { division: string | null; place: number; team: string; club: string | null }[];
};
type ClubLoyalty = { club: string; yearsEntered: number; years: number[] };

const SEGMENTS: [string, string][] = [
  ["", "All"], ["cic", "Christchurch International Cup"], ["social-league", "Social Leagues"], ["festival", "Festivals"],
];
const SEG_BADGE: Record<string, string> = {
  cic: "bg-amber-500/20 text-amber-300 border border-amber-400/25",
  "social-league": "bg-sky-500/15 text-sky-300",
  festival: "bg-violet-500/15 text-violet-300",
};
const SEG_LABEL: Record<string, string> = { cic: "CIC", "social-league": "Social", festival: "Festival" };
const nzDate = (s: string | null) => s ? new Date(s + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

export default function FmCompetitions() {
  const [segment, setSegment] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [showLoyalty, setShowLoyalty] = useState(false);

  const { data: stats } = useQuery<Stats>({ queryKey: ["/api/admin/fm-competitions/stats"] });
  const { data: comps = [], isLoading } = useQuery<Comp[]>({
    queryKey: [`/api/admin/fm-competitions/list?segment=${segment}&q=${encodeURIComponent(q)}`],
  });

  const tiles = [
    { label: "Competitions", value: stats ? stats.competitions.toLocaleString() : "—", sub: stats && stats.firstYear ? `${stats.firstYear}–${stats.lastYear}` : undefined },
    { label: "Teams", value: stats ? stats.teams.toLocaleString() : "—", sub: stats ? `${stats.clubs} clubs` : undefined },
    { label: "Games", value: stats ? stats.games.toLocaleString() : "—", sub: stats ? `${stats.scoredGames.toLocaleString()} with scores` : undefined },
    { label: "Placings", value: stats ? stats.placings.toLocaleString() : "—", sub: "final standings" },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Trophy className="w-6 h-6 text-amber-400" /> Competitions History
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Tournaments &amp; social leagues from Friendly Manager, imported 17 Jul 2026
          </p>
        </div>
        <button onClick={() => setShowLoyalty(true)} data-testid="fm-comp-loyalty-btn"
          className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15 transition-colors">
          <Star className="w-3.5 h-3.5" /> CIC Club Loyalty
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
            {s.sub && <p className="text-[10px] text-white/30 mt-0.5">{s.sub}</p>}
          </div>
        ))}
      </div>

      {stats && stats.byYear.length > 0 && (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <p className="text-[10px] uppercase tracking-wider text-white/30 mb-3">Teams by year</p>
          <div className="flex items-end gap-2 h-20">
            {stats.byYear.map((y, i) => {
              const max = Math.max(...stats.byYear.map((x) => x.teams), 1);
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <span className="text-[10px] text-white/50">{y.teams}</span>
                  <div className="w-full rounded-t bg-amber-500/40" style={{ height: `${Math.max(4, (y.teams / max) * 56)}px` }} />
                  <span className="text-[10px] text-white/30">{y.year ?? "?"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
        <div className="p-3 border-b border-white/5 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="w-4 h-4 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={q} onChange={(e) => setQ(e.target.value)} data-testid="fm-comp-search"
              placeholder="Search a competition…"
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] pl-9 pr-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-amber-500/40 focus:outline-none" />
          </div>
          <select value={segment} onChange={(e) => setSegment(e.target.value)} data-testid="fm-comp-segment"
            className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs text-white/80 focus:border-amber-500/40 focus:outline-none [&>option]:bg-[#0a0e1a]">
            {SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {isLoading ? (
          <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/5">
                  <th className="py-2.5 px-4">Competition</th>
                  <th className="py-2.5 px-4 hidden sm:table-cell">Dates</th>
                  <th className="py-2.5 px-4 text-center">Teams</th>
                  <th className="py-2.5 px-4 text-center hidden md:table-cell">Games</th>
                  <th className="py-2.5 px-4 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {comps.map((c, i) => (
                  <tr key={c.id} onClick={() => setSelected(c.id)} data-testid={`fm-comp-${i}`}
                    className="border-b border-white/[0.03] hover:bg-white/[0.03] cursor-pointer group">
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white">{c.name}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${SEG_BADGE[c.segment] || "bg-white/10 text-white/50"}`}>{SEG_LABEL[c.segment] || c.segment}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-white/50 hidden sm:table-cell text-[12px] whitespace-nowrap">{nzDate(c.start)}</td>
                    <td className="py-2.5 px-4 text-center text-white/70">{c.teams || "—"}</td>
                    <td className="py-2.5 px-4 text-center text-white/50 hidden md:table-cell text-[12px]">
                      {c.games ? <span>{c.games}{c.scored > 0 && <span className="text-emerald-300/70"> · {c.scored} scored</span>}</span> : "—"}
                    </td>
                    <td className="py-2.5 px-4"><ChevronRight className="w-4 h-4 text-white/0 group-hover:text-white/30" /></td>
                  </tr>
                ))}
                {comps.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-white/30">{q ? `Nothing matching “${q}”.` : "No competitions."}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected !== null && <CompModal id={selected} onClose={() => setSelected(null)} />}
      {showLoyalty && <LoyaltyModal onClose={() => setShowLoyalty(false)} />}
    </div>
  );
}

function CompModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [tab, setTab] = useState<"teams" | "games" | "placings">("teams");
  const { data, isLoading } = useQuery<Detail>({ queryKey: [`/api/admin/fm-competitions/comp/${id}`] });
  const c = data?.comp;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {isLoading || !data || !c ? (
          <div className="p-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : (
          <>
            <div className="p-5 border-b border-white/5 flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-bold text-white">{c.name}</h3>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${SEG_BADGE[c.segment] || "bg-white/10 text-white/50"}`}>{SEG_LABEL[c.segment] || c.segment}</span>
                </div>
                <p className="text-[11px] text-white/40 mt-1">{nzDate(c.start)} – {nzDate(c.end)}</p>
              </div>
              <button onClick={onClose} className="text-white/30 hover:text-white/70 shrink-0"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-3 border-b border-white/5">
              {[["Teams", data.teams.length], ["Games", data.games.length], ["Placings", data.placings.length]].map(([l, v], i) => (
                <div key={i} className="p-3 text-center border-r border-white/5 last:border-r-0">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{l}</p>
                  <p className="text-sm font-bold text-white mt-0.5">{v}</p>
                </div>
              ))}
            </div>
            <div className="px-4 pt-3">
              <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
                {([["teams", "Teams", Users], ["games", "Games", CalendarDays], ["placings", "Placings", Medal]] as const).map(([v, label, Icon]) => (
                  <button key={v} onClick={() => setTab(v)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${tab === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
                    <Icon className="w-3 h-3" />{label}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4 overflow-y-auto">
              {tab === "teams" && (
                <div className="space-y-1.5">
                  {data.teams.map((t, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{t.team}</div>
                        <div className="text-[11px] text-white/30 truncate">
                          {[t.club, t.division, t.manager].filter(Boolean).join(" · ") || "—"}
                        </div>
                      </div>
                      {t.players != null && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 shrink-0">{t.players}p</span>}
                    </div>
                  ))}
                  {data.teams.length === 0 && <p className="text-center text-white/30 py-6 text-sm">No teams recorded (empty in FM).</p>}
                </div>
              )}
              {tab === "games" && (
                <div className="space-y-1.5">
                  {data.games.map((g, i) => {
                    const scored = g.homeScore != null && g.awayScore != null;
                    return (
                      <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                        <div className="text-[11px] text-white/40 w-16 shrink-0">{g.date ? nzDate(g.date).replace(/ \d{4}$/, "") : "—"}</div>
                        <div className="min-w-0 flex-1 flex items-center gap-2">
                          <span className="text-sm text-white truncate flex-1 text-right">{g.home}</span>
                          <span className={`text-sm font-bold shrink-0 px-1.5 rounded ${scored ? "text-white bg-white/10" : "text-white/25"}`}>
                            {scored ? `${g.homeScore}–${g.awayScore}` : "v"}
                          </span>
                          <span className="text-sm text-white truncate flex-1">{g.away}</span>
                        </div>
                        {g.venue && <span className="text-[10px] text-white/25 shrink-0 hidden sm:inline-flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{g.venue}</span>}
                      </div>
                    );
                  })}
                  {data.games.length === 0 && <p className="text-center text-white/30 py-6 text-sm">No games recorded.</p>}
                </div>
              )}
              {tab === "placings" && (
                <div className="space-y-1.5">
                  {data.placings.map((p, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                      <span className={`w-7 text-center text-sm font-bold shrink-0 ${p.place === 1 ? "text-amber-300" : p.place === 2 ? "text-white/70" : p.place === 3 ? "text-orange-300/70" : "text-white/40"}`}>
                        {p.place === 1 ? "🥇" : p.place === 2 ? "🥈" : p.place === 3 ? "🥉" : p.place}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{p.team}</div>
                        {(p.club || p.division) && <div className="text-[11px] text-white/30 truncate">{[p.club, p.division].filter(Boolean).join(" · ")}</div>}
                      </div>
                    </div>
                  ))}
                  {data.placings.length === 0 && <p className="text-center text-white/30 py-6 text-sm inline-flex items-center gap-2 w-full justify-center"><ListOrdered className="w-4 h-4" /> No final placings recorded in FM.</p>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LoyaltyModal({ onClose }: { onClose: () => void }) {
  const { data = [], isLoading } = useQuery<ClubLoyalty[]>({ queryKey: ["/api/admin/fm-competitions/club-loyalty"] });
  const allYears = [...new Set(data.flatMap((c) => c.years))].sort();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-white/5 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2"><Star className="w-5 h-5 text-amber-400" /> CIC Club Loyalty</h3>
            <p className="text-[11px] text-white/40 mt-1">Which clubs came back to the Christchurch International Cup, year after year — the ones to reward.</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 shrink-0"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 overflow-y-auto">
          {isLoading ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : (
            <div className="space-y-1.5">
              {data.map((c, i) => (
                <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                  {c.yearsEntered === allYears.length && allYears.length > 1 && <Crown className="w-4 h-4 text-amber-400 shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{c.club}</div>
                    <div className="text-[11px] text-white/30">{c.years.join(" · ")}</div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 ${c.yearsEntered === allYears.length && allYears.length > 1 ? "bg-amber-500/20 text-amber-300 border border-amber-400/25" : "bg-white/10 text-white/50"}`}>
                    {c.yearsEntered} {c.yearsEntered === 1 ? "year" : "years"}
                  </span>
                </div>
              ))}
              {data.length === 0 && <p className="text-center text-white/30 py-6 text-sm">No CIC club data.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

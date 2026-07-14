// Friendly Manager History — 10 years of CUFC registrations + payments,
// imported 2026-07-14. Read-only archive: search any player or parent, see
// every term they enrolled and every dollar the family paid. CUFC workspace,
// SUPER_ADMIN_ONLY while Daniel shapes it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/format";
import {
  History, Users, ChevronRight, X, Loader2, Search, Mail, Phone,
  CalendarDays, Receipt, Crown, ShieldQuestion,
} from "lucide-react";

type Person = {
  id: number; type: string; firstName: string; lastName: string;
  email: string | null; phone: string | null; dob: string | null;
  terms: number; firstYear: number | null; lastYear: number | null;
  payments: number; cents: number; guardians: string | null; children: number;
};
type Stats = {
  people: number; players: number; familyLinks: number; registrations: number;
  enrolledPeople: number; terms: number; payments: number; totalCents: number;
  firstPayment: string | null; lastPayment: string | null;
  seasons: { year: number | null; registrations: number }[];
};
type Detail = {
  person: {
    id: number; type: string; firstName: string; lastName: string;
    email: string | null; phone: string | null; dob: string | null;
    address: string | null; medicalNotes: string | null; notes: string | null; fmId: string;
  };
  guardians: { id: number; firstName: string; lastName: string; email: string | null; phone: string | null }[];
  children: { id: number; firstName: string; lastName: string; dob: string | null }[];
  registrations: { termId: number; termName: string; seasonYear: number | null; programmeGroup: string; position: string | null }[];
  payments: { paidOn: string; amountCents: number; method: string; methodRaw: string; feeNumber: string | null; feeDescription: string | null; noteReference: string | null }[];
  familyCents: number; familyPayments: number;
};

const fmt = (c: number) => formatCurrency(c, { fromCents: true });
const name = (f: string | null, l: string | null) => `${f || ""} ${l || ""}`.trim() || "Unknown";
const nzDate = (s: string | null) =>
  s ? new Date(s + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";

const TYPE_BADGE: Record<string, string> = {
  player: "bg-emerald-500/15 text-emerald-300",
  guardian: "bg-sky-500/15 text-sky-300",
  staff: "bg-violet-500/15 text-violet-300",
};

export default function FmHistory() {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const { data: stats } = useQuery<Stats>({ queryKey: ["/api/admin/fm-history/stats"] });
  const { data: people = [], isLoading } = useQuery<Person[]>({
    queryKey: [`/api/admin/fm-history/people?q=${encodeURIComponent(q)}`],
  });

  const tiles = [
    { label: "People", value: stats ? stats.people.toLocaleString() : "—", sub: stats ? `${stats.players.toLocaleString()} players · ${stats.familyLinks.toLocaleString()} family links` : undefined },
    { label: "Registrations", value: stats ? stats.registrations.toLocaleString() : "—", sub: stats ? `across ${stats.terms} terms` : undefined },
    { label: "Payments", value: stats ? stats.payments.toLocaleString() : "—", sub: stats ? `${nzDate(stats.firstPayment)} → ${nzDate(stats.lastPayment)}` : undefined },
    { label: "Total collected", value: stats ? fmt(stats.totalCents) : "—", sub: "reconciled to Friendly Manager" },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <History className="w-6 h-6 text-amber-400" /> Friendly Manager History
          </h1>
          <p className="text-sm text-white/40 mt-1">
            10 years of club registrations and payments, imported 14 Jul 2026 — search any player or parent
          </p>
        </div>
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

      {stats && stats.seasons.length > 0 && (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <p className="text-[10px] uppercase tracking-wider text-white/30 mb-3">Registrations by season</p>
          <div className="flex items-end gap-2 h-20">
            {stats.seasons.map((s, i) => {
              const max = Math.max(...stats.seasons.map((x) => x.registrations));
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                  <span className="text-[10px] text-white/50">{s.registrations.toLocaleString()}</span>
                  <div className="w-full rounded-t bg-amber-500/40" style={{ height: `${Math.max(4, (s.registrations / max) * 56)}px` }} />
                  <span className="text-[10px] text-white/30">{s.year ?? "?"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
        <div className="p-3 border-b border-white/5">
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)} data-testid="fm-history-search"
              placeholder="Search a player or parent by name or email…"
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] pl-9 pr-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-amber-500/40 focus:outline-none"
            />
          </div>
        </div>
        {isLoading ? (
          <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/5">
                  <th className="py-2.5 px-4 w-10">#</th>
                  <th className="py-2.5 px-4">Person</th>
                  <th className="py-2.5 px-4 text-center hidden sm:table-cell">Terms</th>
                  <th className="py-2.5 px-4 hidden md:table-cell text-center">Active</th>
                  <th className="py-2.5 px-4 text-center hidden sm:table-cell">Payments</th>
                  <th className="py-2.5 px-4 text-right">Paid</th>
                  <th className="py-2.5 px-4 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {people.map((p, i) => (
                  <tr key={p.id} onClick={() => setSelected(p.id)} data-testid={`fm-history-person-${i}`}
                    className="border-b border-white/[0.03] hover:bg-white/[0.03] cursor-pointer group">
                    <td className="py-2.5 px-4 text-white/40">
                      <span className="inline-flex items-center gap-1">
                        {i === 0 && !q && p.cents > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}{i + 1}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white truncate max-w-[140px] sm:max-w-none">{name(p.firstName, p.lastName)}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${TYPE_BADGE[p.type] || "bg-white/10 text-white/50"}`}>{p.type}</span>
                        {p.children > 0 && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/10 text-white/50 inline-flex items-center gap-1"><Users className="w-2.5 h-2.5" />{p.children}</span>}
                      </div>
                      <div className="text-[11px] text-white/30 truncate max-w-[140px] sm:max-w-[260px]">
                        {p.email || p.phone || "no contact on file"}
                        {p.guardians && <span> · parent: {p.guardians}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-center text-white/70 hidden sm:table-cell">{p.terms || "—"}</td>
                    <td className="py-2.5 px-4 text-center text-white/50 hidden md:table-cell text-[12px]">
                      {p.firstYear ? (p.firstYear === p.lastYear ? p.firstYear : `${p.firstYear}–${p.lastYear}`) : "—"}
                    </td>
                    <td className="py-2.5 px-4 text-center text-white/70 hidden sm:table-cell">{p.payments || "—"}</td>
                    <td className="py-2.5 px-4 text-right font-semibold text-white whitespace-nowrap">{p.cents ? fmt(p.cents) : "—"}</td>
                    <td className="py-2.5 px-4"><ChevronRight className="w-4 h-4 text-white/0 group-hover:text-white/30" /></td>
                  </tr>
                ))}
                {people.length === 0 && (
                  <tr><td colSpan={7} className="py-10 text-center text-white/30">
                    {q ? `Nobody matching “${q}”.` : "No imported people found."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {!q && people.length >= 100 && (
          <div className="px-4 py-2 text-[11px] text-white/25 border-t border-white/5">
            Showing the top 100 by lifetime value — search to find anyone else.
          </div>
        )}
      </div>

      {selected !== null && <PersonModal id={selected} onOpen={(id) => setSelected(id)} onClose={() => setSelected(null)} />}
    </div>
  );
}

function PersonModal({ id, onOpen, onClose }: { id: number; onOpen: (id: number) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"terms" | "payments">("terms");
  const { data, isLoading } = useQuery<Detail>({ queryKey: [`/api/admin/fm-history/person/${id}`] });
  const p = data?.person;
  const ownCents = data ? data.payments.reduce((a, x) => a + x.amountCents, 0) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        {isLoading || !data || !p ? (
          <div className="p-16 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
        ) : (
          <>
            <div className="p-5 border-b border-white/5 flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-bold text-white">{name(p.firstName, p.lastName)}</h3>
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${TYPE_BADGE[p.type] || "bg-white/10 text-white/50"}`}>{p.type}</span>
                  {p.dob && <span className="text-[11px] text-white/40">b. {nzDate(p.dob)}</span>}
                </div>
                <div className="flex flex-wrap gap-3 mt-1.5 text-[11px] text-white/40">
                  {p.email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{p.email}</span>}
                  {p.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{p.phone}</span>}
                </div>
                {(data.guardians.length > 0 || data.children.length > 0) && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {data.guardians.map((g) => (
                      <button key={g.id} onClick={() => onOpen(g.id)}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-300 hover:bg-sky-500/20 transition-colors">
                        parent: {name(g.firstName, g.lastName)}
                      </button>
                    ))}
                    {data.children.map((c) => (
                      <button key={c.id} onClick={() => onOpen(c.id)}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors">
                        child: {name(c.firstName, c.lastName)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={onClose} className="text-white/30 hover:text-white/70 shrink-0"><X className="w-5 h-5" /></button>
            </div>

            <div className="grid grid-cols-3 border-b border-white/5">
              {[
                ["Terms enrolled", String(data.registrations.length)],
                ["Own payments", `${data.payments.length} · ${fmt(ownCents)}`],
                ["Family total", `${data.familyPayments} · ${fmt(data.familyCents)}`],
              ].map(([l, v], i) => (
                <div key={i} className="p-3 text-center border-r border-white/5 last:border-r-0">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{l}</p>
                  <p className="text-sm font-bold text-white mt-0.5">{v}</p>
                </div>
              ))}
            </div>

            <div className="px-4 pt-3">
              <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
                {([["terms", "Terms", CalendarDays], ["payments", "Payments", Receipt]] as const).map(([v, label, Icon]) => (
                  <button key={v} onClick={() => setTab(v)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${tab === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
                    <Icon className="w-3 h-3" />{label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 overflow-y-auto">
              {tab === "terms" ? (
                <div className="space-y-2">
                  {data.registrations.map((r, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                      <div className="text-[11px] text-white/40 w-24 shrink-0">{r.termName}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{r.programmeGroup}</div>
                        {r.position && <div className="text-[11px] text-white/30">{r.position}</div>}
                      </div>
                      {r.seasonYear && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 shrink-0">{r.seasonYear}</span>}
                    </div>
                  ))}
                  {data.registrations.length === 0 && (
                    <p className="text-center text-white/30 py-6 text-sm inline-flex items-center gap-2 w-full justify-center">
                      <ShieldQuestion className="w-4 h-4" /> No term enrolments recorded (pre-2021 data lived outside FM's terms).
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {data.payments.map((pay, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                      <div className="text-[11px] text-white/40 w-20 shrink-0">{nzDate(pay.paidOn)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white truncate">{pay.feeDescription || pay.feeNumber || "Payment"}</div>
                        <div className="text-[11px] text-white/30 truncate">
                          {pay.methodRaw}{pay.noteReference ? ` · ${pay.noteReference}` : ""}
                        </div>
                      </div>
                      <div className={`text-sm font-semibold w-20 text-right shrink-0 ${pay.amountCents < 0 ? "text-rose-300" : "text-white"}`}>
                        {fmt(pay.amountCents)}
                      </div>
                    </div>
                  ))}
                  {data.payments.length === 0 && (
                    <p className="text-center text-white/30 py-6 text-sm">
                      No payments in this person's name — check the family total (fees were often paid under the parent or child's name).
                    </p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

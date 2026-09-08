import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Inbox, Globe, Mail, Instagram, Facebook, MessageCircle, X, Phone, Reply, Check, Archive, Users, ClipboardList, CheckCircle2, XCircle, MapPin, Megaphone } from "lucide-react";
import { NZF_COUNTRIES } from "@shared/nzf-vocabulary";

// CIC "Register Your Interest" — two views under the Registrations tab:
//  • By Age Group — the structured board; each grade's slots fill with the exact
//    team contact + the date/time they registered (from cic_interest_registrations).
//  • Enquiries — free-text contact-form + live-chat-fallback messages (inbox_messages).
// A club admin registers every grade they want in one hit and is the single
// contact for all of them (one registration row, age_groups = all grades).

const AGE_GROUPS = ["U9", "U10", "U11", "U12", "U13", "U14", "U15"];
// No cap on registrations of interest — we want hundreds of teams (NZ + worldwide)
// to pick the best from, and teams drop out. This is an interest list, not a
// limited-slot sale, so never show a cap or "sold out".

type Reg = {
  id: number; firstName: string; lastName: string | null; email: string; phone: string | null;
  club: string | null; location: string | null; ageGroups: string[]; status: string; sourceUrl: string | null; createdAt: string;
};
type Msg = {
  id: number; channel: string; name: string | null; email: string | null; phone: string | null;
  subject: string | null; body: string; status: string; sourceUrl: string | null; createdAt: string;
};

const CHANNEL: Record<string, { label: string; icon: any; cls: string }> = {
  web_form: { label: "Website", icon: Globe, cls: "bg-amber-500/15 text-amber-300" },
  email: { label: "Email", icon: Mail, cls: "bg-violet-500/15 text-violet-300" },
  instagram: { label: "Instagram", icon: Instagram, cls: "bg-pink-500/15 text-pink-300" },
  facebook: { label: "Facebook", icon: Facebook, cls: "bg-sky-500/15 text-sky-300" },
  livechat: { label: "Live chat", icon: MessageCircle, cls: "bg-green-500/15 text-green-300" },
};
const STATUS_CLS: Record<string, string> = {
  new: "bg-amber-500/15 text-amber-300", confirmed: "bg-green-500/15 text-green-300",
  read: "bg-white/10 text-white/50", replied: "bg-green-500/15 text-green-300",
  declined: "bg-red-500/15 text-red-300", archived: "bg-white/[0.06] text-white/30",
};

const fmt = (d: string) => new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtFull = (d: string) => new Date(d).toLocaleString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
const regName = (r: Reg) => `${r.firstName}${r.lastName ? " " + r.lastName : ""}`.trim();

// ── Where a registration is from (2026-09-08) ────────────────────────────────
// Daniel: "confirming we are capturing where submissions coming from like what
// country and city so we can filter … and see how we tracking on internationals
// vs NZ." The form now always saves location as "City, Country"; older rows
// sometimes hold a bare city ("Hamilton", "timaru"), so the country is DERIVED,
// never guessed: the location's last segment if it is a real country name (NZ
// Football's own list), else the phone's dial code, else unknown. Nothing is
// written back — a filter must never rewrite a family's record.
const COUNTRY_BY_LOWER = new Map(NZF_COUNTRIES.map((c) => [c.name.toLowerCase(), c.name]));
const DIAL_TO_COUNTRY: Record<string, string> = {
  "+64": "New Zealand", "+61": "Australia", "+66": "Thailand", "+81": "Japan", "+82": "South Korea", "+852": "Hong Kong",
  "+65": "Singapore", "+1": "USA / Canada", "+27": "South Africa", "+55": "Brazil", "+54": "Argentina", "+56": "Chile",
  "+598": "Uruguay", "+44": "United Kingdom", "+353": "Ireland", "+49": "Germany", "+31": "Netherlands", "+34": "Spain",
  "+351": "Portugal", "+977": "Nepal", "+679": "Fiji", "+685": "Samoa", "+676": "Tonga", "+91": "India", "+86": "China",
  "+60": "Malaysia", "+62": "Indonesia", "+63": "Philippines", "+33": "France", "+39": "Italy",
};
export function countryOf(r: Pick<Reg, "location" | "phone">): string | null {
  const loc = (r.location || "").trim();
  if (loc.includes(",")) {
    const last = loc.split(",").pop()!.trim().toLowerCase();
    const hit = COUNTRY_BY_LOWER.get(last);
    if (hit) return hit;
  }
  const digits = (r.phone || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    for (const len of [4, 3, 2]) { const k = digits.slice(0, len); if (DIAL_TO_COUNTRY[k]) return DIAL_TO_COUNTRY[k]; }
  }
  return null;
}
const isNZ = (r: Reg) => countryOf(r) === "New Zealand";

// Which ad market (or page) brought them — read off the utm tags the website
// writes into sourceUrl: "cicyouth.com/cic-2027 [utm_campaign=cic-2027-asia&…]".
const MARKET_LABEL: Record<string, string> = {
  "north-island": "North Island", australia: "Australia", asia: "Asia", usa: "USA", "rest-of-world": "Rest of World", "south-island": "South Island",
};
export function marketOf(sourceUrl: string | null): { label: string; paid: boolean } {
  const s = sourceUrl || "";
  const m = s.match(/utm_campaign=cic-2027-([a-z-]+)/i);
  if (m) return { label: `Meta ad · ${MARKET_LABEL[m[1].toLowerCase()] || m[1]}`, paid: true };
  if (/utm_source=|fbclid=/i.test(s)) return { label: "Ad click", paid: true };
  if (/\/cic-2027/i.test(s)) return { label: "CIC 2027 page", paid: false };
  return { label: "Website", paid: false };
}

export default function CicRegistrations() {
  const [view, setView] = useState<"board" | "list" | "enquiries">("board");
  const [selectedReg, setSelectedReg] = useState<Reg | null>(null);
  const [selectedMsg, setSelectedMsg] = useState<Msg | null>(null);

  const { data: regs = [], isLoading: regsLoading } = useQuery<Reg[]>({
    queryKey: ["/api/admin/cic/registrations"],
    queryFn: () => fetch("/api/admin/cic/registrations").then((r) => r.json()),
  });
  const { data: messages = [], isLoading: msgLoading } = useQuery<Msg[]>({
    queryKey: ["/api/admin/cic/inbox"],
    queryFn: () => fetch("/api/admin/cic/inbox").then((r) => r.json()),
  });

  const activeRegs = regs.filter((r) => r.status !== "archived" && r.status !== "declined");

  // NZ vs international, and per-country — a filter over the same rows, never a
  // second list. Applies to the board and the list alike.
  const [geo, setGeo] = useState<"all" | "nz" | "intl">("all");
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const passesGeo = (r: Reg) => {
    const c = countryOf(r);
    if (countryFilter) return c === countryFilter;
    if (geo === "nz") return c === "New Zealand";
    if (geo === "intl") return c !== null && c !== "New Zealand";
    return true;
  };
  const nzCount = activeRegs.filter(isNZ).length;
  const intlCount = activeRegs.filter((r) => { const c = countryOf(r); return c !== null && c !== "New Zealand"; }).length;
  const unknownCount = activeRegs.length - nzCount - intlCount;
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const lastWeek = activeRegs.filter((r) => new Date(r.createdAt).getTime() >= weekAgo);
  const lastWeekIntl = lastWeek.filter((r) => { const c = countryOf(r); return c !== null && c !== "New Zealand"; }).length;
  const countryCounts = Object.entries(
    activeRegs.reduce<Record<string, number>>((acc, r) => { const c = countryOf(r); if (c) acc[c] = (acc[c] || 0) + 1; return acc; }, {}),
  ).sort((a, b) => b[1] - a[1]);
  const visibleRegs = activeRegs.filter(passesGeo);
  const visibleAll = regs.filter(passesGeo);

  const tabs = [
    { k: "board" as const, label: "By Age Group", icon: Users },
    { k: "list" as const, label: "All Registrations", icon: ClipboardList, count: regs.length },
    { k: "enquiries" as const, label: "Enquiries", icon: Inbox, count: messages.filter((m) => m.status !== "archived").length },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Registrations of Interest</h1>
          <p className="text-sm text-white/40 mt-1">Team registrations from cicyouth.com — also emailed to info@cicyouth.com</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {tabs.map((t) => (
            <button key={t.k} onClick={() => setView(t.k)} className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${view === t.k ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              <t.icon className="w-3.5 h-3.5" />{t.label}{typeof t.count === "number" && <span className="text-white/30">({t.count})</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── NZ vs international scoreboard + filters (board and list) ── */}
      {view !== "enquiries" && !regsLoading && (
        <div className="space-y-3">
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            {[
              { label: "Active registrations", value: activeRegs.length, sub: unknownCount ? `${unknownCount} with no country on file` : "every row has a country" },
              { label: "New Zealand", value: nzCount, sub: activeRegs.length ? `${Math.round((nzCount / activeRegs.length) * 100)}% of active` : "" },
              { label: "International", value: intlCount, sub: activeRegs.length ? `${Math.round((intlCount / activeRegs.length) * 100)}% of active` : "" },
              { label: "Last 7 days", value: lastWeek.length, sub: `${lastWeekIntl} international` },
            ].map((t) => (
              <div key={t.label} className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                <p className="text-[11px] uppercase tracking-wider text-white/35">{t.label}</p>
                <p className="text-2xl font-bold text-white mt-0.5">{t.value}</p>
                {t.sub && <p className="text-[11px] text-white/40 mt-0.5">{t.sub}</p>}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {([["all", "All"], ["nz", "New Zealand"], ["intl", "International"]] as const).map(([k, label]) => (
              <button key={k} onClick={() => { setGeo(k); setCountryFilter(null); }} data-testid={`cic-geo-${k}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${geo === k && !countryFilter ? "bg-amber-500 text-black border-amber-500" : "border-white/10 text-white/60 hover:text-white"}`}>
                {label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-white/10" />
            {countryCounts.map(([c, n]) => (
              <button key={c} onClick={() => setCountryFilter(countryFilter === c ? null : c)} data-testid={`cic-country-${c}`}
                className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${countryFilter === c ? "bg-white/15 text-white border-white/20" : "border-white/5 text-white/45 hover:text-white/80"}`}>
                {c} <span className="text-white/35">{n}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── By Age Group board ── */}
      {view === "board" && (
        regsLoading ? <div className="text-center py-12 text-white/20 text-sm">Loading…</div> : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {AGE_GROUPS.map((g) => {
              const inGroup = visibleRegs.filter((r) => r.ageGroups.includes(g));
              return (
                <div key={g} className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 flex flex-col">
                  <div className="flex items-center justify-between mb-3 pb-2.5 border-b border-white/5">
                    <h3 className="text-lg font-bold text-amber-300">{g}</h3>
                    <span className="text-xs font-semibold text-white/50">{inGroup.length} {inGroup.length === 1 ? "team" : "teams"}</span>
                  </div>
                  {inGroup.length === 0 ? (
                    <p className="text-xs text-white/25 py-6 text-center">No teams yet.</p>
                  ) : (
                    <div className="space-y-1.5">
                      {inGroup.map((r) => (
                        <button key={r.id} onClick={() => setSelectedReg(r)} className="w-full text-left rounded-lg border border-white/5 bg-white/[0.02] hover:bg-white/[0.05] transition-colors px-3 py-2" data-testid={`cic-reg-${g}-${r.id}`}>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-white/90 truncate">{r.club || regName(r)}</span>
                            {r.status === "confirmed" && <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />}
                            <span className="ml-auto text-[10px] text-white/30 shrink-0">{fmt(r.createdAt)}</span>
                          </div>
                          <div className="text-[11px] text-white/45 truncate mt-0.5">{regName(r)} · {r.location || countryOf(r) || "location unknown"}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── All Registrations list ── */}
      {view === "list" && (
        regsLoading ? <div className="text-center py-12 text-white/20 text-sm">Loading…</div> :
        regs.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No registrations yet." sub={`"Register Your Interest" submissions from cicyouth.com land here.`} />
        ) : visibleAll.length === 0 ? (
          <EmptyState icon={Globe} title="No registrations match that filter." sub="Try All, or another country." />
        ) : (
          <div className="space-y-2">
            {visibleAll.map((r) => {
              const country = countryOf(r);
              const market = marketOf(r.sourceUrl);
              return (
              <button key={r.id} onClick={() => setSelectedReg(r)} className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors p-4 flex items-start gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-300 font-bold text-sm">{(r.club || r.firstName).slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-white/90 truncate">{r.club || regName(r)}</span>
                    <span className="ml-auto text-[11px] text-white/30 shrink-0">{fmt(r.createdAt)}</span>
                  </div>
                  <div className="text-[12.5px] text-white/50 truncate mt-0.5">{regName(r)} · {r.email}{r.phone ? " · " + r.phone : ""}</div>
                  <div className="flex flex-wrap items-center gap-1 mt-1.5">
                    {r.ageGroups.map((g) => <span key={g} className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{g}</span>)}
                    <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ml-1 ${STATUS_CLS[r.status] || STATUS_CLS.new}`}>{r.status}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 ${country === "New Zealand" ? "bg-white/[0.06] text-white/55" : country ? "bg-sky-500/15 text-sky-300" : "bg-white/[0.04] text-white/30"}`}>
                      <MapPin className="w-3 h-3" />{r.location || country || "location unknown"}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1 ${market.paid ? "bg-violet-500/15 text-violet-300" : "bg-white/[0.04] text-white/35"}`}>
                      <Megaphone className="w-3 h-3" />{market.label}
                    </span>
                  </div>
                </div>
              </button>
              );
            })}
          </div>
        )
      )}

      {/* ── Enquiries (contact form + live-chat fallback) ── */}
      {view === "enquiries" && (
        msgLoading ? <div className="text-center py-12 text-white/20 text-sm">Loading…</div> :
        messages.filter((m) => m.status !== "archived").length === 0 ? (
          <EmptyState icon={Inbox} title="No enquiries." sub="Contact-form messages and live-chat fallbacks land here." />
        ) : (
          <div className="space-y-2">
            {messages.filter((m) => m.status !== "archived").map((m) => {
              const ch = CHANNEL[m.channel] || CHANNEL.web_form;
              return (
                <button key={m.id} onClick={() => setSelectedMsg(m)} className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors p-4 flex items-start gap-3">
                  <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${ch.cls}`}><ch.icon className="w-4 h-4" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-white/90 truncate">{m.name || m.email || "Unknown"}</span>
                      {m.status === "new" && <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />}
                      <span className="ml-auto text-[11px] text-white/30 shrink-0">{fmt(m.createdAt)}</span>
                    </div>
                    <div className="text-[13px] text-white/55 truncate mt-0.5">{m.subject ? <span className="text-white/70">{m.subject} · </span> : null}{m.body}</div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${ch.cls}`}>{ch.label}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${STATUS_CLS[m.status] || STATUS_CLS.read}`}>{m.status}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )
      )}

      {selectedReg && <RegModal reg={selectedReg} onClose={() => setSelectedReg(null)} />}
      {selectedMsg && <MessageModal msg={selectedMsg} onClose={() => setSelectedMsg(null)} />}
    </div>
  );
}

function EmptyState({ icon: Icon, title, sub }: { icon: any; title: string; sub: string }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
      <div className="flex flex-col items-center justify-center py-16 text-white/20">
        <Icon className="w-12 h-12 mb-3" />
        <p className="text-sm">{title}</p>
        <p className="text-xs mt-1">{sub}</p>
      </div>
    </div>
  );
}

function RegModal({ reg, onClose }: { reg: Reg; onClose: () => void }) {
  const { toast } = useToast();
  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `/api/admin/cic/registrations/${reg.id}/status`, { status }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/registrations"] }); },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });
  const mailHref = `mailto:${reg.email}?subject=${encodeURIComponent("Your team's spot — Christchurch International Cup")}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#141511] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-300 font-bold text-sm">{(reg.club || reg.firstName).slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white truncate">{reg.club || regName(reg)}</h2>
              <p className="text-xs text-white/40">Registered {fmtFull(reg.createdAt)}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-white/30 mb-1.5">Age groups registered</p>
            <div className="flex flex-wrap gap-1.5">
              {reg.ageGroups.map((g) => <span key={g} className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500 text-black">{g}</span>)}
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-[11px] uppercase tracking-wider text-white/30">Main contact (for all grades)</p>
            <p className="text-sm font-semibold text-white">{regName(reg)}{reg.club ? ` · ${reg.club}` : ""}</p>
            {reg.location && <p className="text-[12px] text-white/55 flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" />{reg.location}</p>}
            <div className="flex flex-wrap items-center gap-3 text-[12px] text-white/55 pt-1">
              <a href={`mailto:${reg.email}`} className="flex items-center gap-1.5 hover:text-white/80"><Mail className="w-3.5 h-3.5" />{reg.email}</a>
              {reg.phone && <a href={`tel:${reg.phone}`} className="flex items-center gap-1.5 hover:text-white/80"><Phone className="w-3.5 h-3.5" />{reg.phone}</a>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-[11px] px-2 py-0.5 rounded-full capitalize ${STATUS_CLS[reg.status] || STATUS_CLS.new}`}>{reg.status}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${countryOf(reg) === "New Zealand" ? "bg-white/[0.06] text-white/55" : countryOf(reg) ? "bg-sky-500/15 text-sky-300" : "bg-white/[0.04] text-white/30"}`}>
              {countryOf(reg) ? (countryOf(reg) === "New Zealand" ? "New Zealand" : `International · ${countryOf(reg)}`) : "Country unknown"}
            </span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full ${marketOf(reg.sourceUrl).paid ? "bg-violet-500/15 text-violet-300" : "bg-white/[0.04] text-white/35"}`}>{marketOf(reg.sourceUrl).label}</span>
          </div>
          {reg.sourceUrl && <p className="text-[11px] text-white/30 break-all">via {reg.sourceUrl}</p>}
        </div>
        <div className="p-4 border-t border-white/5 flex flex-wrap items-center gap-2">
          <a href={mailHref} className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-amber-500/90 text-black hover:bg-amber-500"><Reply className="w-3.5 h-3.5" /> Email contact</a>
          <button onClick={() => setStatus.mutate("confirmed")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-green-500/15 text-green-300 hover:bg-green-500/25 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Confirm spot</button>
          <button onClick={() => setStatus.mutate("declined")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-white/60 hover:bg-white/10"><XCircle className="w-3.5 h-3.5" /> Decline</button>
          <button onClick={() => { setStatus.mutate("archived"); onClose(); }} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-white/40 hover:text-white/70 ml-auto"><Archive className="w-3.5 h-3.5" /> Archive</button>
        </div>
      </div>
    </div>
  );
}

function MessageModal({ msg, onClose }: { msg: Msg; onClose: () => void }) {
  const { toast } = useToast();
  const ch = CHANNEL[msg.channel] || CHANNEL.web_form;
  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `/api/admin/cic/inbox/${msg.id}/status`, { status }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/inbox"] }); },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });
  const replyHref = msg.email
    ? `mailto:${msg.email}?subject=${encodeURIComponent("Re: " + (msg.subject || "your enquiry — Christchurch International Cup"))}`
    : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#141511] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${ch.cls}`}><ch.icon className="w-4 h-4" /></span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-white truncate">{msg.name || msg.email || "Unknown"}</h2>
              <p className="text-xs text-white/40">{ch.label} · {fmt(msg.createdAt)}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-white/50">
            {msg.email && <a href={`mailto:${msg.email}`} className="flex items-center gap-1.5 hover:text-white/80"><Mail className="w-3.5 h-3.5" />{msg.email}</a>}
            {msg.phone && <a href={`tel:${msg.phone}`} className="flex items-center gap-1.5 hover:text-white/80"><Phone className="w-3.5 h-3.5" />{msg.phone}</a>}
          </div>
          {msg.subject && <p className="text-sm font-semibold text-white">{msg.subject}</p>}
          <p className="text-sm leading-relaxed text-white/75 whitespace-pre-wrap">{msg.body}</p>
          {msg.sourceUrl && <p className="text-[11px] text-white/30">via {msg.sourceUrl}</p>}
        </div>
        <div className="p-4 border-t border-white/5 flex flex-wrap items-center gap-2">
          {replyHref && <a href={replyHref} onClick={() => setStatus.mutate("replied")} className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-amber-500/90 text-black hover:bg-amber-500"><Reply className="w-3.5 h-3.5" /> Reply via email</a>}
          <button onClick={() => setStatus.mutate("replied")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-50"><Check className="w-3.5 h-3.5" /> Mark replied</button>
          <button onClick={() => setStatus.mutate("read")} disabled={setStatus.isPending} className="text-xs font-medium px-3 py-2 rounded-lg text-white/60 hover:bg-white/10">Mark read</button>
          <button onClick={() => { setStatus.mutate("archived"); onClose(); }} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-white/40 hover:text-white/70 ml-auto"><Archive className="w-3.5 h-3.5" /> Archive</button>
        </div>
      </div>
    </div>
  );
}

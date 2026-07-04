import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { Crown, Trophy, Users, ChevronRight, X, Loader2, Plus, Mail, Phone, Store, Building2, PenLine } from "lucide-react";

type Customer = {
  gkey: string; contactId: number | null; firstName: string | null; lastName: string | null;
  email: string | null; phone: string | null; totalCents: number; orders: number; seasons: number;
  firstAt: string | null; lastAt: string | null; teams: string[] | null; hasLive: boolean; hasHistorical: boolean;
};
type Team = {
  teamName: string; totalCents: number; orders: number; seasons: number; captains: number;
  latestCaptain: string | null; firstAt: string | null; lastAt: string | null;
};
type JourneyRow = {
  firstName: string; lastName: string; email: string | null; phone: string | null;
  cents: number; at: string; season: string | null; variant: string | null;
  team: string | null; status: string | null; source: string; kind: string;
};
type Stats = {
  totalPurchases: number; totalCustomers: number; totalTeams: number; totalCents: number;
  firstAt: string | null; lastAt: string | null; historicalPurchases: number; livePurchases: number;
};

const fmt = (c: number) => formatCurrency(c, { fromCents: true });
const shortDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("en-NZ", { month: "short", year: "numeric" }) : "—";
const fullName = (f: string | null, l: string | null) => `${f || ""} ${l || ""}`.trim() || "Unknown";

function tierFor(seasons: number) {
  if (seasons >= 10) return { label: "Hall of Fame", cls: "bg-amber-500/20 text-amber-300 border border-amber-400/30" };
  if (seasons >= 7) return { label: "Legend", cls: "bg-amber-500/15 text-amber-300" };
  if (seasons >= 4) return { label: "Veteran", cls: "bg-violet-500/15 text-violet-300" };
  if (seasons >= 2) return { label: "Regular", cls: "bg-sky-500/15 text-sky-300" };
  return { label: "Rookie", cls: "bg-white/10 text-white/50" };
}

const SOURCE_BADGE: Record<string, { label: string; icon: any; cls: string }> = {
  shopify: { label: "Shopify", icon: Store, cls: "bg-emerald-500/15 text-emerald-300" },
  clubos: { label: "ClubOS", icon: Building2, cls: "bg-amber-500/15 text-amber-300" },
  manual: { label: "Manual", icon: PenLine, cls: "bg-white/10 text-white/60" },
};

export default function LeagueLoyalty() {
  const [view, setView] = useState<"customers" | "teams">("customers");
  const [selected, setSelected] = useState<Customer | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data: stats } = useQuery<Stats>({
    queryKey: ["/api/admin/league/loyalty/stats"],
    queryFn: () => fetch("/api/admin/league/loyalty/stats").then((r) => r.json()),
  });
  const { data: customers = [], isLoading: custLoading } = useQuery<Customer[]>({
    queryKey: ["/api/admin/league/loyalty/customers"],
    queryFn: () => fetch("/api/admin/league/loyalty/customers").then((r) => r.json()),
  });
  const { data: teams = [], isLoading: teamLoading } = useQuery<Team[]>({
    queryKey: ["/api/admin/league/loyalty/teams"],
    queryFn: () => fetch("/api/admin/league/loyalty/teams").then((r) => r.json()),
  });

  const statTiles = [
    { label: "Customers", value: stats?.totalCustomers ?? "—" },
    { label: "Teams", value: stats?.totalTeams ?? "—" },
    { label: "Lifetime value", value: stats ? fmt(stats.totalCents) : "—" },
    { label: "Purchases", value: stats ? `${stats.totalPurchases}` : "—", sub: stats ? `${stats.historicalPurchases} historical · ${stats.livePurchases} live` : undefined },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Loyalty & Lifetime Value</h1>
          <p className="text-sm text-white/40 mt-1">
            {view === "customers" ? "Your most loyal customers — every season, across all platforms" : "Most loyal teams — ranked by lifetime value"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAdd(true)} data-testid="loyalty-add-purchase"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15 transition-colors">
            <Plus className="w-3.5 h-3.5" /> Add purchase
          </button>
          <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
            {([["customers", "Customers"], ["teams", "Teams"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => setView(v)} data-testid={`loyalty-view-${v}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statTiles.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
            {s.sub && <p className="text-[10px] text-white/30 mt-0.5">{s.sub}</p>}
          </div>
        ))}
      </div>

      {view === "customers" ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
          {custLoading ? (
            <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/5">
                    <th className="py-2.5 px-4 w-10">#</th>
                    <th className="py-2.5 px-4">Customer</th>
                    <th className="py-2.5 px-4 text-center">Seasons</th>
                    <th className="py-2.5 px-4 text-center hidden sm:table-cell">Orders</th>
                    <th className="py-2.5 px-4 text-right">Lifetime value</th>
                    <th className="py-2.5 px-4 hidden md:table-cell">Loyalty</th>
                    <th className="py-2.5 px-4 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c, i) => {
                    const t = tierFor(c.seasons);
                    return (
                      <tr key={c.gkey} onClick={() => setSelected(c)} data-testid={`loyalty-customer-${i}`}
                        className="border-b border-white/[0.03] hover:bg-white/[0.03] cursor-pointer group">
                        <td className="py-2.5 px-4 text-white/40">
                          <span className="inline-flex items-center gap-1">
                            {i === 0 && c.totalCents > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}
                            {i + 1}
                          </span>
                        </td>
                        <td className="py-2.5 px-4">
                          <div className="font-medium text-white">{fullName(c.firstName, c.lastName)}</div>
                          <div className="text-[11px] text-white/30 truncate max-w-[220px]">{c.email || (c.phone ? c.phone : "no contact on file")}</div>
                        </td>
                        <td className="py-2.5 px-4 text-center text-white/70">{c.seasons}</td>
                        <td className="py-2.5 px-4 text-center text-white/70 hidden sm:table-cell">{c.orders}</td>
                        <td className="py-2.5 px-4 text-right font-semibold text-white">{fmt(c.totalCents)}</td>
                        <td className="py-2.5 px-4 hidden md:table-cell">
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${t.cls}`}>{t.label}</span>
                        </td>
                        <td className="py-2.5 px-4"><ChevronRight className="w-4 h-4 text-white/0 group-hover:text-white/30" /></td>
                      </tr>
                    );
                  })}
                  {customers.length === 0 && <tr><td colSpan={7} className="py-10 text-center text-white/30">No customers yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-2 text-[11px] text-white/30 border-b border-white/5">
            <Trophy className="w-3.5 h-3.5 inline mr-1 -mt-0.5 text-amber-400/70" />
            Team names come from the checkout — most historical Shopify orders didn't capture one, so this grows as live registrations (which always capture a team) build up.
          </div>
          {teamLoading ? (
            <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-white/30 border-b border-white/5">
                    <th className="py-2.5 px-4 w-10">#</th>
                    <th className="py-2.5 px-4">Team</th>
                    <th className="py-2.5 px-4 text-center">Seasons</th>
                    <th className="py-2.5 px-4 text-center hidden sm:table-cell">Orders</th>
                    <th className="py-2.5 px-4 text-right">Lifetime value</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((tm, i) => (
                    <tr key={tm.teamName + i} data-testid={`loyalty-team-${i}`} className="border-b border-white/[0.03] hover:bg-white/[0.03]">
                      <td className="py-2.5 px-4 text-white/40">
                        <span className="inline-flex items-center gap-1">
                          {i === 0 && tm.totalCents > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}{i + 1}
                        </span>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium text-white">{tm.teamName}</div>
                        {tm.latestCaptain && <div className="text-[11px] text-white/30">Captain: {tm.latestCaptain}</div>}
                      </td>
                      <td className="py-2.5 px-4 text-center text-white/70">{tm.seasons}</td>
                      <td className="py-2.5 px-4 text-center text-white/70 hidden sm:table-cell">{tm.orders}</td>
                      <td className="py-2.5 px-4 text-right font-semibold text-white">{fmt(tm.totalCents)}</td>
                    </tr>
                  ))}
                  {teams.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-white/30">No team names captured yet.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {selected && <JourneyModal customer={selected} onClose={() => setSelected(null)} />}
      {showAdd && <AddPurchaseModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}

function JourneyModal({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const key = customer.email || String(customer.contactId ?? "");
  const { data: journey = [], isLoading } = useQuery<JourneyRow[]>({
    queryKey: ["/api/admin/league/loyalty/journey", key],
    queryFn: () => fetch(`/api/admin/league/loyalty/journey/${encodeURIComponent(key)}`).then((r) => r.json()),
    enabled: !!key,
  });
  const t = tierFor(customer.seasons);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-white/5 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-white">{fullName(customer.firstName, customer.lastName)}</h3>
              <span className={`text-[10px] px-2 py-0.5 rounded-full ${t.cls}`}>{t.label}</span>
            </div>
            <div className="flex flex-wrap gap-3 mt-1.5 text-[11px] text-white/40">
              {customer.email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{customer.email}</span>}
              {customer.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{customer.phone}</span>}
            </div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70"><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-3 border-b border-white/5">
          {[["Lifetime value", fmt(customer.totalCents)], ["Seasons", String(customer.seasons)], ["Orders", String(customer.orders)]].map(([l, v], i) => (
            <div key={i} className="p-3 text-center border-r border-white/5 last:border-r-0">
              <p className="text-[10px] uppercase tracking-wider text-white/30">{l}</p>
              <p className="text-sm font-bold text-white mt-0.5">{v}</p>
            </div>
          ))}
        </div>
        <div className="p-4 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-white/30 mb-3">Customer journey</p>
          {isLoading ? (
            <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-white/30" /></div>
          ) : (
            <div className="space-y-2">
              {journey.map((j, i) => {
                const b = SOURCE_BADGE[j.source] || SOURCE_BADGE.manual;
                const Icon = b.icon;
                return (
                  <div key={i} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                    <div className="text-[11px] text-white/40 w-16 shrink-0">{shortDate(j.at)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white truncate">{j.season || "—"}</div>
                      <div className="text-[11px] text-white/30 truncate">
                        {[j.variant, j.team].filter(Boolean).join(" · ") || "—"}
                        {j.status && j.status !== "paid" && j.status !== "confirmed" && <span className="text-rose-300/70"> · {j.status}</span>}
                      </div>
                    </div>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${b.cls} inline-flex items-center gap-1 shrink-0`}><Icon className="w-2.5 h-2.5" />{b.label}</span>
                    <div className="text-sm font-semibold text-white w-16 text-right shrink-0">{fmt(j.cents)}</div>
                  </div>
                );
              })}
              {journey.length === 0 && <p className="text-center text-white/30 py-6 text-sm">No purchases found.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddPurchaseModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", productTitle: "", variant: "", teamName: "", amount: "", purchasedAt: "", notes: "" });
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const mut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/league/loyalty/manual", f),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/loyalty/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/loyalty/teams"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/loyalty/stats"] });
      toast({ title: "Purchase added", description: "The customer's loyalty and lifetime value are updated." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't add purchase", description: e?.message || "Try again", variant: "destructive" }),
  });

  const canSave = f.firstName.trim() && f.productTitle.trim() && f.purchasedAt && f.amount;
  const input = "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-amber-500/40 focus:outline-none";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b border-white/5 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-white">Add a missed purchase</h3>
            <p className="text-[11px] text-white/40 mt-1">For a customer who proved a registration we didn't migrate. It updates their loyalty + lifetime value instantly.</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">First name *</label><input className={input} value={f.firstName} onChange={(e) => set("firstName", e.target.value)} data-testid="add-firstName" /></div>
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Last name</label><input className={input} value={f.lastName} onChange={(e) => set("lastName", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Email</label><input className={input} value={f.email} onChange={(e) => set("email", e.target.value)} placeholder="links to their profile" /></div>
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Phone</label><input className={input} value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
          </div>
          <div><label className="text-[10px] uppercase tracking-wider text-white/30">What they signed up for *</label><input className={input} value={f.productTitle} onChange={(e) => set("productTitle", e.target.value)} placeholder="e.g. Mini Football Winter 2023" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Night / format</label><input className={input} value={f.variant} onChange={(e) => set("variant", e.target.value)} placeholder="e.g. 7-a-side Monday" /></div>
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Team name</label><input className={input} value={f.teamName} onChange={(e) => set("teamName", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Amount (NZD) *</label><input className={input} value={f.amount} onChange={(e) => set("amount", e.target.value)} inputMode="decimal" placeholder="500" /></div>
            <div><label className="text-[10px] uppercase tracking-wider text-white/30">Date paid *</label><input type="date" className={input} value={f.purchasedAt} onChange={(e) => set("purchasedAt", e.target.value)} /></div>
          </div>
          <div><label className="text-[10px] uppercase tracking-wider text-white/30">Notes</label><input className={input} value={f.notes} onChange={(e) => set("notes", e.target.value)} placeholder="e.g. proof: emailed receipt 2023" /></div>
        </div>
        <div className="p-5 border-t border-white/5 flex justify-end gap-2">
          <button onClick={onClose} className="text-xs font-medium px-3 py-2 rounded-lg text-white/50 hover:text-white/80">Cancel</button>
          <button onClick={() => mut.mutate()} disabled={!canSave || mut.isPending} data-testid="add-purchase-save"
            className="inline-flex items-center gap-1.5 text-xs font-medium px-4 py-2 rounded-lg bg-amber-500 text-black disabled:opacity-40 hover:bg-amber-400 transition-colors">
            {mut.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Add purchase
          </button>
        </div>
      </div>
    </div>
  );
}

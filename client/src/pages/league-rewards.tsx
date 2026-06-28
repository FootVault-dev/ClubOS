import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { Trophy, Mail, Phone, X, Crown, Loader2, Gift, ChevronRight } from "lucide-react";

type BuilderRow = {
  id: number; name: string; email: string; phone: string | null; builderCode: string;
  points: number; tier: string; creditEarnedCents: number; creditUsedCents: number; creditBalanceCents: number; createdAt: string;
};
type BuilderDetail = {
  builder: { id: number; name: string; email: string; phone: string | null; builderCode: string; points: number; tier: string; creditEarnedCents: number; creditUsedCents: number; creditBalanceCents: number };
  events: { id: number; type: string; points: number; commissionCents: number; referredEmail: string | null; referredTeamName: string | null; tierAtEarning: string | null; note: string | null; at: string }[];
};

const EVENT_LABEL: Record<string, string> = {
  referral_first: "New team (first league)", referral_extra: "Extra league", credit_used: "Credit redeemed", adjust: "Adjustment",
};

export default function LeagueRewards() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: builders = [], isLoading } = useQuery<BuilderRow[]>({
    queryKey: ["/api/admin/league/builders"],
    queryFn: () => fetch("/api/admin/league/builders").then((r) => r.json()),
  });

  const totalPoints = builders.reduce((s, b) => s + b.points, 0);
  const totalEarned = builders.reduce((s, b) => s + b.creditEarnedCents, 0);
  const totalBalance = builders.reduce((s, b) => s + b.creditBalanceCents, 0);
  const stats = [
    { label: "Builders", value: builders.length },
    { label: "Points earned", value: totalPoints },
    { label: "Credit earned", value: formatCurrency(totalEarned, { fromCents: true }) },
    { label: "Credit outstanding", value: formatCurrency(totalBalance, { fromCents: true }) },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Rewards</h1>
        <p className="text-sm text-white/40 mt-1">League Builders — referrals, points &amp; account credit</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
      ) : builders.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Trophy className="w-12 h-12 mb-3" />
            <p className="text-sm">No League Builders yet.</p>
            <p className="text-xs mt-1">People who opt in at /league/builders appear here as they refer teams.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-white/5">
                {["#", "Builder", "Code", "Points", "Tier", "Credit earned", "Balance"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {builders.map((b, i) => (
                <tr key={b.id} onClick={() => setSelectedId(b.id)} className="border-b border-white/[0.02] hover:bg-white/[0.03] cursor-pointer transition-colors group" data-testid={`builder-row-${b.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/40 font-semibold">{i + 1}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{i === 0 && b.points > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}{b.name}</span>
                    <div className="text-[11px] text-white/30">{b.email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs font-mono text-white/50">{b.builderCode}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-semibold tabular-nums">{b.points}</td>
                  <td className="px-4 py-2.5"><span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">{b.tier}</span></td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{formatCurrency(b.creditEarnedCents, { fromCents: true })}</td>
                  <td className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className={b.creditBalanceCents > 0 ? "text-green-400/90 font-semibold" : "text-white/30"}>{formatCurrency(b.creditBalanceCents, { fromCents: true })}</span>
                      <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId !== null && <BuilderModal id={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function BuilderModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { toast } = useToast();
  const [amount, setAmount] = useState("");
  const { data, isLoading } = useQuery<BuilderDetail>({
    queryKey: ["/api/admin/league/builders", id],
    queryFn: () => fetch(`/api/admin/league/builders/${id}`).then((r) => r.json()),
  });

  const redeem = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/league/builders/${id}/credit-used`, { amountCents: Math.round(parseFloat(amount) * 100) }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Credit recorded", description: `$${amount} marked as redeemed` });
      setAmount("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/builders", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/builders"] });
    },
    onError: (e: any) => toast({ title: "Couldn't record credit", description: e.message, variant: "destructive" }),
  });

  const b = data?.builder;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <h2 className="text-lg font-semibold text-white">{b?.name || "Builder"}</h2>
            <p className="text-xs text-white/40 mt-0.5">{b ? <><span className="font-mono">{b.builderCode}</span> · {b.tier} · {b.points} pts</> : "Loading…"}</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        {isLoading || !b ? (
          <div className="p-10 text-center text-white/20 text-sm">Loading…</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Credit earned", value: formatCurrency(b.creditEarnedCents, { fromCents: true }) },
                { label: "Redeemed", value: formatCurrency(b.creditUsedCents, { fromCents: true }) },
                { label: "Balance", value: formatCurrency(b.creditBalanceCents, { fromCents: true }), klass: b.creditBalanceCents > 0 ? "text-green-400" : "text-white/60" },
              ].map((c, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{c.label}</p>
                  <p className={`text-base font-bold mt-0.5 ${c.klass || "text-white"}`}>{c.value}</p>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-white/40">
              {b.email && <a href={`mailto:${b.email}`} className="flex items-center gap-1 hover:text-white/60"><Mail className="w-3 h-3" />{b.email}</a>}
              {b.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{b.phone}</span>}
            </div>

            {/* Record a credit redemption (Phase 1 manual) */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-2 flex-wrap">
              <Gift className="w-4 h-4 text-amber-400/70" />
              <span className="text-xs text-white/50">Record credit applied to their fees:</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" inputMode="decimal"
                className="w-24 px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none" data-testid="builder-credit-amount" />
              <button onClick={() => redeem.mutate()} disabled={!parseFloat(amount) || redeem.isPending}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40" data-testid="builder-credit-record">
                {redeem.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Record"}
              </button>
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">History</div>
              {data!.events.length === 0 ? (
                <p className="text-xs text-white/30 py-3">No activity yet.</p>
              ) : data!.events.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-white/80">{EVENT_LABEL[e.type] || e.type}{e.referredTeamName ? ` · ${e.referredTeamName}` : ""}</div>
                    <div className="text-[11px] text-white/30">{e.referredEmail || e.note || ""}{e.tierAtEarning ? ` · ${e.tierAtEarning}` : ""} · {new Date(e.at).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    {e.points > 0 && <div className="text-sm font-semibold text-white/80">+{e.points} pts</div>}
                    {e.commissionCents !== 0 && <div className={`text-[12px] ${e.commissionCents > 0 ? "text-green-400/80" : "text-white/40"}`}>{e.commissionCents > 0 ? "+" : ""}{formatCurrency(e.commissionCents, { fromCents: true })}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

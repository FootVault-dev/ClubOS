import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { Trophy, Mail, Phone, X, Crown, Loader2, Gift, ChevronRight, Ticket, Check, Shirt, Flag } from "lucide-react";

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

const REWARD_SUBTITLES: Record<string, string> = {
  builders: "League Builders — referrals, points & account credit",
  season: "Season Ticket — Team XP, loyalty tiers & vouchers",
  referee: "Referee Rewards — Ref Tokens, tiers & pay rates",
};

export default function LeagueRewards() {
  const [view, setView] = useState<"builders" | "season" | "referee">("builders");
  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Rewards</h1>
          <p className="text-sm text-white/40 mt-1">{REWARD_SUBTITLES[view]}</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {([["builders", "League Builders"], ["season", "Season Ticket"], ["referee", "Referees"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} data-testid={`rewards-view-${v}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>{label}</button>
          ))}
        </div>
      </div>
      {view === "builders" ? <BuildersView /> : view === "season" ? <SeasonView /> : <RefereeView />}
    </div>
  );
}

function BuildersView() {
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
    <>
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
    </>
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

// ── Season Ticket Rewards (loyalty) ─────────────────────────────────────────
type SeasonRow = { id: number; name: string; email: string; phone: string | null; xp: number; tier: string; rewardsIssued: number; kitPending: boolean };
type SeasonDetail = {
  member: { id: number; name: string; email: string; phone: string | null; xp: number; tier: string };
  rewards: { id: number; tier: string; rewardType: string; voucherCode: string | null; status: string; at: string }[];
  signups: { teamName: string | null; xp: number; at: string }[];
};

function SeasonView() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: members = [], isLoading } = useQuery<SeasonRow[]>({
    queryKey: ["/api/admin/league/season"],
    queryFn: () => fetch("/api/admin/league/season").then((r) => r.json()),
  });
  const stats = [
    { label: "Members", value: members.length },
    { label: "Total XP", value: members.reduce((s, m) => s + m.xp, 0) },
    { label: "Rewards issued", value: members.reduce((s, m) => s + m.rewardsIssued, 0) },
    { label: "Kits to fulfil", value: members.filter((m) => m.kitPending).length },
  ];
  return (
    <>
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
      ) : members.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Ticket className="w-12 h-12 mb-3" />
            <p className="text-sm">No Season Ticket members yet.</p>
            <p className="text-xs mt-1">Captains earn 3 Team XP each time they enter a league — they appear here automatically.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-white/5">
                {["#", "Member", "XP", "Tier", "Rewards"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m, i) => (
                <tr key={m.id} onClick={() => setSelectedId(m.id)} className="border-b border-white/[0.02] hover:bg-white/[0.03] cursor-pointer transition-colors group" data-testid={`season-row-${m.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/40 font-semibold">{i + 1}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{i === 0 && m.xp > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}{m.name}</span>
                    <div className="text-[11px] text-white/30">{m.email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-semibold tabular-nums">{m.xp}</td>
                  <td className="px-4 py-2.5"><span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">{m.tier}</span></td>
                  <td className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-white/60">{m.rewardsIssued} issued{m.kitPending && <span className="ml-2 text-[11px] text-amber-400">· kit to fulfil</span>}</span>
                      <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedId !== null && <SeasonModal id={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function SeasonModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<SeasonDetail>({
    queryKey: ["/api/admin/league/season", id],
    queryFn: () => fetch(`/api/admin/league/season/${id}`).then((r) => r.json()),
  });
  const fulfil = useMutation({
    mutationFn: (rewardId: number) => apiRequest("POST", `/api/admin/league/season/reward/${rewardId}/fulfil`).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Marked fulfilled" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/season", id] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/season"] });
    },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });
  const m = data?.member;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <h2 className="text-lg font-semibold text-white">{m?.name || "Member"}</h2>
            <p className="text-xs text-white/40 mt-0.5">{m ? <>{m.tier} · {m.xp} XP</> : "Loading…"}</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        {isLoading || !m ? (
          <div className="p-10 text-center text-white/20 text-sm">Loading…</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            <div className="flex items-center gap-3 text-[11px] text-white/40">
              {m.email && <a href={`mailto:${m.email}`} className="flex items-center gap-1 hover:text-white/60"><Mail className="w-3 h-3" />{m.email}</a>}
              {m.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{m.phone}</span>}
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Rewards unlocked</div>
              {data!.rewards.length === 0 ? <p className="text-xs text-white/30 py-3">No rewards yet.</p> : data!.rewards.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-white/80 flex items-center gap-1.5">{r.rewardType === "custom_kit" ? <Shirt className="w-3.5 h-3.5 text-amber-400" /> : <Gift className="w-3.5 h-3.5 text-amber-400" />}{r.tier}</div>
                    <div className="text-[11px] text-white/30">{r.voucherCode ? <span className="font-mono">{r.voucherCode}</span> : "Custom kit"} · {new Date(r.at).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</div>
                  </div>
                  {r.rewardType === "custom_kit" ? (
                    r.status === "fulfilled"
                      ? <span className="text-[11px] text-green-400 flex items-center gap-1"><Check className="w-3 h-3" /> Fulfilled</span>
                      : <button onClick={() => fulfil.mutate(r.id)} disabled={fulfil.isPending} className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40">Mark fulfilled</button>
                  ) : <span className="text-[11px] text-white/40">{r.status}</span>}
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Signups ({data!.signups.length})</div>
              {data!.signups.map((s, i) => (
                <div key={i} className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3.5 py-2">
                  <span className="text-sm text-white/70 truncate">{s.teamName || "Team"}</span>
                  <span className="text-[12px]"><span className="text-amber-400 font-semibold">+{s.xp} XP</span> <span className="text-white/30 ml-1">{new Date(s.at).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span></span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Referee Rewards (staff retention) ───────────────────────────────────────
type RefRow = { userId: number; name: string; email: string; gamesRefereed: number; bonusTokens: number; tokens: number; tier: string; payRateCents: number | null };
type RefDetail = {
  referee: { userId: number; name: string; email: string; tokens: number; gamesRefereed: number; gamesAssigned: number; bonusTotal: number; tier: string; payRateCents: number | null };
  tiers: { name: string; tokens: number; perk: string; payRateCents: number | null }[];
  games: { id: number; date: string | null; status: string }[];
  bonus: { id: number; tokens: number; note: string | null; at: string }[];
};

function RefereeView() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: refs = [], isLoading } = useQuery<RefRow[]>({
    queryKey: ["/api/admin/league/referees"],
    queryFn: () => fetch("/api/admin/league/referees").then((r) => r.json()),
  });
  const stats = [
    { label: "Referees", value: refs.length },
    { label: "Total tokens", value: refs.reduce((s, r) => s + r.tokens, 0) },
    { label: "Games refereed", value: refs.reduce((s, r) => s + r.gamesRefereed, 0) },
    { label: "On a pay tier", value: refs.filter((r) => r.payRateCents).length },
  ];
  return (
    <>
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
      ) : refs.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Flag className="w-12 h-12 mb-3" />
            <p className="text-sm">No referees yet.</p>
            <p className="text-xs mt-1">Refs appear here once assigned to games. 1 token per final game + bonus tokens.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[680px]">
            <thead>
              <tr className="border-b border-white/5">
                {["#", "Referee", "Games", "Bonus", "Tokens", "Tier", "Base pay"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {refs.map((r, i) => (
                <tr key={r.userId} onClick={() => setSelectedId(r.userId)} className="border-b border-white/[0.02] hover:bg-white/[0.03] cursor-pointer transition-colors group" data-testid={`ref-row-${r.userId}`}>
                  <td className="px-4 py-2.5 text-sm text-white/40 font-semibold">{i + 1}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">
                    <span className="inline-flex items-center gap-1.5">{i === 0 && r.tokens > 0 && <Crown className="w-3.5 h-3.5 text-amber-400" />}{r.name}</span>
                    <div className="text-[11px] text-white/30">{r.email}</div>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/70 tabular-nums">{r.gamesRefereed}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50 tabular-nums">{r.bonusTokens || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-semibold tabular-nums">{r.tokens}</td>
                  <td className="px-4 py-2.5"><span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">{r.tier}</span></td>
                  <td className="px-4 py-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className={r.payRateCents ? "text-green-400/90 font-semibold" : "text-white/30"}>{r.payRateCents ? formatCurrency(r.payRateCents, { fromCents: true }) + "/game" : "—"}</span>
                      <ChevronRight className="w-4 h-4 text-white/20 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selectedId !== null && <RefereeModal userId={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function RefereeModal({ userId, onClose }: { userId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [tokens, setTokens] = useState("");
  const [note, setNote] = useState("");
  const { data, isLoading } = useQuery<RefDetail>({
    queryKey: ["/api/admin/league/referees", userId],
    queryFn: () => fetch(`/api/admin/league/referees/${userId}`).then((r) => r.json()),
  });
  const addBonus = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/league/referees/${userId}/bonus`, { tokens: parseInt(tokens), note }).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Bonus tokens added" }); setTokens(""); setNote("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/referees", userId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/league/referees"] });
    },
    onError: (e: any) => toast({ title: "Couldn't add tokens", description: e.message, variant: "destructive" }),
  });
  const r = data?.referee;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div>
            <h2 className="text-lg font-semibold text-white">{r?.name || "Referee"}</h2>
            <p className="text-xs text-white/40 mt-0.5">{r ? <>{r.tier} · {r.tokens} tokens{r.payRateCents ? ` · ${formatCurrency(r.payRateCents, { fromCents: true })}/game` : ""}</> : "Loading…"}</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        {isLoading || !r ? (
          <div className="p-10 text-center text-white/20 text-sm">Loading…</div>
        ) : (
          <div className="p-5 overflow-y-auto flex-1 space-y-5">
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Games refereed", value: String(r.gamesRefereed) },
                { label: "Bonus tokens", value: String(r.bonusTotal) },
                { label: "Total tokens", value: String(r.tokens) },
              ].map((c, i) => (
                <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                  <p className="text-[10px] uppercase tracking-wider text-white/30">{c.label}</p>
                  <p className="text-base font-bold mt-0.5 text-white">{c.value}</p>
                </div>
              ))}
            </div>

            {/* Tier ladder */}
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">Tiers</div>
              {data!.tiers.map((t) => {
                const reached = r.tokens >= t.tokens;
                return (
                  <div key={t.name} className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5" style={{ borderColor: reached ? "rgba(245,200,80,0.35)" : "rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.02)" }}>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${reached ? "text-amber-300" : "text-white/80"}`}>{t.name} <span className="text-white/30 text-[12px]">{t.tokens}</span></div>
                      <div className="text-[11px] text-white/40">{t.perk}</div>
                    </div>
                    {reached && <Check className="w-4 h-4 text-green-400 flex-shrink-0" />}
                  </div>
                );
              })}
            </div>

            {/* Add bonus tokens */}
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-2">
              <div className="text-[11px] text-white/50">Add bonus tokens (courses, ref of the season, etc.)</div>
              <div className="flex items-center gap-2">
                <input value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder="Tokens" inputMode="numeric" className="w-20 px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none" data-testid="ref-bonus-tokens" />
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" className="flex-1 px-2.5 py-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none" data-testid="ref-bonus-note" />
                <button onClick={() => addBonus.mutate()} disabled={!parseInt(tokens) || addBonus.isPending} className="text-xs font-medium px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40">{addBonus.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}</button>
              </div>
              {data!.bonus.length > 0 && (
                <div className="pt-1 space-y-1">
                  {data!.bonus.map((b) => (
                    <div key={b.id} className="flex items-center justify-between text-[11px] text-white/40">
                      <span>+{b.tokens} {b.note ? `· ${b.note}` : ""}</span>
                      <span>{new Date(b.at).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

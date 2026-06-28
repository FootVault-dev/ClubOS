import { useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Copy, Share2, Trophy, Gift, TrendingUp, Check, Users } from "lucide-react";

const B = { black: "#000", card: "#101010", cardSoft: "#181818", border: "#242424", gold: "#d1b96e", white: "#fff", muted: "#b9b9b9", dim: "#7d7d7d", green: "#7bdcb5" };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

type Tier = { name: string; points: number; commissionCents: number };
type BuilderView = {
  name: string; builderCode: string; inviteUrl: string; points: number; tier: string | null;
  nextTier: { name: string; pointsAway: number } | null; tiers: Tier[];
  creditEarnedCents: number; creditUsedCents: number; creditBalanceCents: number;
  referralsCount: number; teamsReferred: number;
  recent: { teamName: string | null; points: number; commissionCents: number; at: string }[];
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: B.black, color: B.white, fontFamily: FONT }}>
      <header className="border-b sticky top-0 z-20" style={{ borderColor: B.border, background: "rgba(0,0,0,0.9)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-md mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/league"><a className="flex items-center gap-2 text-sm" style={{ color: B.muted }}><ArrowLeft className="w-4 h-4" /> Leagues</a></Link>
          <span className="text-sm font-bold" style={{ color: B.gold }}>League Builders</span>
        </div>
      </header>
      <main className="max-w-md mx-auto px-5 py-8">{children}</main>
    </div>
  );
}

export default function LeagueBuilderPage() {
  const [, dash] = useRoute("/league/builders/:token");
  const token = dash?.token || null;
  return token ? <Dashboard token={token} /> : <JoinForm />;
}

function JoinForm() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input = "w-full px-3.5 py-2.5 rounded-xl text-[15px] focus:outline-none";
  const inputStyle: React.CSSProperties = { background: B.cardSoft, border: `1px solid ${B.border}`, color: B.white };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !phone.trim()) { setError("Please add your name, email and mobile number."); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/public/league/builders/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), email: email.trim(), phone: phone.trim() }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.message || "Couldn't join.");
      setLocation(`/league/builders/${body.inviteToken}`);
    } catch (err: any) { setError(err.message); setBusy(false); }
  };

  return (
    <Shell>
      <div className="text-center mb-6">
        <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-4" style={{ background: `${B.gold}1f` }}><Trophy className="w-7 h-7" style={{ color: B.gold }} /></div>
        <h1 className="text-2xl font-bold tracking-tight">Become a League Builder</h1>
        <p className="mt-2 text-[15px]" style={{ color: B.muted }}>Get your own <strong style={{ color: B.white }}>10% code + invite link</strong> to share. Every new team you bring in earns Builder Points and account credit toward your own fees.</p>
      </div>

      <div className="rounded-3xl p-6 mb-5" style={{ background: B.card, border: `1px solid ${B.border}` }}>
        <form onSubmit={submit} className="space-y-3">
          <div><label className="block text-sm font-semibold mb-1.5">Your name</label><input className={input} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" data-testid="builder-join-name" /></div>
          <div><label className="block text-sm font-semibold mb-1.5">Email</label><input type="email" className={input} style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" data-testid="builder-join-email" /></div>
          <div><label className="block text-sm font-semibold mb-1.5">Mobile</label><input className={input} style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="021…" data-testid="builder-join-phone" /></div>
          {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.3)" }}>{error}</div>}
          <button type="submit" disabled={busy} className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60" style={{ background: B.gold, color: B.black }} data-testid="builder-join-submit">
            {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Setting you up…</> : <>Get my Builder code</>}
          </button>
        </form>
      </div>
    </Shell>
  );
}

function Dashboard({ token }: { token: string }) {
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const { data: v, isLoading, error } = useQuery<BuilderView>({
    queryKey: ["/api/public/league/builders", token],
    queryFn: () => fetch(`/api/public/league/builders/${token}`).then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); }),
  });

  const copy = async (text: string, which: "code" | "link") => {
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopied(which); setTimeout(() => setCopied(null), 1600);
  };
  const share = async () => {
    if (!v) return;
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try { await (navigator as any).share({ title: "Join Mini Football Leagues", text: `Get 10% off your team with my code ${v.builderCode}`, url: v.inviteUrl }); return; } catch {}
    }
    copy(v.inviteUrl, "link");
  };

  if (isLoading) return <Shell><div className="flex items-center justify-center py-24" style={{ color: B.muted }}><Loader2 className="w-6 h-6 animate-spin" /></div></Shell>;
  if (error || !v) return <Shell><div className="text-center py-24"><p style={{ color: B.muted }}>This Builder link isn't available.</p><Link href="/league/builders"><a className="mt-3 inline-block font-semibold" style={{ color: B.gold }}>Join League Builders</a></Link></div></Shell>;

  const pct = v.nextTier ? Math.min(100, Math.round((v.points / (v.points + v.nextTier.pointsAway)) * 100)) : 100;

  return (
    <Shell>
      <div className="mb-1 text-[13px]" style={{ color: B.muted }}>Hi {v.name.split(" ")[0]} 👋</div>
      <h1 className="text-2xl font-bold tracking-tight mb-5">Your Builder hub</h1>

      {/* Code + invite */}
      <div className="rounded-3xl p-6 mb-5" style={{ background: B.card, border: `1px solid ${B.border}` }}>
        <div className="text-[11px] uppercase tracking-[0.12em] font-bold mb-2" style={{ color: B.gold }}>Your code (10% off · stacks with early-bird)</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 text-2xl font-bold tracking-tight font-mono" data-testid="builder-code">{v.builderCode}</div>
          <button onClick={() => copy(v.builderCode, "code")} className="px-3 py-2 rounded-xl text-[13px] font-semibold" style={{ background: B.cardSoft, border: `1px solid ${B.border}`, color: B.white }}>{copied === "code" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}</button>
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-4">
          <button onClick={share} className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[13px]" style={{ background: B.gold, color: B.black }} data-testid="builder-share"><Share2 className="w-4 h-4" /> Share invite</button>
          <button onClick={() => copy(v.inviteUrl, "link")} className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[13px]" style={{ background: B.cardSoft, border: `1px solid ${B.border}`, color: B.white }}>{copied === "link" ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy link</>}</button>
        </div>
      </div>

      {/* Points + tier */}
      <div className="rounded-3xl p-6 mb-5" style={{ background: B.card, border: `1px solid ${B.border}` }}>
        <div className="flex items-end justify-between">
          <div><div className="text-[11px] uppercase tracking-[0.12em] font-bold" style={{ color: B.gold }}>Builder Points</div><div className="text-4xl font-bold tracking-tight mt-1">{v.points}</div></div>
          <div className="text-right"><div className="text-[11px] uppercase tracking-[0.12em] font-bold" style={{ color: B.gold }}>Tier</div><div className="text-xl font-bold mt-1">{v.tier || "—"}</div></div>
        </div>
        {v.nextTier && (
          <div className="mt-4">
            <div className="h-2 rounded-full overflow-hidden" style={{ background: B.cardSoft }}><div className="h-full rounded-full" style={{ width: `${pct}%`, background: B.gold }} /></div>
            <div className="mt-1.5 text-[12px]" style={{ color: B.dim }}>{v.nextTier.pointsAway} more {v.nextTier.pointsAway === 1 ? "point" : "points"} → <strong style={{ color: B.muted }}>{v.nextTier.name}</strong></div>
          </div>
        )}
      </div>

      {/* Credit */}
      <div className="rounded-3xl p-6 mb-5" style={{ background: B.card, border: `1px solid ${B.border}` }}>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold mb-3" style={{ color: B.gold }}><Gift className="w-3.5 h-3.5" /> Account credit</div>
        <div className="flex items-baseline justify-between">
          <span className="text-3xl font-bold tracking-tight" style={{ color: B.green }}>{money(v.creditBalanceCents)}</span>
          <span className="text-[13px]" style={{ color: B.dim }}>balance toward your fees</span>
        </div>
        <div className="mt-2 text-[12px]" style={{ color: B.dim }}>{money(v.creditEarnedCents)} earned · {money(v.creditUsedCents)} used · {v.teamsReferred} {v.teamsReferred === 1 ? "team" : "teams"} referred</div>
      </div>

      {/* Tier ladder */}
      <div className="rounded-3xl p-6 mb-5" style={{ background: B.card, border: `1px solid ${B.border}` }}>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold mb-3" style={{ color: B.gold }}><TrendingUp className="w-3.5 h-3.5" /> Reward tiers</div>
        <div className="space-y-2">
          {v.tiers.map((t) => {
            const reached = v.points >= t.points;
            return (
              <div key={t.name} className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5" style={{ background: B.cardSoft, border: `1px solid ${reached ? `${B.gold}55` : B.border}` }}>
                <div className="flex items-center gap-2"><span className="font-semibold text-[14px]" style={{ color: reached ? B.gold : B.white }}>{t.name}</span><span className="text-[12px]" style={{ color: B.dim }}>{t.points} pts</span></div>
                <span className="text-[13px] font-semibold" style={{ color: reached ? B.green : B.muted }}>{money(t.commissionCents)}/team</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent referrals */}
      {v.recent.length > 0 && (
        <div className="rounded-3xl p-6" style={{ background: B.card, border: `1px solid ${B.border}` }}>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] font-bold mb-3" style={{ color: B.gold }}><Users className="w-3.5 h-3.5" /> Recent referrals</div>
          <div className="space-y-2">
            {v.recent.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5" style={{ background: B.cardSoft, border: `1px solid ${B.border}` }}>
                <div className="text-[14px] font-semibold truncate">{r.teamName || "New team"}</div>
                <div className="text-right flex-shrink-0"><span className="text-[13px] font-semibold" style={{ color: B.gold }}>+{r.points} pts</span>{r.commissionCents > 0 && <span className="ml-2 text-[12px]" style={{ color: B.green }}>{money(r.commissionCents)}</span>}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

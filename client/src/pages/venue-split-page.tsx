import { useEffect, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import {
  ArrowLeft, Lock, Loader2, AlertCircle, Share2, Copy, CheckCircle2, Users, LogOut, ShieldCheck, Clock3,
} from "lucide-react";

// United Sports Centre — venue split hub (Player Pay). Reuses the generic
// /api/public/league/split/:code/* backend; this page is the USC-branded surface
// (indigo, navy) — distinct from the MFL gold/black hub.
const T = {
  black: "#070b14", card: "#0e1424", cardSoft: "#161f33", border: "rgba(255,255,255,0.08)",
  accent: "#6366f1", accentSoft: "rgba(99,102,241,0.14)", white: "#ffffff", muted: "#9aa3b2",
  dim: "#5f6b80", green: "#34d399", red: "#f87171",
};
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SUPPORT_EMAIL = "bookings@unitedsportscentre.com";
const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;
const APPEARANCE: any = {
  theme: "night",
  variables: { colorPrimary: T.accent, colorBackground: "#0e1424", colorText: "#e8ecf4", borderRadius: "12px", fontFamily: FONT },
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type ViewerStatus = "joined" | "card_saved" | "paid" | "failed" | "removed";
interface SplitMemberView { id: number; name: string | null; emailMasked: string; role: string; status: ViewerStatus; chargedCents: number; isYou: boolean }
interface SplitViewer { memberId: number; role: string; status: ViewerStatus; chargedCents: number; email: string }
interface SplitView {
  code: string; status: "open" | "settling" | "settled" | "cancelled" | "failed"; fundingType: string;
  teamName: string | null; totalCents: number; currency: string; targetCount: number | null;
  joinedCount: number; cardCount: number; paidCount: number; provisionalShareCents: number;
  deadlineAt: string | null; settledAt: string | null; isOrganiserView: boolean;
  members: SplitMemberView[]; viewer: SplitViewer | null;
}

const tokenKey = (code: string) => `usc_split_${code}`;
function loadTokens(code: string): { organiserToken?: string; memberToken?: string } {
  try { return JSON.parse(localStorage.getItem(tokenKey(code)) || "{}"); } catch { return {}; }
}
function saveTokens(code: string, t: { organiserToken?: string; memberToken?: string }) {
  const next = { ...loadTokens(code), ...t };
  localStorage.setItem(tokenKey(code), JSON.stringify(next));
}
// Pay-secret handoff from the booking page (same in-memory map used by MFL lib).
import { consumeSetupSecret, stashSetupSecret } from "@/lib/split-pay";

function PayForm({ code, returnUrl, onPaid, amountCents }: { code: string; returnUrl: string; onPaid: () => void; amountCents: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true); setError(null);
    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl }, redirect: "if_required" });
    if (stripeError) { setError(stripeError.message || "Payment failed. Please try again."); setProcessing(false); return; }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      try {
        await fetch(`/api/public/league/split/${code}/confirm-payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentIntentId: paymentIntent.id }) });
      } catch { /* webhook backstop */ }
      onPaid();
      return;
    }
    setError("Payment couldn't be processed. Please try another card.");
    setProcessing(false);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-2xl p-5" style={{ background: T.card, border: `1px solid ${T.border}`, minHeight: 90 }}>
        {!ready && <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: T.muted }}><Loader2 className="w-4 h-4 animate-spin" /> Loading secure payment…</div>}
        <div style={{ display: ready ? "block" : "none" }}><PaymentElement options={{ layout: "tabs" }} onReady={() => setReady(true)} /></div>
      </div>
      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.12)", color: T.red, border: "1px solid rgba(248,113,113,0.3)" }}>{error}</div>}
      <button type="submit" disabled={!stripe || !ready || processing}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
        style={{ background: T.accent, color: "#fff" }} data-testid="venue-button-pay">
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</> : <><Lock className="w-4 h-4" /> Pay {money(amountCents)}</>}
      </button>
      <div className="flex items-center justify-center gap-5 text-[12px]" style={{ color: T.dim }}>
        <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Your share only</span>
        <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Stripe secure</span>
      </div>
    </form>
  );
}

export default function VenueSplitPage() {
  const [, params] = useRoute("/book/split/:code");
  const code = params?.code || "";
  const [tokens, setTokens] = useState(() => loadTokens(code));
  const viewToken = tokens.organiserToken || tokens.memberToken || null;

  const [joinName, setJoinName] = useState("");
  const [joinEmail, setJoinEmail] = useState("");
  const [joinPhone, setJoinPhone] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [paySecret, setPaySecret] = useState<string | null>(null);
  const fetching = useRef(false);
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/book/split/${code}` : "";

  const { data: view, isLoading, refetch, error: viewError } = useQuery<SplitView>({
    queryKey: ["venue-split", code, viewToken],
    queryFn: async () => {
      const url = viewToken ? `/api/public/league/split/${code}?token=${encodeURIComponent(viewToken)}` : `/api/public/league/split/${code}`;
      const res = await fetch(url);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "not found"); }
      return res.json();
    },
    enabled: !!code,
    refetchInterval: (q) => (q.state.data?.status === "open" ? 2500 : false),
  });

  // 3DS redirect-back → confirm payment.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const pi = sp.get("payment_intent");
    if (sp.get("redirect_status") === "succeeded" && pi) {
      (async () => {
        try { await fetch(`/api/public/league/split/${code}/confirm-payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentIntentId: pi }) }); } catch {}
        window.history.replaceState({}, "", `/book/split/${code}`);
        refetch();
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Fetch the viewer's pay-intent secret when they still owe.
  useEffect(() => {
    if (!view || view.status !== "open") return;
    const needsPay = !!view.viewer && (view.viewer.status === "joined" || view.viewer.status === "failed");
    if (!needsPay || paySecret || fetching.current) return;
    const handoff = consumeSetupSecret(code);
    if (handoff) { setPaySecret(handoff); return; }
    const mt = tokens.memberToken;
    if (!mt) return;
    fetching.current = true;
    fetch(`/api/public/league/split/${code}/pay-intent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: mt }) })
      .then((r) => r.json()).then((b) => { if (b.paymentClientSecret) setPaySecret(b.paymentClientSecret); })
      .catch(() => {}).finally(() => { fetching.current = false; });
  }, [view, paySecret, code, tokens.memberToken]);

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareUrl); } catch {}
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  const handleShare = async () => {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try { await (navigator as any).share({ title: `Pay your share — ${view?.teamName || "our booking"}`, text: "Chip in for our booking — open the link and pay your share.", url: shareUrl }); return; } catch {}
    }
    copyLink();
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinName.trim() || !joinEmail.trim() || !joinPhone.trim()) { setJoinError("Please add your name, email and mobile number."); return; }
    setJoining(true); setJoinError(null);
    try {
      const res = await fetch(`/api/public/league/split/${code}/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: joinName.trim(), email: joinEmail.trim(), phone: joinPhone.trim() }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Couldn't join this split.");
      saveTokens(code, { memberToken: body.memberToken });
      setTokens((p) => ({ ...p, memberToken: body.memberToken }));
      if (body.paymentClientSecret) setPaySecret(body.paymentClientSecret);
      refetch();
    } catch (err: any) { setJoinError(err.message || "Something went wrong."); setJoining(false); }
  };

  const handleLeave = async () => {
    if (!tokens.memberToken) return;
    try { await fetch(`/api/public/league/split/${code}/leave`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: tokens.memberToken }) }); } catch {}
    saveTokens(code, { memberToken: undefined });
    setTokens((p) => ({ ...p, memberToken: undefined })); setPaySecret(null); refetch();
  };

  const handleCancel = async () => {
    if (!tokens.organiserToken) return;
    if (!window.confirm("Cancel this booking and refund anyone who's already paid? This frees the slot and can't be undone.")) return;
    setCancelling(true);
    try { await fetch(`/api/public/league/split/${code}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organiserToken: tokens.organiserToken }) }); } catch {}
    setCancelling(false); refetch();
  };

  if (isLoading) return <Shell><div className="flex items-center justify-center py-24" style={{ color: T.muted }}><Loader2 className="w-6 h-6 animate-spin" /></div></Shell>;
  if (viewError || !view) return (
    <Shell><div className="text-center py-24"><p style={{ color: T.muted }}>This booking link isn't available.</p><Link href="/book"><a className="mt-3 inline-block font-semibold" style={{ color: T.accent }}>Make a booking</a></Link></div></Shell>
  );

  const isOrganiser = view.isOrganiserView;
  const viewer = view.viewer;
  const shareCents = view.targetCount && view.targetCount > 0 ? Math.round(view.totalCents / view.targetCount) : (view.provisionalShareCents || 0);
  const deadlineLabel = view.deadlineAt ? (() => { try { return new Date(view.deadlineAt!).toLocaleDateString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch { return null; } })() : null;

  return (
    <Shell>
      {/* Header */}
      <div className="rounded-3xl p-6 mb-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-bold mb-2.5" style={{ color: T.accent }}>
          <Users className="w-3.5 h-3.5" /> Player Pay
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{view.teamName || "Your booking"}</h1>
        <p className="mt-1.5 text-[15px]" style={{ color: T.muted }}>{money(view.totalCents)} total, split equally across your group.</p>
        <div className="mt-5 flex items-end gap-2">
          <span className="text-4xl font-bold tracking-tight" style={{ color: T.accent }}>{money(shareCents)}</span>
          <span className="text-sm mb-1.5" style={{ color: T.muted }}>each{view.targetCount ? ` · ${view.targetCount} people` : ""}</span>
        </div>
        {deadlineLabel && view.status === "open" && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-[12px]" style={{ color: T.dim }}><Clock3 className="w-3.5 h-3.5" /> Slot held until {deadlineLabel}</p>
        )}
      </div>

      {/* Counters */}
      <div className="flex gap-3 mb-3">
        <Counter value={view.joinedCount} total={view.targetCount || view.joinedCount} label="Joined" />
        <Counter value={view.paidCount} total={view.targetCount || view.joinedCount} label="Paid" />
      </div>

      {/* Share row */}
      <div className="grid grid-cols-2 gap-2.5 mb-5">
        <button onClick={handleShare} className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[13px]" style={{ background: T.accent, color: "#fff" }} data-testid="venue-button-share"><Share2 className="w-4 h-4" /> Share</button>
        <button onClick={copyLink} className="flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[13px]" style={{ background: T.cardSoft, border: `1px solid ${T.border}`, color: T.white }} data-testid="venue-button-copy"><Copy className="w-4 h-4" /> {copied ? "Copied!" : "Copy link"}</button>
      </div>

      <ViewerPanel
        view={view} viewer={viewer} code={code} memberToken={tokens.memberToken} paySecret={paySecret}
        shareCents={shareCents} hubUrl={shareUrl}
        joinName={joinName} setJoinName={setJoinName} joinEmail={joinEmail} setJoinEmail={setJoinEmail}
        joinPhone={joinPhone} setJoinPhone={setJoinPhone} joining={joining} joinError={joinError}
        onJoin={handleJoin} onLeave={handleLeave} onPaid={() => refetch()}
      />

      {/* Group status */}
      {view.members.length > 0 && (
        <div className="mt-5 rounded-3xl p-5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <div className="text-[11px] uppercase tracking-[0.12em] font-bold mb-3" style={{ color: T.muted }}>Group · {view.paidCount}/{view.targetCount || view.joinedCount} paid</div>
          <div className="space-y-2">
            {view.members.filter((m) => m.status !== "removed").map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-2.5" style={{ background: T.cardSoft, border: `1px solid ${T.border}` }}>
                <div className="min-w-0">
                  <div className="font-semibold text-[14px] truncate">{m.name || "—"}{m.isYou ? " (You)" : ""}{m.role === "organiser" ? " · organiser" : ""}</div>
                  <div className="text-[12px] truncate" style={{ color: T.dim }}>{m.emailMasked}</div>
                </div>
                <span className="text-[11px] px-2.5 py-1 rounded-full font-semibold whitespace-nowrap" style={m.status === "paid" ? { background: "rgba(52,211,153,0.16)", color: T.green } : m.status === "failed" ? { background: "rgba(248,113,113,0.16)", color: T.red } : { background: "rgba(255,255,255,0.07)", color: T.muted }}>
                  {m.status === "paid" ? "Paid" : m.status === "failed" ? "Declined" : "To pay"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {isOrganiser && view.status === "open" && (
        <button onClick={handleCancel} disabled={cancelling} className="mt-5 w-full text-center text-[12px]" style={{ color: T.dim }} data-testid="venue-button-cancel">
          {cancelling ? "Cancelling…" : "Cancel this booking"}
        </button>
      )}
    </Shell>
  );
}

function Counter({ value, total, label }: { value: number; total: number; label: string }) {
  return (
    <div className="flex-1 rounded-2xl px-4 py-3.5 text-center" style={{ background: T.cardSoft, border: `1px solid ${T.border}` }}>
      <div className="text-2xl font-bold tabular-nums tracking-tight">{value}<span style={{ color: T.dim }} className="text-base font-semibold">/{total}</span></div>
      <div className="text-[11px] uppercase tracking-[0.1em] mt-0.5 font-semibold" style={{ color: T.muted }}>{label}</div>
    </div>
  );
}

function ViewerPanel(props: {
  view: SplitView; viewer: SplitViewer | null; code: string; memberToken?: string; paySecret: string | null;
  shareCents: number; hubUrl: string;
  joinName: string; setJoinName: (s: string) => void; joinEmail: string; setJoinEmail: (s: string) => void;
  joinPhone: string; setJoinPhone: (s: string) => void; joining: boolean; joinError: string | null;
  onJoin: (e: React.FormEvent) => void; onLeave: () => void; onPaid: () => void;
}) {
  const { view, viewer, code, memberToken, paySecret, shareCents, hubUrl, joinName, setJoinName, joinEmail, setJoinEmail, joinPhone, setJoinPhone, joining, joinError, onJoin, onLeave, onPaid } = props;
  const wrap = "rounded-3xl p-6"; const style: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}` };
  const input = "w-full px-3.5 py-2.5 rounded-xl text-[15px] focus:outline-none";
  const inputStyle: React.CSSProperties = { background: T.cardSoft, border: `1px solid ${T.border}`, color: T.white };

  if (!memberToken && view.status === "open") {
    return (
      <div className={wrap} style={style}>
        <h2 className="text-lg font-bold tracking-tight">Pay your share</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: T.muted }}>Add your details, then pay your <strong style={{ color: T.white }}>{money(shareCents)}</strong> share on your own card.</p>
        <form onSubmit={onJoin} className="space-y-3">
          <div><label className="block text-sm font-semibold mb-1.5">Your name</label><input className={input} style={inputStyle} value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Full name" /></div>
          <div><label className="block text-sm font-semibold mb-1.5">Email</label><input type="email" className={input} style={inputStyle} value={joinEmail} onChange={(e) => setJoinEmail(e.target.value)} placeholder="you@email.com" /></div>
          <div><label className="block text-sm font-semibold mb-1.5">Mobile</label><input className={input} style={inputStyle} value={joinPhone} onChange={(e) => setJoinPhone(e.target.value)} placeholder="021…" /></div>
          {joinError && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.12)", color: T.red, border: "1px solid rgba(248,113,113,0.3)" }}>{joinError}</div>}
          <button type="submit" disabled={joining} className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60" style={{ background: T.accent, color: "#fff" }} data-testid="venue-button-join">
            {joining ? <><Loader2 className="w-4 h-4 animate-spin" /> Continuing…</> : <>Continue to payment</>}
          </button>
          <p className="text-center text-[12px]" style={{ color: T.dim }}>Your share: {money(shareCents)} — an equal split of the total</p>
        </form>
      </div>
    );
  }

  if (viewer?.status === "paid") {
    return (
      <div className={wrap} style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)" }}>
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "rgba(52,211,153,0.16)" }}><CheckCircle2 className="w-6 h-6" style={{ color: T.green }} /></div>
          <div><h2 className="text-lg font-bold tracking-tight">Your share is paid</h2><p className="text-sm mt-0.5" style={{ color: T.muted }}>{money(viewer.chargedCents || shareCents)} — you're all set{view.status === "settled" ? ". The booking's confirmed!" : "."}</p></div>
        </div>
      </div>
    );
  }

  if (view.status !== "open") {
    const msg = view.status === "settled" ? "This booking is fully paid and confirmed." : view.status === "cancelled" ? "This booking was cancelled. Anyone who paid has been refunded." : "This split is closed.";
    return <div className={wrap} style={style}><p className="text-sm" style={{ color: T.muted }}>{msg}</p></div>;
  }

  const declined = viewer?.status === "failed";
  const needsPay = viewer?.status === "joined" || declined || (!viewer && !!paySecret);
  if (needsPay) {
    return (
      <div className={wrap} style={{ background: T.card, border: declined ? "1px solid rgba(248,113,113,0.3)" : `1px solid ${T.border}` }}>
        <h2 className="text-lg font-bold tracking-tight">{declined ? "That card didn't go through" : "Pay your share"}</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: T.muted }}>
          {declined ? <>Try another card to pay your <strong style={{ color: T.white }}>{money(shareCents)}</strong> share.</> : <>Your <strong style={{ color: T.white }}>{money(shareCents)}</strong> share — one charge, now. You'll get an email receipt.</>}
        </p>
        {!stripePromise ? (
          <div className="rounded-2xl p-5 flex items-start gap-3 text-sm" style={{ background: T.cardSoft, border: "1px solid rgba(248,113,113,0.3)", color: T.red }}>
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /><div><p className="font-semibold" style={{ color: T.white }}>Payment temporarily unavailable</p><p className="mt-1" style={{ color: T.muted }}>Refresh and try again, or email {SUPPORT_EMAIL}.</p></div>
          </div>
        ) : !paySecret ? (
          <div className="rounded-2xl p-5 flex items-center justify-center gap-2 text-sm" style={{ background: T.cardSoft, border: `1px solid ${T.border}`, color: T.muted }}><Loader2 className="w-4 h-4 animate-spin" /> Opening secure payment…</div>
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret: paySecret, appearance: APPEARANCE }}>
            <PayForm code={code} returnUrl={hubUrl} onPaid={onPaid} amountCents={shareCents} />
          </Elements>
        )}
        {viewer && viewer.role !== "organiser" && (
          <button onClick={onLeave} className="mt-4 inline-flex items-center gap-1.5 text-[12px]" style={{ color: T.dim }} data-testid="venue-button-leave"><LogOut className="w-3.5 h-3.5" /> Leave this split</button>
        )}
      </div>
    );
  }
  return null;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: T.black, color: T.white, fontFamily: FONT }}>
      <header className="border-b sticky top-0 z-20" style={{ borderColor: T.border, background: "rgba(7,11,20,0.9)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-md mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/book"><a className="flex items-center gap-2 text-sm" style={{ color: T.muted }}><ArrowLeft className="w-4 h-4" /> Booking</a></Link>
          <span className="text-sm flex items-center gap-1.5" style={{ color: T.dim }}><Lock className="w-3.5 h-3.5" /> Secure</span>
        </div>
      </header>
      <main className="max-w-md mx-auto px-5 py-8">{children}</main>
    </div>
  );
}

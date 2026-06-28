import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { motion, AnimatePresence, animate } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft, Lock, ShieldCheck, Loader2, AlertCircle, Share2, Copy, QrCode,
  Users, Check, CheckCircle2, Trophy, X, Crown, Clock3, CreditCard, LogOut, Sparkles,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { consumeSetupSecret, loadSplitTokens, saveSplitTokens, type SplitTokens } from "@/lib/split-pay";

// Only initialise Stripe if the publishable key was baked into the build.
const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

const BRAND = {
  black: "#000000", bg: "#0a0a0a", card: "#141414", cardSoft: "#1c1c1c", border: "#2a2a2a",
  gold: "#d1b96e", goldDeep: "#a8915a", white: "#ffffff",
  muted: "rgba(255,255,255,0.62)", dim: "rgba(255,255,255,0.38)",
  green: "#7bdcb5", red: "#fca5a5",
};
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";

// Pinned dark theme so the card fields are always readable on the black page —
// identical to the MFL checkout so there's never a blank/unreadable PaymentElement.
const APPEARANCE = {
  theme: "night" as const,
  variables: {
    colorPrimary: BRAND.gold,
    colorBackground: BRAND.cardSoft,
    colorText: "#ffffff",
    colorTextSecondary: "rgba(255,255,255,0.7)",
    colorTextPlaceholder: "rgba(255,255,255,0.45)",
    colorIcon: "rgba(255,255,255,0.7)",
    colorDanger: "#ef4444",
    fontFamily: "Inter Tight, system-ui, sans-serif",
    spacingUnit: "4px",
    borderRadius: "12px",
    fontSizeBase: "15px",
  },
  rules: {
    ".Input": { border: `1px solid ${BRAND.border}`, backgroundColor: "#0f0f0f", color: "#ffffff" },
    ".Input:focus": { border: `1px solid ${BRAND.gold}`, boxShadow: `0 0 0 1px ${BRAND.gold}` },
    ".Input::placeholder": { color: "rgba(255,255,255,0.4)" },
    ".Label": { color: "rgba(255,255,255,0.7)", fontWeight: "500" },
    ".Tab": { border: `1px solid ${BRAND.border}`, backgroundColor: "#0f0f0f", color: "#ffffff" },
    ".Tab:hover": { color: "#ffffff" },
    ".Tab--selected": { border: `1px solid ${BRAND.gold}`, color: "#ffffff" },
    ".TabLabel": { color: "#ffffff" },
  },
};

const inputCls = "w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors";
const inputStyle: React.CSSProperties = { background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white };

// ── Types (mirror the server contract) ───────────────────────────────────────
type MemberRole = "organiser" | "member";
type MemberStatus = "joined" | "card_saved" | "paid" | "failed" | "removed";
type SplitStatus = "open" | "settling" | "settled" | "cancelled" | "failed";

interface SplitMember {
  id: string; name: string; emailMasked: string; role: MemberRole;
  status: MemberStatus; chargedCents: number; isYou: boolean;
}
interface SplitViewer {
  memberId: string; role: MemberRole; status: MemberStatus;
  chargedCents: number; email: string; setupIntentId: string | null;
}
interface SplitView {
  code: string; status: SplitStatus; teamName: string; totalCents: number; currency: string;
  targetCount: number; joinedCount: number; cardCount: number; paidCount: number;
  shareLockedCents: number | null; provisionalShareCents: number;
  lockedAt: string | null; settledAt: string | null; deadlineAt: string | null;
  isOrganiserView: boolean; members: SplitMember[]; viewer: SplitViewer | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small primitives
// ─────────────────────────────────────────────────────────────────────────────
function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const controls = animate(from.current, value, {
      duration: 0.5, ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    from.current = value;
    return () => controls.stop();
  }, [value]);
  return <>{display}</>;
}

function Counter({ value, total, label }: { value: number; total: number; label: string }) {
  return (
    <div className="flex-1 rounded-2xl px-4 py-3.5 text-center" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}` }}>
      <div className="text-2xl font-bold tabular-nums tracking-tight">
        <AnimatedNumber value={value} /><span style={{ color: BRAND.dim }} className="text-base font-semibold">/{total}</span>
      </div>
      <div className="text-[11px] uppercase tracking-[0.1em] mt-0.5 font-semibold" style={{ color: BRAND.muted }}>{label}</div>
    </div>
  );
}

function StatusPill({ status, role }: { status: MemberStatus; role: MemberRole }) {
  const map: Record<MemberStatus, { label: string; bg: string; fg: string }> = {
    joined: { label: "Waiting on card", bg: "rgba(255,255,255,0.07)", fg: BRAND.muted },
    card_saved: { label: "Ready", bg: `${BRAND.gold}1f`, fg: BRAND.gold },
    paid: { label: "Paid", bg: "rgba(123,220,181,0.14)", fg: BRAND.green },
    failed: { label: "Failed", bg: "rgba(220,38,38,0.14)", fg: BRAND.red },
    removed: { label: "Removed", bg: "rgba(255,255,255,0.05)", fg: BRAND.dim },
  };
  const s = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap" style={{ background: s.bg, color: s.fg }}>
      {status === "paid" && <Check className="w-3 h-3" />}
      {role === "organiser" && <Crown className="w-3 h-3" />}
      {s.label}
    </span>
  );
}

function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-5"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          style={{ background: "rgba(0,0,0,0.7)", backdropFilter: "blur(6px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="w-full max-w-sm rounded-3xl p-6 relative"
            style={{ background: BRAND.card, border: `1px solid ${BRAND.border}`, fontFamily: FONT }}
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center" style={{ background: BRAND.cardSoft, color: BRAND.muted }} data-testid="button-close-modal">
              <X className="w-4 h-4" />
            </button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FullLoader({ label }: { label: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4"
      style={{ background: "rgba(0,0,0,0.82)", backdropFilter: "blur(8px)", fontFamily: FONT }}
    >
      <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ background: `${BRAND.gold}1f` }}>
        <Loader2 className="w-7 h-7 animate-spin" style={{ color: BRAND.gold }} />
      </div>
      <p className="text-sm font-semibold" style={{ color: BRAND.white }}>{label}</p>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Card forms (Stripe Elements) — SetupIntent (save card) + PaymentIntent (retry)
// ─────────────────────────────────────────────────────────────────────────────
function SetupForm({ code, memberToken, email, returnUrl, onSaved }: {
  code: string; memberToken: string; email?: string; returnUrl: string; onSaved: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true); setError(null);

    const { error: stripeError, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });

    if (stripeError) { setError(stripeError.message || "We couldn't save your card. Please try again."); setProcessing(false); return; }

    if (setupIntent && setupIntent.status === "succeeded") {
      try {
        await fetch(`/api/public/league/split/${code}/confirm-setup`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken }),
        });
      } catch { /* the webhook handles it too */ }
      onSaved();
      return;
    }
    setError("We couldn't confirm your card. Please try another.");
    setProcessing(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-2xl p-5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}`, minHeight: 96 }}>
        {!ready && !loadError && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: BRAND.muted }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading secure card form…
          </div>
        )}
        {loadError && (
          <div className="flex items-start gap-2 text-sm" style={{ color: BRAND.red }}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {loadError}
          </div>
        )}
        <div style={{ display: ready ? "block" : "none" }}>
          <PaymentElement
            options={{ layout: "tabs", defaultValues: { billingDetails: email ? { email } : undefined } }}
            onReady={() => setReady(true)}
            onLoadError={(e: any) => setLoadError(e?.error?.message || "Couldn't load the card form. Refresh and try again.")}
          />
        </div>
      </div>

      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: BRAND.red, border: "1px solid rgba(220,38,38,0.3)" }}>{error}</div>}

      <button type="submit" disabled={!stripe || !ready || processing}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
        style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-save-card">
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving your card…</> : <><Lock className="w-4 h-4" /> Save my card</>}
      </button>

      <div className="flex items-center justify-center gap-5 text-[12px]" style={{ color: BRAND.dim }}>
        <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> No charge yet</span>
        <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Stripe secure</span>
      </div>
    </form>
  );
}

function RetryForm({ code, returnUrl, onPaid }: { code: string; returnUrl: string; onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true); setError(null);

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });

    if (stripeError) { setError(stripeError.message || "Payment failed. Please try again."); setProcessing(false); return; }

    if (paymentIntent && paymentIntent.status === "succeeded") {
      try {
        await fetch(`/api/public/league/split/${code}/confirm-payment`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentIntentId: paymentIntent.id }),
        });
      } catch { /* webhook backstop */ }
      onPaid();
      return;
    }
    setError("Payment could not be processed. Please try another card.");
    setProcessing(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-2xl p-5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}`, minHeight: 96 }}>
        {!ready && !loadError && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: BRAND.muted }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading secure payment…
          </div>
        )}
        {loadError && (
          <div className="flex items-start gap-2 text-sm" style={{ color: BRAND.red }}>
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {loadError}
          </div>
        )}
        <div style={{ display: ready ? "block" : "none" }}>
          <PaymentElement options={{ layout: "tabs" }} onReady={() => setReady(true)}
            onLoadError={(e: any) => setLoadError(e?.error?.message || "Couldn't load the payment form. Refresh and try again.")} />
        </div>
      </div>

      {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: BRAND.red, border: "1px solid rgba(220,38,38,0.3)" }}>{error}</div>}

      <button type="submit" disabled={!stripe || !ready || processing}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
        style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-retry-pay">
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</> : <><Lock className="w-4 h-4" /> Pay my share</>}
      </button>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main page
// ─────────────────────────────────────────────────────────────────────────────
export default function MflSplitPage() {
  const [, params] = useRoute("/league/split/:code");
  const code = params?.code || "";

  const [tokens, setTokens] = useState<SplitTokens>(() => loadSplitTokens(code));
  const viewToken = tokens.organiserToken || tokens.memberToken || null;

  // Join form (no-token visitors)
  const [joinName, setJoinName] = useState("");
  const [joinEmail, setJoinEmail] = useState("");
  const [joinPhone, setJoinPhone] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  // Card-save flow
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const fetchingSecret = useRef(false);

  // Retry flow
  const [retrySecret, setRetrySecret] = useState<string | null>(null);
  const [retryLoading, setRetryLoading] = useState(false);

  // Organiser actions
  const [locking, setLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [showGroup, setShowGroup] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = typeof window !== "undefined" ? `${window.location.origin}/league/split/${code}` : "";
  const hubUrl = shareUrl;

  // ── View query (polls while live) ──────────────────────────────────────────
  const { data: view, isLoading, refetch, error: viewError } = useQuery<SplitView>({
    queryKey: ["split", code, viewToken],
    queryFn: async () => {
      const url = viewToken
        ? `/api/public/league/split/${code}?token=${encodeURIComponent(viewToken)}`
        : `/api/public/league/split/${code}`;
      const res = await fetch(url);
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || "not found"); }
      return res.json();
    },
    enabled: !!code,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "open" || s === "settling" ? 2500 : false;
    },
  });

  // ── Handle Stripe redirect-back (3DS) ──────────────────────────────────────
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const redirectStatus = sp.get("redirect_status");
    const si = sp.get("setup_intent");
    const pi = sp.get("payment_intent");
    if (redirectStatus === "succeeded" && (si || pi)) {
      const mt = loadSplitTokens(code).memberToken;
      (async () => {
        try {
          if (si && mt) {
            await fetch(`/api/public/league/split/${code}/confirm-setup`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: mt }),
            });
          } else if (pi) {
            await fetch(`/api/public/league/split/${code}/confirm-payment`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paymentIntentId: pi }),
            });
          }
        } catch { /* webhook backstop */ }
        // Clean the URL and refetch the fresh state.
        window.history.replaceState({}, "", `/league/split/${code}`);
        refetch();
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // ── Ensure we have a SetupIntent secret when the viewer still needs a card ──
  useEffect(() => {
    if (!view || view.status !== "open") return;
    const needsCard = !!view.viewer && view.viewer.status === "joined";
    if (!needsCard || setupSecret || fetchingSecret.current) return;

    const fromHandoff = consumeSetupSecret(code);
    if (fromHandoff) { setSetupSecret(fromHandoff); return; }

    const mt = tokens.memberToken;
    if (!mt) return;
    fetchingSecret.current = true;
    fetch(`/api/public/league/split/${code}/setup-intent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: mt }),
    })
      .then((r) => r.json())
      .then((b) => { if (b.setupClientSecret) setSetupSecret(b.setupClientSecret); })
      .catch(() => { /* surfaced by the card panel staying in its loader */ })
      .finally(() => { fetchingSecret.current = false; });
  }, [view, setupSecret, code, tokens.memberToken]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = shareUrl; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleShare = async () => {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      try {
        await (navigator as any).share({
          title: `Pay your share — ${view?.teamName || "our team"}`,
          text: `Chip in for ${view?.teamName || "our MFL team"} — save your card and your share is charged when we lock the squad.`,
          url: shareUrl,
        });
        return;
      } catch { /* user cancelled — fall through to copy */ }
    }
    copyLink();
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!joinName.trim() || !joinEmail.trim()) { setJoinError("Please add your name and email."); return; }
    setJoining(true); setJoinError(null);
    try {
      const res = await fetch(`/api/public/league/split/${code}/join`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: joinName.trim(), email: joinEmail.trim(), phone: joinPhone.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Couldn't join this split.");
      saveSplitTokens(code, { memberToken: body.memberToken });
      setTokens((p) => ({ ...p, memberToken: body.memberToken }));
      if (body.setupClientSecret) setSetupSecret(body.setupClientSecret);
      refetch();
    } catch (err: any) {
      setJoinError(err.message || "Something went wrong. Please try again.");
      setJoining(false);
    }
  };

  const handleLock = async () => {
    if (!tokens.organiserToken) return;
    setLocking(true); setLockError(null);
    try {
      const res = await fetch(`/api/public/league/split/${code}/lock`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organiserToken: tokens.organiserToken }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.message === "members_without_card") {
          setLockError(`Some cards aren't saved yet (${body.missingCards ?? "a few"}). Give them a nudge.`);
        } else {
          setLockError(body.message || "Couldn't lock the split. Please try again.");
        }
        setLocking(false);
        return;
      }
      await refetch();
    } catch {
      setLockError("Couldn't lock the split. Please try again.");
    } finally {
      setLocking(false);
    }
  };

  const handleRetry = async () => {
    if (!tokens.memberToken) return;
    setRetryLoading(true);
    try {
      const res = await fetch(`/api/public/league/split/${code}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: tokens.memberToken }),
      });
      const body = await res.json();
      if (res.ok && body.clientSecret) setRetrySecret(body.clientSecret);
    } catch { /* noop */ } finally { setRetryLoading(false); }
  };

  const handleLeave = async () => {
    if (!tokens.memberToken) return;
    try {
      await fetch(`/api/public/league/split/${code}/leave`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberToken: tokens.memberToken }),
      });
    } catch { /* noop */ }
    saveSplitTokens(code, { memberToken: undefined });
    setTokens((p) => ({ ...p, memberToken: undefined }));
    setSetupSecret(null);
    refetch();
  };

  const handleRemove = async (memberId: string) => {
    if (!tokens.organiserToken) return;
    try {
      await fetch(`/api/public/league/split/${code}/remove`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organiserToken: tokens.organiserToken, memberId }),
      });
    } catch { /* noop */ }
    refetch();
  };

  const handleCancel = async () => {
    if (!tokens.organiserToken) return;
    setCancelling(true);
    try {
      await fetch(`/api/public/league/split/${code}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organiserToken: tokens.organiserToken }),
      });
    } catch { /* noop */ } finally {
      setCancelling(false);
      setShowCancel(false);
      refetch();
    }
  };

  const deadlineLabel = useMemo(() => {
    if (!view?.deadlineAt) return null;
    try {
      return new Date(view.deadlineAt).toLocaleDateString("en-NZ", { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
    } catch { return null; }
  }, [view?.deadlineAt]);

  // ── Loading / error frames ─────────────────────────────────────────────────
  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.black }}><Skeleton className="h-96 w-[26rem] max-w-[90vw] rounded-3xl" style={{ background: BRAND.card }} /></div>;
  }
  if (viewError || !view) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center px-6" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
        <div>
          <p style={{ color: BRAND.muted }}>This split link isn't available.</p>
          <Link href="/league"><a className="mt-3 inline-block font-semibold" style={{ color: BRAND.gold }}>See the leagues</a></Link>
        </div>
      </div>
    );
  }

  const isOrganiser = view.isOrganiserView;
  const viewer = view.viewer;
  // Member-facing "fair share" = the fixed team fee split equally across the squad
  // (target size), so it reads a stable $X each from the start — matches PayShare.
  // The exact amount charged at lock can differ if a teammate doesn't pay; that
  // nuance is explained in the Player Pay terms (see the "How Player Pay works" modal).
  const fairShareCents = view.targetCount > 0
    ? Math.round(view.totalCents / view.targetCount)
    : (view.provisionalShareCents || 0);
  const shareCents = fairShareCents;
  // What each saved card is actually charged right now (fee ÷ cards in) — shown on
  // the captain's Lock button so the charge math stays honest at the moment of charge.
  const chargeShareCents = view.provisionalShareCents || 0;
  const lockReady = view.cardCount === view.joinedCount && view.joinedCount >= 1;
  const missingCards = Math.max(0, view.joinedCount - view.cardCount);

  // ── Terminal states ────────────────────────────────────────────────────────
  if (view.status === "settled") {
    return (
      <Shell teamName={view.teamName}>
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-6 text-center">
          <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto" style={{ background: `${BRAND.gold}1f` }}>
            <Trophy className="w-10 h-10" style={{ color: BRAND.gold }} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Team confirmed</h1>
            <p className="mt-2" style={{ color: BRAND.muted }}>{view.teamName} is paid in full — {view.paidCount} {view.paidCount === 1 ? "share" : "shares"} collected. See you on the pitch.</p>
          </div>
          {viewer && viewer.chargedCents > 0 && (
            <div className="rounded-2xl px-5 py-4 inline-flex items-center gap-2.5 text-sm font-semibold mx-auto" style={{ background: "rgba(123,220,181,0.12)", color: BRAND.green }}>
              <CheckCircle2 className="w-4 h-4" /> Your share: {formatCurrency(viewer.chargedCents, { fromCents: true })} paid
            </div>
          )}
          <Link href="/league"><a className="inline-block w-full py-3.5 rounded-full font-bold" style={{ background: BRAND.gold, color: BRAND.black }}>Back to the league</a></Link>
        </motion.div>
      </Shell>
    );
  }

  if (view.status === "cancelled") {
    return (
      <Shell teamName={view.teamName}>
        <div className="space-y-5 text-center">
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "rgba(255,255,255,0.06)" }}>
            <X className="w-8 h-8" style={{ color: BRAND.muted }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">This split was cancelled</h1>
            <p className="mt-2" style={{ color: BRAND.muted }}>No cards were charged. If this is a mistake, ask your captain to start a new split.</p>
          </div>
          <Link href="/league"><a className="inline-block font-semibold" style={{ color: BRAND.gold }}>See the leagues</a></Link>
        </div>
      </Shell>
    );
  }

  // ── Live states ─────────────────────────────────────────────────────────────
  return (
    <Shell teamName={view.teamName}>
      <AnimatePresence>{locking && <FullLoader label="Charging the squad…" />}</AnimatePresence>

      {/* Copied toast */}
      <AnimatePresence>
        {copied && (
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="fixed left-1/2 -translate-x-1/2 bottom-7 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-semibold shadow-xl"
            style={{ background: BRAND.gold, color: BRAND.black }}
          >
            <Check className="w-4 h-4" /> Link copied
          </motion.div>
        )}
      </AnimatePresence>

      {view.status === "settling" && (
        <div className="rounded-2xl px-4 py-3 mb-5 flex items-center gap-2.5 text-sm" style={{ background: `${BRAND.gold}14`, color: BRAND.gold }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Locking in — charging everyone's saved card now.
        </div>
      )}

      {view.status === "failed" && (
        <div className="rounded-2xl px-4 py-3 mb-5 flex items-center gap-2.5 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: BRAND.red, border: "1px solid rgba(220,38,38,0.3)" }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> A few cards didn't go through. Anyone affected can retry below.
        </div>
      )}

      {/* Team header card */}
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        className="rounded-3xl p-6 mb-5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-bold mb-2.5" style={{ color: BRAND.gold }}>
          <Sparkles className="w-3.5 h-3.5" /> Player Pay
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{view.teamName}</h1>
        <p className="mt-1.5 text-[15px]" style={{ color: BRAND.muted }}>
          {formatCurrency(view.totalCents, { fromCents: true })} team fee, split equally across the squad.
        </p>
        <div className="mt-5 flex items-end gap-2">
          <span className="text-4xl font-bold tracking-tight" style={{ color: BRAND.gold }}>{formatCurrency(shareCents, { fromCents: true })}</span>
          <span className="text-sm mb-1.5" style={{ color: BRAND.muted }}>each{view.targetCount > 0 ? ` · squad of ${view.targetCount}` : ""}</span>
        </div>
        <button onClick={() => setShowTerms(true)} className="mt-1.5 inline-flex items-center text-[12px] underline-offset-2 hover:underline" style={{ color: BRAND.dim }} data-testid="link-player-pay-terms">
          How Player Pay works
        </button>
        {deadlineLabel && (
          <p className="mt-3 inline-flex items-center gap-1.5 text-[12px]" style={{ color: BRAND.dim }}>
            <Clock3 className="w-3.5 h-3.5" /> Closes {deadlineLabel}
          </p>
        )}
      </motion.div>

      {/* Counters — match PayShare: squad target is the denominator for both */}
      <div className="flex gap-3 mb-3">
        <Counter value={view.joinedCount} total={view.targetCount || view.joinedCount} label="Joined" />
        <Counter value={view.paidCount} total={view.targetCount || view.joinedCount} label="Paid" />
      </div>

      {/* Group actions — share + status, up with the counters and visible to everyone (PayShare layout) */}
      <div className="space-y-2.5 mb-5">
        <button onClick={() => setShowGroup(true)} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[14px]" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }} data-testid="button-group-status">
          <Users className="w-4 h-4" /> View group status ({view.joinedCount})
        </button>
        <div className="grid grid-cols-3 gap-2.5">
          <button onClick={handleShare} className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl font-semibold text-[13px]" style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-share">
            <Share2 className="w-4 h-4" /> Share
          </button>
          <button onClick={copyLink} className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl font-semibold text-[13px]" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }} data-testid="button-copy">
            <Copy className="w-4 h-4" /> {copied ? "Copied!" : "Copy link"}
          </button>
          <button onClick={() => setShowQr(true)} className="flex flex-col items-center justify-center gap-1.5 py-3 rounded-xl font-semibold text-[13px]" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }} data-testid="button-qr">
            <QrCode className="w-4 h-4" /> QR code
          </button>
        </div>
      </div>

      {/* ── Viewer's own status / action ── */}
      <ViewerPanel
        view={view} viewer={viewer} code={code} tokens={tokens} setupSecret={setupSecret}
        retrySecret={retrySecret} retryLoading={retryLoading} hubUrl={hubUrl}
        joinName={joinName} setJoinName={setJoinName} joinEmail={joinEmail} setJoinEmail={setJoinEmail}
        joinPhone={joinPhone} setJoinPhone={setJoinPhone} joining={joining} joinError={joinError}
        onJoin={handleJoin} onRetry={handleRetry} onLeave={handleLeave}
        onCardSaved={() => { refetch(); }}
        onRetried={() => { refetch(); }}
        shareCents={shareCents}
      />

      {/* ── Organiser hub ── */}
      {isOrganiser && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}
          className="mt-5 rounded-3xl p-6 space-y-4" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] font-bold" style={{ color: BRAND.gold }}>
            <Crown className="w-3.5 h-3.5" /> Captain controls
          </div>

          {lockError && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: BRAND.red, border: "1px solid rgba(220,38,38,0.3)" }}>{lockError}</div>}

          {/* Lock & charge */}
          {view.status === "open" && (
            <button onClick={handleLock} disabled={!lockReady || locking}
              className="w-full flex flex-col items-center justify-center gap-0.5 py-4 rounded-full font-bold text-[16px] disabled:opacity-50"
              style={{ background: lockReady ? BRAND.gold : BRAND.cardSoft, color: lockReady ? BRAND.black : BRAND.muted, border: lockReady ? "none" : `1px solid ${BRAND.border}` }}
              data-testid="button-lock">
              {lockReady ? (
                <>
                  <span className="flex items-center gap-2"><Lock className="w-4 h-4" /> Lock &amp; charge everyone</span>
                  <span className="text-[12px] font-semibold" style={{ color: "rgba(0,0,0,0.6)" }}>Locking now: {view.cardCount} × {formatCurrency(chargeShareCents, { fromCents: true })}</span>
                </>
              ) : (
                <span className="text-[14px] font-semibold">
                  {view.joinedCount === 0 ? "Share the link to get started" : `Waiting on ${missingCards} to add a card`}
                </span>
              )}
            </button>
          )}

          <button onClick={() => setShowCancel(true)} className="w-full text-center text-[12px] pt-1" style={{ color: BRAND.dim }} data-testid="button-cancel-split">
            Cancel this split
          </button>
        </motion.div>
      )}

      {/* QR modal */}
      <Modal open={showQr} onClose={() => setShowQr(false)}>
        <div className="text-center">
          <h3 className="text-lg font-bold tracking-tight">Scan to join</h3>
          <p className="text-sm mt-1" style={{ color: BRAND.muted }}>{view.teamName}</p>
          <div className="mt-5 rounded-2xl p-5 inline-block bg-white">
            <QRCodeSVG value={shareUrl} size={232} level="M" marginSize={0} fgColor="#000000" bgColor="#ffffff" />
          </div>
          <button onClick={copyLink} className="mt-5 w-full flex items-center justify-center gap-2 py-3 rounded-full font-semibold text-sm" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }}>
            <Copy className="w-4 h-4" /> Copy link instead
          </button>
        </div>
      </Modal>

      {/* Group status modal */}
      <Modal open={showGroup} onClose={() => setShowGroup(false)}>
        <h3 className="text-lg font-bold tracking-tight">Group status</h3>
        <p className="text-sm mt-1 mb-4" style={{ color: BRAND.muted }}>{view.joinedCount} of {view.targetCount || view.joinedCount} joined · {view.paidCount} paid</p>
        <div className="space-y-2 max-h-[55vh] overflow-y-auto -mx-1 px-1">
          {view.members.filter((m) => m.status !== "removed").map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-3" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}` }}>
              <div className="min-w-0">
                <div className="font-semibold text-[14px] truncate">{m.name}{m.isYou ? " (You)" : ""}</div>
                <div className="text-[12px] truncate" style={{ color: BRAND.dim }}>{m.emailMasked}{m.status === "paid" && m.chargedCents > 0 ? ` · ${formatCurrency(m.chargedCents, { fromCents: true })}` : ""}</div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <StatusPill status={m.status} role={m.role} />
                {isOrganiser && !m.isYou && view.status === "open" && m.role !== "organiser" && (
                  <button onClick={() => handleRemove(m.id)} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: "rgba(255,255,255,0.05)", color: BRAND.dim }} title="Remove" data-testid={`button-remove-${m.id}`}>
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      {/* Cancel confirm modal */}
      <Modal open={showCancel} onClose={() => setShowCancel(false)}>
        <h3 className="text-lg font-bold tracking-tight">Cancel this split?</h3>
        <p className="text-sm mt-2" style={{ color: BRAND.muted }}>
          {view.paidCount > 0
            ? "Anyone already charged will be refunded in full. Saved cards won't be charged. This can't be undone."
            : "No cards will be charged. This can't be undone."}
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button onClick={() => setShowCancel(false)} className="py-3 rounded-full font-semibold text-sm" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }}>
            Keep it open
          </button>
          <button onClick={handleCancel} disabled={cancelling} className="py-3 rounded-full font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: "rgba(220,38,38,0.16)", border: "1px solid rgba(220,38,38,0.4)", color: BRAND.red }} data-testid="button-confirm-cancel">
            {cancelling ? <Loader2 className="w-4 h-4 animate-spin" /> : "Cancel split"}
          </button>
        </div>
      </Modal>

      {/* Player Pay terms / how-it-works modal */}
      <Modal open={showTerms} onClose={() => setShowTerms(false)}>
        <h3 className="text-lg font-bold tracking-tight">How Player Pay works</h3>
        <div className="mt-3 space-y-3 text-sm" style={{ color: BRAND.muted }}>
          <p>The team fee is a fixed <strong style={{ color: BRAND.white }}>{formatCurrency(view.totalCents, { fromCents: true })}</strong>. It's split equally across your squad — about <strong style={{ color: BRAND.white }}>{formatCurrency(shareCents, { fromCents: true })}</strong> per player{view.targetCount > 0 ? ` for a squad of ${view.targetCount}` : ""}.</p>
          <p>Saving your card doesn't charge you. Your share is charged <strong style={{ color: BRAND.white }}>once</strong> — when the captain locks the squad.</p>
          <p>If a teammate doesn't add a card, the team fee is shared between the players who do, so your share can be a little higher than the estimate. The club always collects the full team fee.</p>
          <p>If the captain cancels the split, anyone already charged is refunded in full.</p>
          <p>Payments are processed securely by Stripe — we never see or store your card details.</p>
        </div>
        <button onClick={() => setShowTerms(false)} className="mt-5 w-full py-3 rounded-full font-semibold text-sm" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }}>
          Got it
        </button>
      </Modal>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Viewer panel — adapts to joiner / needs-card / saved / paid / failed
// ─────────────────────────────────────────────────────────────────────────────
function ViewerPanel(props: {
  view: SplitView; viewer: SplitViewer | null; code: string; tokens: SplitTokens;
  setupSecret: string | null; retrySecret: string | null; retryLoading: boolean; hubUrl: string;
  joinName: string; setJoinName: (s: string) => void; joinEmail: string; setJoinEmail: (s: string) => void;
  joinPhone: string; setJoinPhone: (s: string) => void; joining: boolean; joinError: string | null;
  onJoin: (e: React.FormEvent) => void; onRetry: () => void; onLeave: () => void;
  onCardSaved: () => void; onRetried: () => void; shareCents: number;
}) {
  const {
    view, viewer, code, tokens, setupSecret, retrySecret, retryLoading, hubUrl,
    joinName, setJoinName, joinEmail, setJoinEmail, joinPhone, setJoinPhone, joining, joinError,
    onJoin, onRetry, onLeave, onCardSaved, onRetried, shareCents,
  } = props;

  const cardWrap = "rounded-3xl p-6" as const;
  const cardStyle: React.CSSProperties = { background: BRAND.card, border: `1px solid ${BRAND.border}` };

  // No membership yet → joiner sign-up (only while open)
  if (!tokens.memberToken && view.status === "open") {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={cardWrap} style={cardStyle}>
        <h2 className="text-lg font-bold tracking-tight">Join this split</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: BRAND.muted }}>Add your details, then save a card. You won't be charged until your captain locks the team.</p>
        <form onSubmit={onJoin} className="space-y-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5">Your name</label>
            <input className={inputCls} style={inputStyle} value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="Full name" data-testid="input-join-name" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5">Email</label>
            <input type="email" className={inputCls} style={inputStyle} value={joinEmail} onChange={(e) => setJoinEmail(e.target.value)} placeholder="you@email.com" data-testid="input-join-email" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5">Mobile <span style={{ color: BRAND.dim }}>(optional)</span></label>
            <input className={inputCls} style={inputStyle} value={joinPhone} onChange={(e) => setJoinPhone(e.target.value)} placeholder="021…" data-testid="input-join-phone" />
          </div>
          {joinError && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: BRAND.red, border: "1px solid rgba(220,38,38,0.3)" }}>{joinError}</div>}
          <button type="submit" disabled={joining}
            className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
            style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-join">
            {joining ? <><Loader2 className="w-4 h-4 animate-spin" /> Joining…</> : <>Join &amp; add my card</>}
          </button>
          <p className="text-center text-[12px]" style={{ color: BRAND.dim }}>Your share: {formatCurrency(shareCents, { fromCents: true })} — an equal split of the team fee</p>
        </form>
      </motion.div>
    );
  }

  // From here the visitor IS a member (organiser or a joined member).
  // Card form shows when the server says "joined", or transiently right after
  // joining (viewer not refetched yet) when we already hold a setup secret.
  const needsCard = view.status === "open" && (viewer?.status === "joined" || (!viewer && !!setupSecret));
  if (needsCard) {
    const isOrganiserViewer = viewer?.role === "organiser";
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={cardWrap} style={cardStyle}>
        <h2 className="text-lg font-bold tracking-tight">{isOrganiserViewer ? "Add your card" : "Save your card to lock in your share"}</h2>
        <p className="text-sm mt-1 mb-4" style={{ color: BRAND.muted }}>
          No charge now. Your share of {formatCurrency(shareCents, { fromCents: true })} is charged once — when the captain locks the squad.
        </p>
        {!stripePromise ? (
          <div className="rounded-2xl p-5 flex items-start gap-3 text-sm" style={{ background: BRAND.cardSoft, border: "1px solid rgba(220,38,38,0.3)", color: BRAND.red }}>
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div><p className="font-semibold" style={{ color: BRAND.white }}>Card setup is temporarily unavailable</p><p className="mt-1" style={{ color: BRAND.muted }}>Please refresh and try again, or email minifootball@cufc.co.nz.</p></div>
          </div>
        ) : !setupSecret ? (
          <div className="rounded-2xl p-5 flex items-center justify-center gap-2 text-sm" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.muted }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Opening secure card form…
          </div>
        ) : (
          <Elements stripe={stripePromise} options={{ clientSecret: setupSecret, appearance: APPEARANCE }}>
            <SetupForm code={code} memberToken={tokens.memberToken!} email={viewer?.email} returnUrl={hubUrl} onSaved={onCardSaved} />
          </Elements>
        )}
      </motion.div>
    );
  }

  // Still loading the viewer record (member token present, view not back yet).
  if (!viewer) return null;

  // Card saved → waiting to be charged
  if (view.status !== "settled" && viewer.status === "card_saved") {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={cardWrap} style={cardStyle}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${BRAND.gold}1f` }}>
            <CreditCard className="w-5 h-5" style={{ color: BRAND.gold }} />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">You're in{viewer.role === "organiser" ? " — your card's saved" : ""}</h2>
            <p className="text-sm mt-1" style={{ color: BRAND.muted }}>
              Your share is <strong style={{ color: BRAND.gold }}>{formatCurrency(shareCents, { fromCents: true })}</strong> — charged once, when {viewer.role === "organiser" ? "you" : "the captain"} lock{viewer.role === "organiser" ? "" : "s"} the squad.
            </p>
          </div>
        </div>
        {viewer.role !== "organiser" && view.status === "open" && (
          <button onClick={onLeave} className="mt-4 inline-flex items-center gap-1.5 text-[12px]" style={{ color: BRAND.dim }} data-testid="button-leave">
            <LogOut className="w-3.5 h-3.5" /> Leave this split
          </button>
        )}
      </motion.div>
    );
  }

  // Paid
  if (viewer.status === "paid") {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={cardWrap} style={{ background: "rgba(123,220,181,0.08)", border: "1px solid rgba(123,220,181,0.25)" }}>
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "rgba(123,220,181,0.16)" }}>
            <CheckCircle2 className="w-6 h-6" style={{ color: BRAND.green }} />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">Your share is paid</h2>
            <p className="text-sm mt-0.5" style={{ color: BRAND.muted }}>{formatCurrency(viewer.chargedCents || shareCents, { fromCents: true })} — you're all set.</p>
          </div>
        </div>
      </motion.div>
    );
  }

  // Failed → retry
  if (viewer.status === "failed") {
    return (
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className={cardWrap} style={{ background: BRAND.card, border: "1px solid rgba(220,38,38,0.3)" }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "rgba(220,38,38,0.14)" }}>
            <AlertCircle className="w-5 h-5" style={{ color: BRAND.red }} />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight">Your payment didn't go through</h2>
            <p className="text-sm mt-0.5" style={{ color: BRAND.muted }}>Your card was declined for {formatCurrency(viewer.chargedCents || shareCents, { fromCents: true })}. Try another card to settle your share.</p>
          </div>
        </div>
        <div className="mt-4">
          {!retrySecret ? (
            <button onClick={onRetry} disabled={retryLoading}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
              style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-start-retry">
              {retryLoading ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening secure checkout…</> : <>Retry payment</>}
            </button>
          ) : stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret: retrySecret, appearance: APPEARANCE }}>
              <RetryForm code={code} returnUrl={hubUrl} onPaid={onRetried} />
            </Elements>
          ) : null}
        </div>
      </motion.div>
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page chrome
// ─────────────────────────────────────────────────────────────────────────────
function Shell({ teamName, children }: { teamName?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
      <header className="border-b sticky top-0 z-20" style={{ borderColor: BRAND.border, background: "rgba(0,0,0,0.9)", backdropFilter: "blur(12px)" }}>
        <div className="max-w-md mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/league"><a className="flex items-center gap-2 text-sm" style={{ color: BRAND.muted }}><ArrowLeft className="w-4 h-4" /> Leagues</a></Link>
          <span className="text-sm flex items-center gap-1.5" style={{ color: BRAND.dim }}><Lock className="w-3.5 h-3.5" /> Secure</span>
        </div>
      </header>
      <main className="max-w-md mx-auto px-5 py-8">{children}</main>
    </div>
  );
}

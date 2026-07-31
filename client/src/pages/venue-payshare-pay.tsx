import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Lock, Loader2, AlertCircle, CheckCircle2, ShieldCheck, Clock3, ArrowRight } from "lucide-react";

// United Sports Centre — one participant paying their share of a PayShare group.
//
// PayShare owns the group: the invite link, who has joined, who still owes, and
// when the group is finished. This page owns exactly one thing — taking one
// person's card for the share PayShare told us they owe — and then hands them
// straight back. That is why there is no roster, no share link and no counters
// here; duplicating PayShare's own hub would just be a second, staler copy of it.
//
// Card fields are embedded (Stripe Elements) rather than a hosted redirect, per
// the club's standing checkout rule.
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

interface ShareView {
  amountCents: number;
  currency: string;
  status: "pending" | "authorized" | "captured" | "failed";
  role: "host" | "participant";
  sessionStatus: "open" | "completed" | "expired" | "cancelled";
  expiresAt: string | null;
  returnUrl: string | null;
  totalCents: number;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full" style={{ background: T.black, color: T.white, fontFamily: FONT }}>
      <div className="mx-auto w-full max-w-[520px] px-5 py-8 sm:py-12">{children}</div>
    </div>
  );
}

function PayForm({
  token, amountCents, returnUrl, onPaid,
}: { token: string; amountCents: number; returnUrl: string; onPaid: (next: string | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    if (stripeError) {
      setError(stripeError.message || "That payment didn't go through. Please try again.");
      setProcessing(false);
      return;
    }
    if (paymentIntent && paymentIntent.status === "succeeded") {
      // Tell PayShare the share is in. If this call fails the money is still
      // taken and PayShare will reconcile — so never show the payer an error
      // that implies otherwise.
      let next: string | null = null;
      try {
        const r = await fetch(`/api/payshare/pay/${token}/confirm`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        next = d?.returnUrl ?? null;
      } catch {
        /* PayShare reconciles from its own side; the payer is done either way. */
      }
      onPaid(next);
      return;
    }
    setError("That payment couldn't be processed. Please try another card.");
    setProcessing(false);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-2xl p-5" style={{ background: T.card, border: `1px solid ${T.border}`, minHeight: 90 }}>
        {!ready && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: T.muted }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading secure payment…
          </div>
        )}
        <div style={{ display: ready ? "block" : "none" }}>
          <PaymentElement options={{ layout: "tabs" }} onReady={() => setReady(true)} />
        </div>
      </div>

      {error && (
        <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(248,113,113,0.12)", color: T.red, border: "1px solid rgba(248,113,113,0.3)" }}>
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={!stripe || !ready || processing}
        className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
        style={{ background: T.accent, color: "#fff" }}
        data-testid="payshare-button-pay"
      >
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</> : <><Lock className="w-4 h-4" /> Pay {money(amountCents)}</>}
      </button>

      <div className="flex items-center justify-center gap-5 text-[12px]" style={{ color: T.dim }}>
        <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> Your share only</span>
        <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Stripe secure</span>
      </div>
    </form>
  );
}

export default function VenuePaySharePage() {
  const [, params] = useRoute("/book/payshare/pay/:token");
  const token = params?.token || "";

  const [paySecret, setPaySecret] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const fetching = useRef(false);

  const { data: view, isLoading, error } = useQuery<ShareView>({
    queryKey: ["payshare-share", token],
    queryFn: async () => {
      const r = await fetch(`/api/payshare/pay/${token}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || "This payment link isn't valid.");
      return r.json();
    },
    enabled: !!token,
  });

  const alreadyPaid = paid || view?.status === "captured";
  const sessionDead = view?.sessionStatus === "expired" || view?.sessionStatus === "cancelled";

  // Fetch the PaymentIntent once the share is loaded and actually payable.
  useEffect(() => {
    if (!view || alreadyPaid || sessionDead || paySecret || fetching.current) return;
    fetching.current = true;
    (async () => {
      try {
        const r = await fetch(`/api/payshare/pay/${token}/intent`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.message || "Couldn't start the payment.");
        setPaySecret(d.clientSecret);
      } catch (e: any) {
        setIntentError(e.message || "Couldn't start the payment.");
      } finally {
        fetching.current = false;
      }
    })();
  }, [view, alreadyPaid, sessionDead, paySecret, token]);

  // Send them back to their group once they've paid. The button below is the
  // real control — an automatic hop that silently fails would strand them.
  useEffect(() => {
    if (!alreadyPaid) return;
    const url = returnTo || view?.returnUrl || null;
    if (!url) return;
    // Long enough to actually read "that's your part done" before the hop.
    const t = setTimeout(() => { window.location.href = url; }, 3500);
    return () => clearTimeout(t);
  }, [alreadyPaid, returnTo, view?.returnUrl]);

  if (!token) return null;

  if (isLoading) {
    return (
      <Shell>
        <div className="flex items-center justify-center gap-2 py-24 text-sm" style={{ color: T.muted }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your share…
        </div>
      </Shell>
    );
  }

  if (error || !view) {
    return (
      <Shell>
        <div className="rounded-2xl p-6 text-center" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          <AlertCircle className="w-7 h-7 mx-auto mb-3" style={{ color: T.red }} />
          <div className="font-bold text-[17px] mb-1.5">This payment link isn't valid</div>
          <p className="text-sm leading-relaxed" style={{ color: T.muted }}>
            It may have already been used, or the booking may have been cancelled. Ask whoever organised the
            booking for a fresh link, or email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline" style={{ color: T.accent }}>{SUPPORT_EMAIL}</a>.
          </p>
        </div>
      </Shell>
    );
  }

  const backUrl = returnTo || view.returnUrl;

  return (
    <Shell>
      {/* Single column, so the header block is centred as a block. */}
      <div className="text-center mb-7">
        <div
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider mb-4"
          style={{ background: T.accentSoft, color: T.accent }}
        >
          United Sports Centre
        </div>
        <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight leading-tight">
          {alreadyPaid ? "Your share is paid" : sessionDead ? "This booking has closed" : "Pay your share"}
        </h1>
        {!alreadyPaid && !sessionDead && (
          <p className="text-sm mt-2 leading-relaxed" style={{ color: T.muted }}>
            You're paying your part of a group booking. Everyone pays their own share.
          </p>
        )}
      </div>

      {/* The amount. The one number that matters — so when there is nothing left
          to pay it is dimmed and labelled in the past tense, rather than sitting
          there in white above a message saying the booking is closed. */}
      <div className="rounded-2xl p-6 mb-5 text-center" style={{ background: T.card, border: `1px solid ${T.border}` }}>
        <div className="text-[12px] uppercase tracking-wider mb-1.5" style={{ color: T.dim }}>
          {sessionDead ? "Your share was" : "Your share"}
        </div>
        <div
          className="text-[40px] font-bold tracking-tight leading-none"
          style={{ color: alreadyPaid ? T.green : sessionDead ? T.dim : T.white }}
        >
          {money(view.amountCents)}
        </div>
        <div className="text-[12px] mt-2.5" style={{ color: T.dim }}>
          {view.currency} · booking total {money(view.totalCents)}
        </div>
      </div>

      {alreadyPaid ? (
        <div className="space-y-4">
          <div
            className="rounded-2xl p-5 flex items-start gap-3"
            style={{ background: "rgba(52,211,153,0.10)", border: "1px solid rgba(52,211,153,0.28)" }}
          >
            <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0" style={{ color: T.green }} />
            <div className="min-w-0">
              <div className="font-semibold text-[15px] mb-1">That's your part done</div>
              <p className="text-sm leading-relaxed" style={{ color: T.muted }}>
                The booking is confirmed once everyone in your group has paid. You'll be taken back to your
                group to see how it's tracking.
              </p>
            </div>
          </div>
          {backUrl && (
            <a
              href={backUrl}
              className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px]"
              style={{ background: T.accent, color: "#fff" }}
              data-testid="payshare-button-back"
            >
              Back to your group <ArrowRight className="w-4 h-4" />
            </a>
          )}
        </div>
      ) : sessionDead ? (
        <div className="rounded-2xl p-6 text-center" style={{ background: T.card, border: `1px solid ${T.border}` }}>
          {/* No heading — the h1 above already says it, and saying it twice
              reads like a bug. */}
          <Clock3 className="w-7 h-7 mx-auto mb-3" style={{ color: T.muted }} />
          <p className="text-sm leading-relaxed" style={{ color: T.muted }}>
            The group didn't finish in time, so the hold on the slot has been released and there's nothing to
            pay here. If you think that's wrong, email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline" style={{ color: T.accent }}>{SUPPORT_EMAIL}</a>.
          </p>
        </div>
      ) : intentError ? (
        <div className="rounded-2xl p-5 text-sm" style={{ background: "rgba(248,113,113,0.12)", color: T.red, border: "1px solid rgba(248,113,113,0.3)" }}>
          {intentError}
        </div>
      ) : !stripePromise ? (
        <div className="rounded-2xl p-5 text-sm" style={{ background: T.card, border: `1px solid ${T.border}`, color: T.muted }}>
          Card payments aren't available right now. Please email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline" style={{ color: T.accent }}>{SUPPORT_EMAIL}</a>.
        </div>
      ) : !paySecret ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm" style={{ color: T.muted }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Preparing your payment…
        </div>
      ) : (
        <Elements stripe={stripePromise} options={{ clientSecret: paySecret, appearance: APPEARANCE }}>
          <PayForm
            token={token}
            amountCents={view.amountCents}
            returnUrl={typeof window !== "undefined" ? window.location.href : ""}
            onPaid={(next) => { setPaid(true); setReturnTo(next); }}
          />
        </Elements>
      )}

      <p className="text-[12px] text-center mt-7 leading-relaxed" style={{ color: T.dim }}>
        Questions about the booking? Email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="underline" style={{ color: T.dim }}>{SUPPORT_EMAIL}</a>
      </p>
    </Shell>
  );
}

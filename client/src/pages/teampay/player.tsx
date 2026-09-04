/**
 * Team Pay — one player's page. Pay your share, or say you can't play.
 *
 * Opened from a link in an email, on a phone, once. It has to work first time
 * with no login and no explaining.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { CheckCircle2, Loader2, Lock } from "lucide-react";
import { brandFor, type TeampayBrand } from "@shared/teampay";
import {
  Button, Card, Loading, NotFoundPage, Notice, Progress, TeampayShell, money,
} from "./shell";

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

export default function TeampayPlayerPage() {
  const [, params] = useRoute("/pay/:token");
  const token = params?.token || "";
  const opened = useRef(false);

  const { data, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["teampay-player", token],
    queryFn: () => api(`/api/public/teampay/pay/${token}`),
    enabled: !!token,
    retry: false,
  });

  /**
   * 🔴 "Opened" is reported from HERE, after the page has mounted and run — not
   * from the request that served it.
   *
   * Mail scanners, corporate link-checkers and Apple's Mail Privacy Protection
   * all fetch URLs out of emails before a human ever sees them. If the server
   * stamped this on the GET, a manager would be told their player had opened
   * the link when a robot had, and they would stop chasing the one person who
   * needs chasing. Scanners do not execute JavaScript; this line only runs in a
   * real browser.
   */
  useEffect(() => {
    if (!token || opened.current || !data) return;
    opened.current = true;
    fetch(`/api/public/teampay/pay/${token}/opened`, { method: "POST" }).catch(() => {});
  }, [token, data]);

  const brand = useMemo(() => brandFor(data?.competition?.brand), [data?.competition?.brand]);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !data) return <NotFoundPage />;

  const { competition, team, you, squad } = data;

  /**
   * Nothing to pay, for either of the two reasons that can be true:
   * the manager is covering the fee, or the team is already settled.
   * A player who has ALREADY paid is a different case, handled below —
   * they get their receipt, not "nothing to pay".
   */
  const managerPaying = you.status !== "paid" && (you.chargeCents ?? you.shareCents) <= 0;

  return (
    <TeampayShell brand={brand} eyebrow={competition.name} title={team.name}>
      <Card brand={brand} className="mb-5 p-5 sm:p-6">
        <p className="text-[15px] leading-relaxed">
          Hi {you.name.split(" ")[0]} — you're in <strong>{team.name}</strong>
          {team.community ? ` (${team.community})` : ""}.{" "}
          {managerPaying
            ? `${team.managerName} is paying the team fee.`
            : `The team fee is split ${team.squadSize} ways.`}
        </p>

        {/* 🔴 Never show an amount when nothing is owed. A "$50" next to "your
            manager is paying" is the sentence a player acts on, and they pay
            twice for one seat. */}
        {!managerPaying && (
          <div className="mt-5 flex items-baseline justify-between">
            <span className="text-[13px]" style={{ color: brand.mute }}>Your share</span>
            <span className="text-[34px] font-bold leading-none"
                  style={{ fontFamily: brand.fontHeading, color: brand.accent }}>
              {money(you.chargeCents ?? you.shareCents)}
            </span>
          </div>
        )}

        {!managerPaying && (
          <div className="mt-5">
            <Progress brand={brand} percent={squad.percentPaid} />
            <div className="mt-2 text-[12px]" style={{ color: brand.mute }}>
              {squad.paidCount} of {squad.squadSize} teammates have paid
            </div>
          </div>
        )}
      </Card>

      {you.status === "paid" ? (
        <Card brand={brand} className="p-6 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3" style={{ color: "#34C759" }} />
          <div className="text-[19px] font-semibold">You're paid up</div>
          <p className="mt-2 text-[14px]" style={{ color: brand.mute }}>
            {money(you.paidCents)} received. Nothing else to do — your manager can see it.
          </p>
        </Card>
      ) : you.status === "declined" ? (
        <Card brand={brand} className="p-6 text-center">
          <div className="text-[17px] font-semibold">You've said you can't play</div>
          <p className="mt-2 text-[14px]" style={{ color: brand.mute }}>
            Your manager has been told. Changed your mind? Give them a shout.
          </p>
        </Card>
      ) : you.status === "removed" ? (
        <Card brand={brand} className="p-6 text-center">
          <div className="text-[17px] font-semibold">You're not on this squad</div>
          <p className="mt-2 text-[14px]" style={{ color: brand.mute }}>
            Your manager has taken you off the team sheet. Talk to them if that's a mistake.
          </p>
        </Card>
      ) : managerPaying ? (
        <Card brand={brand} className="p-6 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-3" style={{ color: "#34C759" }} />
          <div className="text-[19px] font-semibold">Nothing to pay</div>
          <p className="mt-2 text-[14px]" style={{ color: brand.mute }}>
            {team.paymentMode === "whole"
              ? `${team.managerName} is covering the whole team fee, so there's nothing for you to pay. You're on the squad — see you there.`
              : `Your team's fee is fully paid, so there's nothing left for you to pay. You're on the squad — see you there.`}
          </p>
          <div className="mt-5 border-t pt-4" style={{ borderColor: brand.line }}>
            <DeclineButton brand={brand} token={token} onDone={refetch} />
          </div>
        </Card>
      ) : !competition.paymentsEnabled ? (
        <>
          <Notice brand={brand} tone="warn">
            <strong>Payment isn't open yet.</strong> You're on the squad and your spot is held.
            We'll email you the moment it opens — nothing to do right now.
          </Notice>
          <div className="mt-4">
            <DeclineButton brand={brand} token={token} onDone={refetch} />
          </div>
        </>
      ) : !stripePromise ? (
        <Notice brand={brand} tone="error">
          Card payments aren't available on this page right now. Please tell your team manager.
        </Notice>
      ) : (
        // 🔴 chargeCents, not shareCents. They differ for the last player to pay
        // into a nearly-settled balance, and the button must say the number the
        // card is actually charged.
        <PayBlock brand={brand} token={token} amountCents={you.chargeCents ?? you.shareCents} onPaid={refetch} />
      )}
    </TeampayShell>
  );
}

// ── payment ───────────────────────────────────────────────────────────────────

function PayBlock({
  brand, token, amountCents, onPaid,
}: { brand: TeampayBrand; token: string; amountCents: number; onPaid: () => void }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api(`/api/public/teampay/pay/${token}/intent`, { method: "POST" })
      .then((r) => { if (live) setSecret(r.clientSecret); })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [token]);

  if (error) return <Notice brand={brand} tone="error">{error}</Notice>;
  if (!secret) {
    return (
      <Card brand={brand} className="p-6 text-center text-[14px]" style={{ color: brand.mute }}>
        <Loader2 size={18} className="mx-auto mb-2 animate-spin" />
        Getting the payment ready…
      </Card>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: secret,
        // Pinned dark, so the card fields are readable on a black page. Left to
        // Stripe's default the inputs render near-invisible here.
        appearance: {
          theme: "night",
          variables: {
            colorPrimary: brand.accent,
            colorBackground: brand.bg,
            colorText: brand.ink,
            colorTextPlaceholder: brand.mute,
            colorDanger: "#FF6961",
            fontFamily: "Inter, system-ui, sans-serif",
            borderRadius: "10px",
          },
        },
      }}
    >
      <PayForm brand={brand} token={token} amountCents={amountCents} onPaid={onPaid} />
    </Elements>
  );
}

function PayForm({
  brand, token, amountCents, onPaid,
}: { brand: TeampayBrand; token: string; amountCents: number; onPaid: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true);
    setError(null);

    const { error: err } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: { return_url: window.location.href },
    });

    if (err) {
      setError(err.message || "That card was declined. Try another one.");
      setBusy(false);
      return;
    }

    // 🔴 Ask OUR server, which asks Stripe. The browser saying "it worked" is
    // not evidence that money moved, and this is the only thing that flips the
    // manager's dashboard to Paid.
    try {
      const r = await api(`/api/public/teampay/pay/${token}/confirm`, { method: "POST" });
      if (r.paid) onPaid();
      else setError("Your bank is still processing that. Give it a moment and refresh.");
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <Card brand={brand} className="p-5 sm:p-6">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <div className="mt-4"><Notice brand={brand} tone="error">{error}</Notice></div>}
      <div className="mt-5">
        <Button brand={brand} onClick={submit} disabled={!stripe || busy} className="w-full">
          {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : <Lock size={15} className="mr-2" />}
          Pay {money(amountCents)}
        </Button>
      </div>
      <p className="mt-3 text-center text-[12px]" style={{ color: brand.mute }}>
        Card details go straight to Stripe. We never see or store them.
      </p>
      <div className="mt-4 border-t pt-4 text-center" style={{ borderColor: brand.line }}>
        <DeclineButton brand={brand} token={token} onDone={onPaid} />
      </div>
    </Card>
  );
}

function DeclineButton({
  brand, token, onDone,
}: { brand: TeampayBrand; token: string; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!confirming) {
    return (
      <button
        className="text-[13px] underline underline-offset-2"
        style={{ color: brand.mute, minHeight: 44 }}
        onClick={() => setConfirming(true)}
      >
        I can't play
      </button>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px]" style={{ color: brand.mute }}>
        This tells your manager you're out and frees your spot for someone else. Sure?
      </p>
      <div className="flex justify-center gap-2">
        <Button
          brand={brand} variant="ghost" disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await api(`/api/public/teampay/pay/${token}/decline`, { method: "POST" }); onDone(); }
            finally { setBusy(false); }
          }}
        >
          {busy ? <Loader2 size={15} className="mr-2 animate-spin" /> : null}
          Yes, I'm out
        </Button>
        <Button brand={brand} variant="quiet" onClick={() => setConfirming(false)}>Never mind</Button>
      </div>
    </div>
  );
}

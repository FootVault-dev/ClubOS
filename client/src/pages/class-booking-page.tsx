import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { ArrowLeft, Lock, CheckCircle, Calendar, Repeat, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Skeleton } from "@/components/ui/skeleton";
import { initPixel, trackEvent } from "@/lib/meta-pixel";
import { purchaseEventId } from "@shared/meta-events";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface ProgramOption {
  id: number;
  name: string;
  description: string | null;
  scheduleText: string | null;
  fullPriceCents: number;
  pricingModel: string;
  sessionCount: number | null;
  allowPayWeekly: boolean;
  weeklyPriceCents: number | null;
  displayOrder: number;
  isActive: boolean;
}

interface OptionsResponse {
  programId: number;
  options: ProgramOption[];
}

interface QuoteResponse {
  program: { id: number; name: string; slug: string; scheduleType: string; startDate: string; endDate: string; sessionCount: number | null };
  term: { id: number; year: number; termNumber: number; name: string | null; startDate: string; endDate: string } | null;
  quote: { fullPriceCents: number; payNowCents: number; discountCents: number; sessionsRemaining: number; totalSessions: number; reason: string };
}

/** GET /api/public/parent/prefill, when a family is signed in. */
interface ParentPrefill {
  signedIn: true;
  parent: { firstName: string; lastName: string; email: string; phone: string | null };
  children: { key: string; firstName: string; lastName: string; dateOfBirth: string | null; ageGrade: number | null }[];
}

interface IntentResponse {
  registrationId: number;
  clientSecret: string;
  paymentIntentId: string | null;
  subscriptionId: string | null;
  paymentMode: "upfront" | "weekly";
  quote: { fullPriceCents: number; payNowCents: number; discountCents: number; sessionsRemaining: number; totalSessions: number; reason: string; weeklyPriceCents: number };
  option: { id: number; name: string; scheduleText: string | null } | null;
  program: { name: string; slug: string };
  term: any;
}

function PaymentForm({ slug, registrationId, totalCents, parentEmail, isWeekly, programName }: {
  slug: string; registrationId: number; totalCents: number; parentEmail: string; isWeekly: boolean;
  programName: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [, setLocation] = useLocation();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/${slug}/success?registrationId=${registrationId}`,
        receipt_email: parentEmail,
      },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message || "Payment failed. Try again.");
      setProcessing(false);
      return;
    }
    if (paymentIntent?.status === "succeeded") {
      // Browser Purchase. Deterministic id → Meta dedupes this against the
      // server-side CAPI event in handlePaymentSuccess, so one registration is
      // counted once. Neither half existed on this route until 2026-08-27,
      // which is why term-programme campaigns reported clicks and no sales.
      // On a weekly plan this is week one's charge, not the term total —
      // reporting the whole term here would overstate revenue on day one.
      trackEvent("Purchase", {
        value: totalCents / 100,
        currency: "NZD",
        content_name: programName,
        content_ids: [slug],
        num_items: 1,
      }, purchaseEventId(registrationId));

      setLocation(`/${slug}/success?registrationId=${registrationId}`);
    } else {
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>}
      <button
        type="submit"
        disabled={!stripe || processing}
        className="w-full py-3.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:bg-zinc-300 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
      >
        {processing
          ? "Processing..."
          : isWeekly
            ? <><Lock className="w-4 h-4" /> Start subscription — {money(totalCents)}/week</>
            : <><Lock className="w-4 h-4" /> Pay {money(totalCents)}</>}
      </button>
      <p className="text-[11px] text-center text-zinc-500">
        {isWeekly
          ? "Today's $X will be charged now. Future weeks charge automatically."
          : "Secured by Stripe. Your card is never stored on our servers."}
      </p>
    </form>
  );
}

export default function ClassBookingPage() {
  const [, params] = useRoute("/:slug/class-book");
  const [, setLocation] = useLocation();
  const slug = params?.slug ?? "";

  const [step, setStep] = useState<"options" | "details" | "payment">("options");
  const [selectedOption, setSelectedOption] = useState<ProgramOption | null>(null);
  const [paymentMode, setPaymentMode] = useState<"upfront" | "weekly">("upfront");

  // Fetch quote (for term info) and options
  const { data: quoteData, isLoading: quoteLoading } = useQuery<QuoteResponse>({
    queryKey: ["/api/public/program-quote", slug],
    queryFn: () => fetch(`/api/public/program-quote/${slug}`).then(r => {
      if (!r.ok) throw new Error("Program not found");
      return r.json();
    }),
    enabled: !!slug,
  });
  const { data: optionsData, isLoading: optionsLoading } = useQuery<OptionsResponse>({
    queryKey: ["/api/public/programs", slug, "options"],
    queryFn: () => fetch(`/api/public/programs/${slug}/options`).then(r => r.json()),
    enabled: !!slug,
  });

  // Meta pixel. This route had none at all, so `trackEvent` was a silent no-op
  // here (it returns early when `window.fbq` is undefined) — a term programme
  // could be advertised, clicked and paid for without Meta seeing anything past
  // the click. Must sit above the loading/early-return guards to keep hook
  // order stable across renders.
  useEffect(() => {
    const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
    if (!pixelId || !quoteData?.program) return;
    initPixel(pixelId);
    trackEvent("ViewContent", {
      content_name: quoteData.program.name,
      content_category: "Term Programme",
      content_ids: [slug],
    });
  }, [quoteData?.program?.name, slug]);

  // Form state
  const [parentFirst, setParentFirst] = useState("");
  const [parentLast, setParentLast] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [childFirst, setChildFirst] = useState("");
  const [childLast, setChildLast] = useState("");
  const [childDob, setChildDob] = useState("");
  const [notes, setNotes] = useState("");

  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Signed-in family pre-fill ──────────────────────────────────────────────
  // The point of the parent account: a returning family types nothing they have
  // already told us. The endpoint answers 200 with signedIn:false for a
  // visitor, so this call is unconditional and a failure never blocks the sale.
  // `childKey` is a CLAIM — the server re-proves the child belongs to the
  // signed-in family before reusing them, and falls back to creating one.
  const [prefill, setPrefill] = useState<ParentPrefill | null>(null);
  const [childKey, setChildKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/public/parent/prefill", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        if (!live || !d?.signedIn) return;
        setPrefill(d);
        setParentFirst((v) => v || d.parent?.firstName || "");
        setParentLast((v) => v || d.parent?.lastName || "");
        setParentEmail((v) => v || d.parent?.email || "");
        setParentPhone((v) => v || d.parent?.phone || "");
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  /** Pick a child we already hold, or clear back to typing a new one. */
  const chooseChild = (key: string | null) => {
    setChildKey(key);
    const kid = prefill?.children.find((c) => c.key === key);
    if (kid) {
      setChildFirst(kid.firstName);
      setChildLast(kid.lastName);
      setChildDob(kid.dateOfBirth || "");
    } else {
      setChildFirst(""); setChildLast(""); setChildDob("");
    }
  };

  // If only one option exists, auto-select it and skip the picker
  useEffect(() => {
    if (optionsData && optionsData.options.length === 1 && !selectedOption) {
      setSelectedOption(optionsData.options[0]);
      setStep("details");
    }
  }, [optionsData, selectedOption]);

  const formValid = parentFirst && parentLast && /\S+@\S+\.\S+/.test(parentEmail) && parentPhone &&
    childFirst && childLast;

  const proceedToPayment = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const sp = new URLSearchParams(window.location.search);
      const utm = {
        source: sp.get("utm_source"),
        medium: sp.get("utm_medium"),
        campaign: sp.get("utm_campaign"),
        content: sp.get("utm_content"),
        fbclid: sp.get("fbclid"),
        gclid: sp.get("gclid"),
      };
      const res = await fetch("/api/public/class-registrations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug: slug,
          programOptionId: selectedOption?.id,
          paymentMode,
          parent: { firstName: parentFirst, lastName: parentLast, email: parentEmail, phone: parentPhone },
          child: { firstName: childFirst, lastName: childLast, dateOfBirth: childDob || null },
          // Only sent when a signed-in parent picked a child we already hold.
          // The server proves ownership before trusting it.
          childKey,
          notes,
          utm,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Couldn't start payment");
      setIntent(data);
      setStep("payment");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (quoteLoading || optionsLoading) {
    return <div className="min-h-screen bg-white flex items-center justify-center"><Skeleton className="w-80 h-32 rounded-xl" /></div>;
  }
  if (!quoteData) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-2">Class not found</h2>
          <button onClick={() => setLocation("/")} className="text-blue-600 underline">Go home</button>
        </div>
      </div>
    );
  }

  const { program, term } = quoteData;
  const options = optionsData?.options ?? [];
  const hasOptions = options.length > 0;

  // Compute live pro-rated quote for the selected option
  const computeOptionQuote = (opt: ProgramOption) => {
    if (!term) return { full: opt.fullPriceCents, payNow: opt.fullPriceCents, discount: 0, weeklyTotal: opt.fullPriceCents };
    const todayIso = new Date().toISOString().split("T")[0];
    const sessions = opt.sessionCount ?? 10;
    if (todayIso < term.startDate) return { full: opt.fullPriceCents, payNow: opt.fullPriceCents, discount: 0, weeklyTotal: opt.fullPriceCents };
    if (todayIso > term.endDate) return { full: opt.fullPriceCents, payNow: 0, discount: opt.fullPriceCents, weeklyTotal: 0 };
    const a = new Date(todayIso + "T00:00:00").getTime();
    const b = new Date(term.endDate + "T00:00:00").getTime();
    const remaining = Math.max(1, Math.round((b - a) / (1000 * 60 * 60 * 24 * 7)) + 1);
    const capped = Math.min(remaining, sessions);
    // Grace weeks — full price for the first N weeks of the term, mirroring
    // the server (server/program-pricing.ts). The server re-prices before any
    // charge; this only keeps the number on screen from disagreeing with it.
    const grace = Math.max(0, Math.min(sessions, Math.floor(Number((program as any)?.prorataGraceWeeks) || 0)));
    const weeksElapsed = Math.max(0, Math.floor(
      (a - new Date(term.startDate + "T00:00:00").getTime()) / (1000 * 60 * 60 * 24 * 7),
    ));
    const ratio = weeksElapsed < grace ? 1 : capped / sessions;
    const payNow = opt.pricingModel === "term_prorated" ? Math.round(opt.fullPriceCents * ratio) : opt.fullPriceCents;
    return { full: opt.fullPriceCents, payNow, discount: opt.fullPriceCents - payNow, weeklyTotal: opt.fullPriceCents, weeklyRemaining: capped };
  };

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200 bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <button
            onClick={() => {
              if (step === "payment") setStep("details");
              else if (step === "details" && options.length > 1) setStep("options");
              else setLocation(`/${slug}`);
            }}
            className="flex items-center gap-2 text-sm font-medium text-zinc-500 hover:text-zinc-900"
          >
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="text-sm font-medium text-zinc-700">{program.name}</div>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Step 1: Pick option */}
        {step === "options" && hasOptions && (
          <>
            <h1 className="text-3xl font-black tracking-tight mb-2">Pick your option</h1>
            <p className="text-zinc-500 mb-8">
              {term ? `${term.name ?? `Term ${term.termNumber}`} ${term.year}` : "Pick an option to continue."}
            </p>
            <div className="space-y-3">
              {options.map(opt => {
                const q = computeOptionQuote(opt);
                const isSelected = selectedOption?.id === opt.id;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedOption(opt)}
                    className={`w-full text-left rounded-xl border p-5 transition ${
                      isSelected ? "border-blue-500 bg-blue-50" : "border-zinc-200 bg-white hover:border-zinc-400"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="font-bold text-lg">{opt.name}</div>
                        {opt.scheduleText && (
                          <div className="text-sm text-zinc-600 mt-0.5 flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5" /> {opt.scheduleText}
                          </div>
                        )}
                        {opt.description && <div className="text-sm text-zinc-500 mt-2">{opt.description}</div>}
                        {opt.allowPayWeekly && (
                          <div className="text-xs text-blue-600 mt-2 flex items-center gap-1">
                            <Repeat className="w-3 h-3" /> Pay-weekly available
                          </div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        {q.discount > 0 ? (
                          <>
                            <div className="text-zinc-400 line-through text-sm">{money(q.full)}</div>
                            <div className="text-2xl font-bold text-zinc-900">{money(q.payNow)}</div>
                            <div className="text-[10px] text-emerald-600 mt-0.5">pro-rated for term</div>
                          </>
                        ) : (
                          <>
                            <div className="text-2xl font-bold text-zinc-900">{money(q.full)}</div>
                            <div className="text-[10px] text-zinc-400">/term</div>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <Button
              onClick={() => setStep("details")}
              disabled={!selectedOption}
              className="w-full mt-6 bg-blue-600 hover:bg-blue-700 text-white text-base py-6 rounded-xl"
            >
              Continue with {selectedOption?.name ?? "—"} →
            </Button>
          </>
        )}

        {/* Step 2: Details */}
        {step === "details" && selectedOption && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-8">
            <div>
              <h1 className="text-3xl font-black tracking-tight mb-2">Register your child</h1>
              <p className="text-zinc-500 mb-8">{selectedOption.name}{selectedOption.scheduleText ? ` · ${selectedOption.scheduleText}` : ""}</p>

              <section className="space-y-6">
                {/* Payment mode picker (only if option allows weekly) */}
                {selectedOption.allowPayWeekly && (
                  <div>
                    <h2 className="text-sm font-bold text-zinc-700 uppercase tracking-wider mb-3">How would you like to pay?</h2>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setPaymentMode("upfront")}
                        className={`p-4 rounded-xl border text-left transition ${
                          paymentMode === "upfront" ? "border-blue-500 bg-blue-50" : "border-zinc-200 hover:border-zinc-400"
                        }`}
                      >
                        <CreditCard className="w-4 h-4 mb-1.5 text-zinc-600" />
                        <div className="font-semibold text-sm">Pay upfront</div>
                        <div className="text-xs text-zinc-500 mt-0.5">{money(computeOptionQuote(selectedOption).payNow)} now</div>
                      </button>
                      <button
                        onClick={() => setPaymentMode("weekly")}
                        className={`p-4 rounded-xl border text-left transition ${
                          paymentMode === "weekly" ? "border-blue-500 bg-blue-50" : "border-zinc-200 hover:border-zinc-400"
                        }`}
                      >
                        <Repeat className="w-4 h-4 mb-1.5 text-zinc-600" />
                        <div className="font-semibold text-sm">Pay weekly</div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          {money(selectedOption.weeklyPriceCents ?? Math.round(selectedOption.fullPriceCents / (selectedOption.sessionCount ?? 10)))}/week
                        </div>
                      </button>
                    </div>
                  </div>
                )}

                {prefill && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
                    Signed in as <strong>{prefill.parent.email}</strong> — we've filled in your details.{" "}
                    {/* Absolute: the portal lives on cufc.co.nz, this checkout on
                        join.cufc.co.nz. A relative href would 404 here. */}
                    <a href="https://cufc.co.nz/account" className="underline">Your account</a>
                  </div>
                )}

                <div>
                  <h2 className="text-sm font-bold text-zinc-700 uppercase tracking-wider mb-3">Parent / guardian</h2>
                  <div className="grid grid-cols-2 gap-3">
                    <Input value={parentFirst} onChange={e => setParentFirst(e.target.value)} placeholder="First name" />
                    <Input value={parentLast} onChange={e => setParentLast(e.target.value)} placeholder="Last name" />
                    <Input type="email" value={parentEmail} onChange={e => setParentEmail(e.target.value)} placeholder="Email" className="col-span-2" />
                    <Input value={parentPhone} onChange={e => setParentPhone(e.target.value)} placeholder="Mobile" className="col-span-2" />
                  </div>
                </div>

                <div>
                  <h2 className="text-sm font-bold text-zinc-700 uppercase tracking-wider mb-3">Your child</h2>

                  {/* A returning family picks a child we already hold, instead of
                      retyping them into a second record. Registering the same
                      child twice by hand is why 207 children are duplicated. */}
                  {prefill && prefill.children.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {prefill.children.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => chooseChild(childKey === c.key ? null : c.key)}
                          className={`rounded-full border px-3.5 py-2 text-sm font-semibold transition ${
                            childKey === c.key
                              ? "border-blue-500 bg-blue-50 text-blue-900"
                              : "border-zinc-200 text-zinc-700 hover:border-zinc-400"
                          }`}
                        >
                          {c.firstName} {c.lastName}
                          {c.ageGrade ? <span className="ml-1.5 font-normal text-zinc-500">U{c.ageGrade}</span> : null}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => chooseChild(null)}
                        className={`rounded-full border px-3.5 py-2 text-sm font-semibold transition ${
                          childKey === null
                            ? "border-blue-500 bg-blue-50 text-blue-900"
                            : "border-zinc-200 text-zinc-700 hover:border-zinc-400"
                        }`}
                      >
                        + Another child
                      </button>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <Input value={childFirst} onChange={e => { setChildFirst(e.target.value); setChildKey(null); }} placeholder="First name" />
                    <Input value={childLast} onChange={e => { setChildLast(e.target.value); setChildKey(null); }} placeholder="Last name" />
                    <DatePickerInput value={childDob} onChange={e => { setChildDob(e.target.value); setChildKey(null); }} className="col-span-2" />
                  </div>
                </div>

                <textarea
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Anything we should know? (allergies, medical, etc.) — optional"
                  className="w-full px-3 py-2.5 rounded-lg border border-zinc-300 focus:border-zinc-900 focus:outline-none min-h-[80px]"
                />

                {error && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>}

                <Button
                  onClick={proceedToPayment}
                  disabled={!formValid || submitting}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white text-base py-6 rounded-xl"
                >
                  {submitting ? "Loading payment..." : `Continue to payment →`}
                </Button>
              </section>
            </div>

            {/* Order summary */}
            <aside className="lg:sticky lg:top-6 lg:self-start order-first lg:order-last">
              <div className="rounded-2xl border border-zinc-200 bg-white p-5">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-2">Your registration</div>
                <div className="font-bold text-zinc-900 mb-1">{program.name}</div>
                <div className="text-sm text-zinc-700 mb-1">{selectedOption.name}</div>
                {selectedOption.scheduleText && <div className="text-xs text-zinc-500 mb-3">{selectedOption.scheduleText}</div>}

                <div className="pt-3 border-t border-zinc-200 space-y-1.5 text-sm">
                  {paymentMode === "weekly" ? (
                    <>
                      <div className="flex justify-between text-zinc-600">
                        <span>Weekly fee</span>
                        <span className="font-mono">{money(selectedOption.weeklyPriceCents ?? Math.round(selectedOption.fullPriceCents / (selectedOption.sessionCount ?? 10)))}</span>
                      </div>
                      <div className="flex justify-between text-zinc-600">
                        <span>Total weeks</span>
                        <span className="font-mono">{selectedOption.sessionCount ?? "—"}</span>
                      </div>
                      <div className="flex justify-between font-bold text-base pt-2 border-t border-zinc-200 mt-2">
                        <span>Today's first payment</span>
                        <span className="font-mono">{money(selectedOption.weeklyPriceCents ?? Math.round(selectedOption.fullPriceCents / (selectedOption.sessionCount ?? 10)))}</span>
                      </div>
                      <div className="text-[11px] text-zinc-500 pt-1">Future weeks charge automatically.</div>
                    </>
                  ) : (() => {
                    const q = computeOptionQuote(selectedOption);
                    return (
                      <>
                        {q.discount > 0 && (
                          <>
                            <div className="flex justify-between text-zinc-600">
                              <span>Term price</span>
                              <span className="font-mono line-through">{money(q.full)}</span>
                            </div>
                            <div className="flex justify-between text-emerald-600">
                              <span>Pro-rated</span>
                              <span className="font-mono">−{money(q.discount)}</span>
                            </div>
                          </>
                        )}
                        <div className="flex justify-between font-bold text-base pt-2 border-t border-zinc-200 mt-2">
                          <span>You pay today</span>
                          <span className="font-mono">{money(q.payNow)}</span>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </aside>
          </div>
        )}

        {/* Step 3: Payment */}
        {step === "payment" && intent && (
          <div className="max-w-xl mx-auto">
            <h1 className="text-3xl font-black tracking-tight mb-2">
              {intent.paymentMode === "weekly" ? `${money(intent.quote.payNowCents)}/week` : `Pay ${money(intent.quote.payNowCents)}`}
            </h1>
            <p className="text-zinc-500 mb-8">Receipt + confirmation will be sent to {parentEmail}.</p>
            <Elements stripe={stripePromise} options={{ clientSecret: intent.clientSecret, appearance: { theme: "stripe" } }}>
              <PaymentForm
                slug={slug}
                registrationId={intent.registrationId}
                totalCents={intent.quote.payNowCents}
                parentEmail={parentEmail}
                isWeekly={intent.paymentMode === "weekly"}
                programName={program.name}
              />
            </Elements>
          </div>
        )}

        {/* No options at all — fall back to a friendly notice */}
        {step === "options" && !hasOptions && (
          <div className="rounded-2xl border border-zinc-200 bg-white p-12 text-center">
            <h2 className="text-xl font-bold mb-2">Registration not yet available</h2>
            <p className="text-zinc-500">This program doesn't have any options live yet. Check back soon — or get in touch.</p>
          </div>
        )}
      </div>
    </div>
  );
}

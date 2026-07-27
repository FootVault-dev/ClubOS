// Public CUFC Academy registration + embedded checkout — join.cufc.co.nz/academy/:slug
//
// Five steps: choose option+plan → player (incl. NZF audit fields) → guardian +
// emergency contact → consents → payment. Two alternate states pre-empt the
// wizard entirely: registrations not open yet, and programme full — both show
// a waitlist form instead of any payment UI.
//
// Money rule: this page NEVER computes a price. Every dollar shown comes from
// `quotes[]` (the detail fetch) or `registerResponse.quote` (the register
// response) — both server-sourced from program_options. See shared/academy.ts.
//
// Checkout is embedded (Stripe PaymentElement on our own page) — never a
// redirect to checkout.stripe.com or a Payment Link.

import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import {
  ArrowLeft, ArrowRight, Lock, ShieldCheck, Loader2, AlertCircle, CheckCircle2,
  MapPin, Users, Info, Mail, Tag, X,
} from "lucide-react";
import { checkEligibility, GENDERS, type Gender, type AcademyPaymentPlan } from "@shared/academy";
import { initPixel, trackEvent } from "@/lib/meta-pixel";
import { purchaseEventId } from "@shared/meta-events";
import {
  NzfIdentityFields,
  NzfAddressFields,
  EMPTY_NZF_IDENTITY,
  EMPTY_NZF_ADDRESS,
  type NzfIdentityValue,
  type NzfAddressValue,
  type NzfCountryOption,
  type NzfGroupOption,
} from "@/components/nzf-identity-fields";

// Only initialise Stripe if the publishable key was actually baked into the
// build — otherwise render a clear message instead of a silently blank
// PaymentElement (mirrors mfl-checkout-page.tsx).
const STRIPE_PK = (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined) || "";
const stripePromise: Promise<Stripe | null> | null = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

// ── Brand — CUFC palette from apps/cufc-website/tailwind.config.js ──────────
const BRAND = {
  navy: "#0C1640",
  ink: "#13182F",
  royal: "#263996",
  royalDeep: "#1C2B78",
  gold: "#D4AF37",
  goldBright: "#E8CF6B",
  sky: "#17A6E0",
  white: "#FFFFFF",
  line: "#232B4E",
  mute: "#AEB6D4",
  red: "#f0564f",
};
const FONT_BODY = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_DISPLAY = "'Oswald', 'Arial Narrow', sans-serif";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhone = (v: string) => v.replace(/\D/g, "").length >= 8;

// ── API shapes — mirrors GET/POST /api/public/academy/* exactly ────────────

interface ProgrammeOption {
  id: number;
  name: string;
  scheduleText: string | null;
  termPriceCents: number;
}

interface Programme {
  id: number;
  name: string;
  slug: string;
  section: "core" | "additional";
  descriptionShort: string | null;
  description: string | null;
  location: string | null;
  ageMin: number | null;
  ageMax: number | null;
  seasonYear: number;
  capacity: number | null;
  spotsRemaining: number | null;
  isFull: boolean;
  registrationOpen: boolean;
  allowFullYear: boolean;
  options: ProgrammeOption[];
}

interface Quote {
  optionId: number;
  plan: AcademyPaymentPlan;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  termsCovered: number;
  reason: string;
  /** Pro-rata, present on 'term' quotes when the programme is bound to a term. */
  sessionsRemaining?: number | null;
  totalSessions?: number | null;
  termStatus?: "before" | "running" | "ended" | null;
  /** Promo code applied at register time. */
  promoCents?: number;
  discountCode?: string | null;
}

/** A code the server has validated against one option+plan. `wasCents` is the
 *  total it was quoted on — the anchor that detects a stale code. */
interface AppliedPromo {
  code: string;
  promoCents: number;
  totalCents: number;
  wasCents: number;
}

interface TermInfo {
  name: string | null;
  termNumber: number;
  year: number;
  startDate: string;
  endDate: string;
}

interface ProgrammeResponse {
  programme: Programme;
  quotes: Quote[];
  term: TermInfo | null;
  policyVersion: string;
  nzf?: {
    countries: NzfCountryOption[];
    ethnicityGroups: NzfGroupOption[];
    regions: string[];
  };
  /** Legacy free-text ethnicity list — superseded by `nzf`. */
  ethnicities?: string[];
}

interface RegisterResponse {
  registrationId: number;
  clientSecret: string;
  quote: Quote;
  programme: { name: string; slug: string; section: string };
  option: { id: number; name: string; scheduleText: string | null };
  player: { firstName: string; grade: number | null; seasonYear: number };
}

type WizardStep = "choose" | "player" | "guardian" | "consents" | "payment";
type BlockedState = "closed" | "full" | null;

interface ChildForm {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: Gender | "";
  school: string;
  medicalNotes: string;
  allergies: string;
}

interface GuardianForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  alternatePhone: string;
  relationship: string;
}

interface EmergencyForm {
  name: string;
  phone: string;
}

interface ConsentsForm {
  policy: boolean;
  medical: boolean;
  photo: boolean;
  newsletter: boolean;
}

const EMPTY_CHILD: ChildForm = {
  firstName: "", lastName: "", dateOfBirth: "", gender: "", school: "",
  medicalNotes: "", allergies: "",
};
const EMPTY_GUARDIAN: GuardianForm = {
  firstName: "", lastName: "", email: "", phone: "", alternatePhone: "", relationship: "",
};
const EMPTY_EMERGENCY: EmergencyForm = { name: "", phone: "" };
const EMPTY_CONSENTS: ConsentsForm = { policy: false, medical: false, photo: false, newsletter: false };

const GENDER_LABELS: Record<Gender, string> = { male: "Male", female: "Female", other: "Other" };

// ── Small styled primitives — scoped focus styles via one unique class ─────

const fieldCls =
  "cufc-ar-field w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors disabled:opacity-50";
const fieldStyle: React.CSSProperties = { background: BRAND.ink, border: `1px solid ${BRAND.line}`, color: BRAND.white };

// One theme object so the NZF pickers render identically to the native fields
// around them — they are custom controls, not <select>s, because 247 countries
// and 134 iwi in a native picker is unusable on a phone.
const FIELD_THEME = {
  gold: BRAND.gold,
  goldBright: BRAND.goldBright,
  line: BRAND.line,
  mute: BRAND.mute,
  fieldCls,
  fieldStyle,
  labelCls: "block text-[11px] font-bold uppercase tracking-[0.14em] mb-1.5",
  labelStyle: { color: BRAND.mute },
};

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-[11px] font-bold uppercase tracking-[0.14em] mb-1.5" style={{ color: BRAND.mute }}>
      {children}
      {required && <span style={{ color: BRAND.gold }}> *</span>}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, style, ...rest } = props;
  return <input {...rest} className={`${fieldCls} ${className ?? ""}`} style={{ ...fieldStyle, ...style }} />;
}

function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  const { className, style, children, ...rest } = props;
  return (
    <select {...rest} className={`${fieldCls} ${className ?? ""}`} style={{ ...fieldStyle, ...style }}>
      {children}
    </select>
  );
}

function TextareaInput(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className, style, ...rest } = props;
  return <textarea {...rest} className={`${fieldCls} min-h-[90px] ${className ?? ""}`} style={{ ...fieldStyle, ...style }} />;
}

function CheckboxRow({
  checked, onChange, children, required, testId,
}: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; required?: boolean; testId?: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="mt-0.5 h-5 w-5 flex-shrink-0 rounded"
        style={{ accentColor: BRAND.gold }}
      />
      <span className="text-[14px] leading-relaxed" style={{ color: "rgba(255,255,255,0.85)" }}>
        {children}
        {required && <span style={{ color: BRAND.gold }}> *</span>}
      </span>
    </label>
  );
}

function ContinueButton({
  onClick, disabled, children, testId,
}: { onClick: () => void; disabled?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="w-full flex items-center justify-center gap-2 rounded-full py-4 text-[15px] font-bold uppercase tracking-wide transition disabled:opacity-40 disabled:cursor-not-allowed min-h-[52px]"
      style={{ background: BRAND.gold, color: BRAND.navy }}
    >
      {children} <ArrowRight className="w-4 h-4" />
    </button>
  );
}

function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-sm flex items-start gap-2"
      style={{ background: "rgba(220,38,38,0.12)", border: "1px solid rgba(220,38,38,0.3)", color: "#fca5a5" }}
    >
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" /> <span>{children}</span>
    </div>
  );
}

// ── Payment step — embedded Stripe PaymentElement, never a redirect ────────

function PaymentForm({
  reg, guardianEmail, guardianName, onSuccess, onError,
}: {
  reg: RegisterResponse;
  guardianEmail: string;
  guardianName: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);

    // return_url only fires if the card issuer forces an off-page redirect
    // (3DS). We carry the registrationId so the page can render a minimal
    // confirmation from the returned PaymentIntent on reload — see the
    // top-level `payment_intent_client_secret` handler below.
    const returnUrl = `${window.location.origin}${window.location.pathname}?registrationId=${reg.registrationId}`;

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl, receipt_email: guardianEmail },
      redirect: "if_required",
    });

    if (stripeError) {
      const msg = stripeError.message || "Payment failed — please try again, or use a different card.";
      setError(msg);
      onError(msg);
      setProcessing(false);
      return;
    }

    if (paymentIntent?.status === "succeeded" || paymentIntent?.status === "processing") {
      // Browser Purchase pixel. Deduped against the server CAPI event by the
      // shared deterministic id `purchase_<registrationId>` — Meta keeps one.
      try {
        trackEvent(
          "Purchase",
          {
            value: reg.quote.totalCents / 100,
            currency: "NZD",
            content_name: `${reg.programme.name} — academy registration`,
            content_ids: [reg.programme.slug],
            num_items: 1,
          },
          purchaseEventId(reg.registrationId),
        );
      } catch { /* a tracking failure must never break a paid registration */ }
      onSuccess();
    } else {
      setError("Payment could not be completed. Please try another card.");
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded-2xl p-5 sm:p-6" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}`, minHeight: 96 }}>
        {!ready && !loadError && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm" style={{ color: BRAND.mute }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading secure payment…
          </div>
        )}
        {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
        <div style={{ display: ready ? "block" : "none" }}>
          <PaymentElement
            options={{ layout: "tabs", defaultValues: { billingDetails: { email: guardianEmail, name: guardianName } } }}
            onReady={() => setReady(true)}
            onLoadError={(e: any) => setLoadError(e?.error?.message || "Couldn't load the payment form. Refresh and try again, or contact us.")}
          />
        </div>
      </div>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      <button
        type="submit"
        disabled={!stripe || !ready || processing}
        data-testid="button-pay"
        className="w-full flex items-center justify-center gap-2 rounded-full py-4 text-[16px] font-bold disabled:opacity-60 min-h-[52px]"
        style={{ background: BRAND.gold, color: BRAND.navy }}
      >
        {processing ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</> : <><Lock className="w-4 h-4" /> Pay {money(reg.quote.totalCents)}</>}
      </button>

      <div className="flex items-center justify-center gap-5 text-[12px] flex-wrap" style={{ color: "rgba(255,255,255,0.4)" }}>
        <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> SSL encrypted</span>
        <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Stripe secure</span>
      </div>
    </form>
  );
}

// ── Waitlist form — used for both "not open yet" and "programme full" ──────

function WaitlistForm({
  slug, kind, initialChildFirst, initialChildLast, initialGuardianName, initialEmail, initialPhone,
}: {
  slug: string;
  kind: "closed" | "full";
  initialChildFirst?: string;
  initialChildLast?: string;
  initialGuardianName?: string;
  initialEmail?: string;
  initialPhone?: string;
}) {
  const [childFirstName, setChildFirstName] = useState(initialChildFirst ?? "");
  const [childLastName, setChildLastName] = useState(initialChildLast ?? "");
  const [childDob, setChildDob] = useState("");
  const [guardianName, setGuardianName] = useState(initialGuardianName ?? "");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const valid = childFirstName.trim() && childLastName.trim() && guardianName.trim() && isEmail(email) && isPhone(phone);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/public/academy/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug: slug,
          childFirstName: childFirstName.trim(),
          childLastName: childLastName.trim(),
          childDob: childDob || undefined,
          guardianName: guardianName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Something went wrong — please try again.");
      setDone(true);
    } catch (e: any) {
      setError(e.message || "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-2xl p-6 sm:p-8 text-center" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
        <CheckCircle2 className="w-10 h-10 mx-auto mb-3" style={{ color: BRAND.goldBright }} />
        <h2 className="text-xl font-bold" style={{ fontFamily: FONT_DISPLAY }}>You're on the list</h2>
        <p className="mt-2 text-sm" style={{ color: BRAND.mute }}>
          We've got {childFirstName}'s details — we'll email {email} as soon as {kind === "full" ? "a spot opens up" : "registrations open"}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl p-5 sm:p-6 space-y-4" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>Player's first name</Label>
          <TextInput value={childFirstName} onChange={(e) => setChildFirstName(e.target.value)} data-testid="input-waitlist-child-first" />
        </div>
        <div>
          <Label required>Player's last name</Label>
          <TextInput value={childLastName} onChange={(e) => setChildLastName(e.target.value)} data-testid="input-waitlist-child-last" />
        </div>
      </div>
      <div>
        <Label>Player's date of birth (optional)</Label>
        <TextInput type="date" value={childDob} onChange={(e) => setChildDob(e.target.value)} style={{ colorScheme: "dark" }} max={new Date().toISOString().slice(0, 10)} data-testid="input-waitlist-dob" />
      </div>
      <div>
        <Label required>Your name (parent/guardian)</Label>
        <TextInput value={guardianName} onChange={(e) => setGuardianName(e.target.value)} data-testid="input-waitlist-guardian-name" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <Label required>Email</Label>
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-waitlist-email" />
        </div>
        <div>
          <Label required>Phone</Label>
          <TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-waitlist-phone" />
        </div>
      </div>
      <div>
        <Label>Anything we should know? (optional)</Label>
        <TextareaInput value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <ContinueButton onClick={submit} disabled={!valid || submitting} testId="button-waitlist-submit">
        {submitting ? "Sending…" : "Register your interest"}
      </ContinueButton>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────

export default function AcademyRegisterPage() {
  const [, params] = useRoute("/academy/:slug");
  const slug = params?.slug ?? "";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [programme, setProgramme] = useState<Programme | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [term, setTerm] = useState<TermInfo | null>(null);
  const [nzfCountries, setNzfCountries] = useState<NzfCountryOption[]>([]);
  const [nzfGroups, setNzfGroups] = useState<NzfGroupOption[]>([]);
  const [nzfRegions, setNzfRegions] = useState<string[]>([]);
  const [identity, setIdentity] = useState<NzfIdentityValue>(EMPTY_NZF_IDENTITY);
  const [address, setAddress] = useState<NzfAddressValue>(EMPTY_NZF_ADDRESS);
  // Promo code. The client only ever holds the STRING — every amount comes back
  // from the server, which re-derives it from scratch when it charges the card.
  const [discountCode, setDiscountCode] = useState("");
  const [promo, setPromo] = useState<AppliedPromo | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  // Wizard state
  const [step, setStep] = useState<WizardStep>("choose");
  const [selectedOptionId, setSelectedOptionId] = useState<number | null>(null);
  const [plan, setPlan] = useState<AcademyPaymentPlan>("term");
  const [child, setChild] = useState<ChildForm>(EMPTY_CHILD);
  const [guardian, setGuardian] = useState<GuardianForm>(EMPTY_GUARDIAN);
  const [emergency, setEmergency] = useState<EmergencyForm>(EMPTY_EMERGENCY);
  const [consents, setConsents] = useState<ConsentsForm>(EMPTY_CONSENTS);
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [registerResponse, setRegisterResponse] = useState<RegisterResponse | null>(null);
  const [paymentSucceeded, setPaymentSucceeded] = useState(false);
  const [blocked, setBlocked] = useState<BlockedState>(null);

  // Fallback confirmation state — populated only if a 3DS bank redirect sent
  // the browser away and back. There is no public "get registration" endpoint,
  // so this renders from the retrieved Stripe PaymentIntent alone.
  const [redirectSuccess, setRedirectSuccess] = useState<{ amountCents: number; registrationId: number | null } | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setLoadError(null);
    fetch(`/api/public/academy/programmes/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.message || "This programme isn't available right now.");
        return body as ProgrammeResponse;
      })
      .then((body) => {
        setProgramme(body.programme);
        setQuotes(body.quotes || []);
        setTerm(body.term ?? null);
        setNzfCountries(body.nzf?.countries || []);
        setNzfGroups(body.nzf?.ethnicityGroups || []);
        setNzfRegions(body.nzf?.regions || []);
        if (body.programme.options.length === 1) setSelectedOptionId(body.programme.options[0].id);
        document.title = `Register — ${body.programme.name} | Christchurch United FC`;

        // Initialise the Meta pixel on the funnel itself. Without this there is
        // no _fbp cookie, no ViewContent, and the Purchase event has nothing to
        // attach to — a Facebook campaign would be optimising on clicks.
        // No child data is ever passed; the programme is all Meta sees.
        const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
        if (pixelId) {
          try {
            initPixel(pixelId);
            trackEvent("ViewContent", {
              content_name: body.programme.name,
              content_category: "Academy Programme",
              content_ids: [body.programme.slug],
            });
          } catch { /* never break the page for a tracker */ }
        }
      })
      .catch((e) => setLoadError(e.message || "This programme isn't available right now."))
      .finally(() => setLoading(false));
  }, [slug]);

  // 3DS redirect-back handler — must run once, independent of the wizard.
  useEffect(() => {
    const params2 = new URLSearchParams(window.location.search);
    const secret = params2.get("payment_intent_client_secret");
    const regId = params2.get("registrationId");
    if (!secret || !stripePromise) return;
    stripePromise.then(async (stripe) => {
      if (!stripe) return;
      const { paymentIntent } = await stripe.retrievePaymentIntent(secret);
      if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")) {
        setRedirectSuccess({ amountCents: paymentIntent.amount, registrationId: regId ? Number(regId) : null });
      } else if (paymentIntent) {
        setSubmitError("Your payment wasn't completed — please try again.");
      }
    });
  }, []);

  const selectedOption = useMemo(
    () => programme?.options.find((o) => o.id === selectedOptionId) ?? null,
    [programme, selectedOptionId],
  );
  const selectedQuote = useMemo(
    () => quotes.find((q) => q.optionId === selectedOptionId && q.plan === plan) ?? null,
    [quotes, selectedOptionId, plan],
  );

  // A code is validated against ONE option+plan. Switching either would leave a
  // total on screen that the server would never charge, so the promo is dropped.
  useEffect(() => { setPromo(null); setPromoError(null); }, [selectedOptionId, plan]);

  const eligibility = programme && child.dateOfBirth
    ? checkEligibility(child.dateOfBirth, programme.seasonYear, programme.ageMin, programme.ageMax)
    : null;

  const chooseValid = !!selectedOption && !!selectedQuote;

  // Client-side readiness only — it decides whether the "Continue" button is
  // live. The server re-validates every one of these against NZ Football's
  // vocabulary and is the authority; this just avoids sending a form we can
  // already see is incomplete. Mirrors shared/nzf-identity.ts.
  const ethnicityChoiceValid = (groupId: number | null, ids: number[]): boolean => {
    if (groupId === null) return false;
    const g = nzfGroups.find((x) => x.id === groupId);
    if (!g) return false;
    if (g.maxSelections === 0) return ids.length === 0;
    return ids.length >= g.minSelections && ids.length <= g.maxSelections;
  };
  const identityValid =
    !!identity.countryOfBirthCode &&
    !!identity.nationalityCode &&
    ethnicityChoiceValid(identity.ethnicityGroupId, identity.ethnicitySelectionIds) &&
    // A second ethnicity is optional — but a half-filled one is not "absent".
    (identity.ethnicity2GroupId === null
      ? true
      : ethnicityChoiceValid(identity.ethnicity2GroupId, identity.ethnicity2SelectionIds));
  const addressValid =
    address.street.trim() !== "" &&
    address.suburb.trim() !== "" &&
    address.city.trim() !== "" &&
    address.region.trim() !== "" &&
    address.postcode.trim() !== "" &&
    address.country !== "";
  const playerValid =
    child.firstName.trim() !== "" &&
    child.lastName.trim() !== "" &&
    child.dateOfBirth !== "" &&
    (eligibility?.eligible ?? false) &&
    (GENDERS as readonly string[]).includes(child.gender) &&
    identityValid;
  const guardianValid =
    guardian.firstName.trim() !== "" &&
    guardian.lastName.trim() !== "" &&
    isEmail(guardian.email) &&
    isPhone(guardian.phone) &&
    guardian.relationship.trim() !== "" &&
    addressValid &&
    emergency.name.trim() !== "" &&
    isPhone(emergency.phone);
  const consentsValid = consents.policy === true && consents.medical === true;

  const applyDiscount = async () => {
    if (!selectedOption || promoChecking) return;
    setPromoChecking(true);
    setPromoError(null);
    try {
      const res = await fetch("/api/public/academy/validate-discount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ programSlug: slug, programOptionId: selectedOption.id, paymentPlan: plan, code: discountCode.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.valid) { setPromo(null); setPromoError(body.message || "That code isn't valid."); return; }
      setPromo({ code: body.code, promoCents: body.promoCents, totalCents: body.totalCents, wasCents: body.wasCents });
    } catch {
      setPromoError("Couldn't check that code — try again.");
    } finally {
      setPromoChecking(false);
    }
  };

  const submitRegistration = async () => {
    if (!programme || !selectedOption || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Campaign parameters, read off this page's own URL and sent in the body.
      //
      // The server's attribution stamp reads cookies and the request body — it
      // never looks at the query string. cufc.co.nz forwards these onto the
      // checkout URL precisely so that they can be picked up here. Without this
      // block every academy registration is recorded as "direct", however it was
      // tagged, and a campaign report shows nothing.
      const sp = new URLSearchParams(window.location.search);
      const utm = {
        source: sp.get("utm_source"),
        medium: sp.get("utm_medium"),
        campaign: sp.get("utm_campaign"),
        content: sp.get("utm_content"),
        term: sp.get("utm_term"),
        fbclid: sp.get("fbclid"),
        gclid: sp.get("gclid"),
      };

      const res = await fetch("/api/public/academy/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          programSlug: slug,
          programOptionId: selectedOption.id,
          paymentPlan: plan,
          discountCode: promo ? promo.code : undefined,
          utm,
          source: sp.get("source") || undefined,
          child: {
            firstName: child.firstName.trim(),
            lastName: child.lastName.trim(),
            dateOfBirth: child.dateOfBirth,
            gender: child.gender,
            school: child.school.trim() || undefined,
            // Codes and ids straight off NZ Football's list. The server
            // re-resolves them to names — we deliberately do NOT send display
            // names, so a mismatched pair can't be filed as fact.
            countryOfBirthCode: identity.countryOfBirthCode,
            nationalityCode: identity.nationalityCode,
            ethnicityGroupId: identity.ethnicityGroupId,
            ethnicitySelectionIds: identity.ethnicitySelectionIds,
            ethnicity2GroupId: identity.ethnicity2GroupId ?? undefined,
            ethnicity2SelectionIds: identity.ethnicity2GroupId ? identity.ethnicity2SelectionIds : undefined,
            medicalNotes: child.medicalNotes.trim() || undefined,
            allergies: child.allergies.trim() || undefined,
          },
          guardian: {
            firstName: guardian.firstName.trim(),
            lastName: guardian.lastName.trim(),
            email: guardian.email.trim().toLowerCase(),
            phone: guardian.phone.trim(),
            alternatePhone: guardian.alternatePhone.trim() || undefined,
            relationship: guardian.relationship.trim(),
            addressParts: {
              street: address.street.trim(),
              suburb: address.suburb.trim(),
              city: address.city.trim(),
              region: address.region.trim(),
              postcode: address.postcode.trim(),
              country: address.country,
            },
          },
          emergency: { name: emergency.name.trim(), phone: emergency.phone.trim() },
          consents,
          notes: notes.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server tags every 409 with a `code` — never sniff the message.
        // (A programme can fill between loading this page and submitting it.)
        if (res.status === 409 && (data.code === "full" || data.full)) { setBlocked("full"); return; }
        // "term_ended" and "not_open" both mean: no payment, capture the family.
        if (res.status === 409) { setBlocked("closed"); return; }
        throw new Error(data.message || (Array.isArray(data.errors) && data.errors[0]) || "Something went wrong — please try again.");
      }
      setRegisterResponse(data as RegisterResponse);
      setStep("payment");
    } catch (e: any) {
      setSubmitError(e.message || "Something went wrong — please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => {
    setSubmitError(null);
    if (step === "player") setStep("choose");
    else if (step === "guardian") setStep("player");
    else if (step === "consents") setStep("guardian");
    else if (step === "payment") setStep("consents");
  };

  const stepIndex = ["choose", "player", "guardian", "consents", "payment"].indexOf(step) + 1;
  const useSameAsGuardian = () => setEmergency({ name: `${guardian.firstName} ${guardian.lastName}`.trim(), phone: guardian.phone });

  // ── Render states ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.navy }}>
        <div className="animate-pulse rounded-2xl h-64 w-full max-w-sm mx-6" style={{ background: BRAND.ink }} />
      </div>
    );
  }

  if (loadError || !programme) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6 text-center" style={{ background: BRAND.navy, color: BRAND.white, fontFamily: FONT_BODY }}>
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: FONT_DISPLAY }}>Programme not found</h1>
          <p className="mt-2" style={{ color: BRAND.mute }}>{loadError || "This registration link isn't valid."}</p>
          <a href="https://cufc.co.nz" className="inline-block mt-6 text-sm font-semibold underline" style={{ color: BRAND.goldBright }}>Back to cufc.co.nz</a>
        </div>
      </div>
    );
  }

  const notOpenYet = !programme.registrationOpen;
  const isFullOpen = programme.registrationOpen && programme.isFull;
  const effectiveBlocked: BlockedState = blocked ?? (notOpenYet ? "closed" : isFullOpen ? "full" : null);

  return (
    <div className="min-h-screen" style={{ background: BRAND.navy, color: BRAND.white, fontFamily: FONT_BODY }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&display=swap');
        .cufc-ar-field:focus { border-color: ${BRAND.gold} !important; box-shadow: 0 0 0 1px ${BRAND.gold}; }
        .cufc-ar-field::placeholder { color: rgba(255,255,255,0.3); }
        input[type="date"].cufc-ar-field::-webkit-calendar-picker-indicator { filter: invert(1) opacity(0.6); }
      `}</style>

      {/* Header */}
      <header className="sticky top-0 z-20" style={{ background: "rgba(12,22,64,0.92)", backdropFilter: "blur(8px)", borderBottom: `1px solid ${BRAND.line}` }}>
        <div className="max-w-3xl mx-auto px-5 sm:px-6 h-14 flex items-center justify-between">
          {step !== "choose" && !effectiveBlocked && !registerResponse && !redirectSuccess ? (
            <button onClick={goBack} className="flex items-center gap-2 text-sm font-medium min-h-[44px]" style={{ color: BRAND.mute }} data-testid="button-back">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
          ) : (
            <span className="text-xs font-bold uppercase tracking-[0.28em]" style={{ color: BRAND.gold }}>Christchurch United FC</span>
          )}
          {!effectiveBlocked && !registerResponse && !redirectSuccess && (
            <span className="text-[12px]" style={{ color: BRAND.mute }}>Step {stepIndex} of 5</span>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-5 sm:px-6 py-8 sm:py-10 pb-16">
        {/* 3DS redirect-back fallback confirmation */}
        {redirectSuccess ? (
          <SuccessPanel
            title="Payment received"
            body={`Your payment of ${money(redirectSuccess.amountCents)} went through${redirectSuccess.registrationId ? ` — registration #${redirectSuccess.registrationId}` : ""}. A confirmation email is on its way.`}
          />
        ) : effectiveBlocked ? (
          <div className="max-w-xl mx-auto">
            <p className="text-xs font-bold uppercase tracking-[0.28em] mb-3" style={{ color: BRAND.gold }}>{programme.name}</p>
            <h1 className="text-2xl sm:text-3xl font-bold mb-2" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>
              {effectiveBlocked === "closed" ? "Registrations aren't open yet" : "This programme is full"}
            </h1>
            <p className="mb-6" style={{ color: BRAND.mute }}>
              {effectiveBlocked === "closed"
                ? "Leave your details and we'll email you the moment registration opens."
                : "All spots are taken for now — leave your details and we'll email you the moment one frees up."}
            </p>
            <WaitlistForm
              slug={slug}
              kind={effectiveBlocked}
              initialChildFirst={child.firstName}
              initialChildLast={child.lastName}
              initialGuardianName={`${guardian.firstName} ${guardian.lastName}`.trim()}
              initialEmail={guardian.email}
              initialPhone={guardian.phone}
            />
          </div>
        ) : registerResponse && paymentSucceeded ? (
          <SuccessPanel
            title="You're registered!"
            body={`${registerResponse.player.firstName}${registerResponse.player.grade != null ? ` (U${registerResponse.player.grade})` : ""} is locked into ${registerResponse.programme.name} — ${registerResponse.option.name}.`}
            details={[
              { label: "Plan", value: registerResponse.quote.plan === "year" ? `Full year (${registerResponse.quote.termsCovered} terms)` : "One term" },
              { label: "Amount paid", value: `${money(registerResponse.quote.totalCents)} NZD` },
              ...(registerResponse.quote.discountCents > 0
                ? [{ label: "Full-year saving", value: `−${money(registerResponse.quote.discountCents)}` }]
                : []),
              { label: "Registration no.", value: `#${registerResponse.registrationId}` },
            ]}
            footnote={`A confirmation email is on its way to ${guardian.email}.`}
          />
        ) : (
          <>
            {step === "choose" && (
              <ChooseStep
                programme={programme}
                term={term}
                quotes={quotes}
                selectedOptionId={selectedOptionId}
                setSelectedOptionId={setSelectedOptionId}
                plan={plan}
                setPlan={setPlan}
                selectedOption={selectedOption}
                selectedQuote={selectedQuote}
                onContinue={() => setStep("player")}
                disabled={!chooseValid}
              />
            )}

            {step === "player" && selectedOption && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
                <div className="space-y-6 order-2 lg:order-1">
                  <div>
                    <h1 className="text-2xl sm:text-3xl font-bold mb-1" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>Player details</h1>
                    {/* Do not overclaim: school, allergies, medical notes and iwi
                        are genuinely optional and are labelled so below. */}
                    <p className="text-sm" style={{ color: BRAND.mute }}>The starred fields are required for New Zealand Football's registration audit.</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label required>First name</Label>
                      <TextInput value={child.firstName} onChange={(e) => setChild((c) => ({ ...c, firstName: e.target.value }))} data-testid="input-child-first-name" />
                    </div>
                    <div>
                      <Label required>Last name</Label>
                      <TextInput value={child.lastName} onChange={(e) => setChild((c) => ({ ...c, lastName: e.target.value }))} data-testid="input-child-last-name" />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label required>Date of birth</Label>
                      <TextInput
                        type="date"
                        value={child.dateOfBirth}
                        onChange={(e) => setChild((c) => ({ ...c, dateOfBirth: e.target.value }))}
                        style={{ colorScheme: "dark" }}
                        max={new Date().toISOString().slice(0, 10)}
                        data-testid="input-child-dob"
                      />
                      {child.dateOfBirth && eligibility && (
                        <p className="mt-1.5 text-[12px] flex items-center gap-1.5" style={{ color: eligibility.eligible ? BRAND.goldBright : BRAND.red }}>
                          {eligibility.eligible ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                          {eligibility.reason}
                        </p>
                      )}
                    </div>
                    <div>
                      <Label required>Gender</Label>
                      <SelectInput value={child.gender} onChange={(e) => setChild((c) => ({ ...c, gender: e.target.value as Gender }))} data-testid="select-child-gender">
                        <option value="">Select…</option>
                        {GENDERS.map((g) => <option key={g} value={g}>{GENDER_LABELS[g]}</option>)}
                      </SelectInput>
                    </div>
                  </div>

                  <div>
                    <Label>School (optional)</Label>
                    <TextInput value={child.school} onChange={(e) => setChild((c) => ({ ...c, school: e.target.value }))} data-testid="input-child-school" />
                  </div>

                  <NzfIdentityFields
                    value={identity}
                    onChange={setIdentity}
                    countries={nzfCountries}
                    groups={nzfGroups}
                    theme={FIELD_THEME}
                  />

                  <div>
                    <Label>Allergies (optional)</Label>
                    <TextInput value={child.allergies} onChange={(e) => setChild((c) => ({ ...c, allergies: e.target.value }))} data-testid="input-child-allergies" />
                  </div>
                  <div>
                    <Label>Medical notes (optional)</Label>
                    <TextareaInput value={child.medicalNotes} onChange={(e) => setChild((c) => ({ ...c, medicalNotes: e.target.value }))} placeholder="Any conditions, medication, or info coaches should know" data-testid="input-child-medical-notes" />
                  </div>

                  <ContinueButton onClick={() => setStep("guardian")} disabled={!playerValid} testId="button-continue-player">Continue</ContinueButton>
                </div>
                <SummaryAside programme={programme} term={term} selectedOption={selectedOption} selectedQuote={selectedQuote} promo={promo} />
              </div>
            )}

            {step === "guardian" && selectedOption && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
                <div className="space-y-6 order-2 lg:order-1">
                  <div>
                    <h1 className="text-2xl sm:text-3xl font-bold mb-1" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>Parent / guardian</h1>
                    <p className="text-sm" style={{ color: BRAND.mute }}>Your receipt and confirmation go here.</p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label required>First name</Label>
                      <TextInput value={guardian.firstName} onChange={(e) => setGuardian((g) => ({ ...g, firstName: e.target.value }))} data-testid="input-guardian-first-name" />
                    </div>
                    <div>
                      <Label required>Last name</Label>
                      <TextInput value={guardian.lastName} onChange={(e) => setGuardian((g) => ({ ...g, lastName: e.target.value }))} data-testid="input-guardian-last-name" />
                    </div>
                  </div>

                  <div>
                    <Label required>Email</Label>
                    <TextInput type="email" value={guardian.email} onChange={(e) => setGuardian((g) => ({ ...g, email: e.target.value }))} data-testid="input-guardian-email" />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label required>Mobile</Label>
                      <TextInput type="tel" value={guardian.phone} onChange={(e) => setGuardian((g) => ({ ...g, phone: e.target.value }))} data-testid="input-guardian-phone" />
                    </div>
                    <div>
                      <Label>Alternate phone (optional)</Label>
                      <TextInput type="tel" value={guardian.alternatePhone} onChange={(e) => setGuardian((g) => ({ ...g, alternatePhone: e.target.value }))} data-testid="input-guardian-alt-phone" />
                    </div>
                  </div>

                  <div>
                    <Label required>Your relationship to the player</Label>
                    <TextInput value={guardian.relationship} onChange={(e) => setGuardian((g) => ({ ...g, relationship: e.target.value }))} placeholder="e.g. Mother, Father, Guardian" data-testid="input-guardian-relationship" />
                  </div>

                  <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${BRAND.line}` }}>
                    <NzfAddressFields
                      value={address}
                      onChange={setAddress}
                      countries={nzfCountries}
                      regions={nzfRegions}
                      theme={FIELD_THEME}
                    />
                  </div>

                  <div className="rounded-xl p-4 space-y-4" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${BRAND.line}` }}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <h2 className="text-sm font-bold uppercase tracking-wide" style={{ color: BRAND.white }}>Emergency contact</h2>
                      <button
                        type="button"
                        onClick={useSameAsGuardian}
                        disabled={!guardian.firstName.trim() || !guardian.lastName.trim() || !guardian.phone.trim()}
                        className="text-[12px] font-semibold underline disabled:opacity-30"
                        style={{ color: BRAND.goldBright }}
                      >
                        Same as parent/guardian
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label required>Name</Label>
                        <TextInput value={emergency.name} onChange={(e) => setEmergency((em) => ({ ...em, name: e.target.value }))} data-testid="input-emergency-name" />
                      </div>
                      <div>
                        <Label required>Phone</Label>
                        <TextInput type="tel" value={emergency.phone} onChange={(e) => setEmergency((em) => ({ ...em, phone: e.target.value }))} data-testid="input-emergency-phone" />
                      </div>
                    </div>
                  </div>

                  <ContinueButton onClick={() => setStep("consents")} disabled={!guardianValid} testId="button-continue-guardian">Continue</ContinueButton>
                </div>
                <SummaryAside programme={programme} term={term} selectedOption={selectedOption} selectedQuote={selectedQuote} promo={promo} />
              </div>
            )}

            {step === "consents" && selectedOption && (
              <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
                <div className="space-y-6 order-2 lg:order-1">
                  <div>
                    <h1 className="text-2xl sm:text-3xl font-bold mb-1" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>Consents</h1>
                    <p className="text-sm" style={{ color: BRAND.mute }}>The last step before payment.</p>
                  </div>

                  <div className="rounded-xl p-4 sm:p-5 space-y-5" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
                    <CheckboxRow checked={consents.policy} onChange={(v) => setConsents((c) => ({ ...c, policy: v }))} required testId="checkbox-consent-policy">
                      I accept the club's{" "}
                      <a href="https://cufc.co.nz/payment-policy" target="_blank" rel="noreferrer" className="underline font-semibold" style={{ color: BRAND.goldBright }}>
                        Membership &amp; Payment Policy
                      </a>{" "}and New Zealand Football's registration terms.
                    </CheckboxRow>
                    <CheckboxRow checked={consents.medical} onChange={(v) => setConsents((c) => ({ ...c, medical: v }))} required testId="checkbox-consent-medical">
                      I give permission for {child.firstName || "my child"} to receive emergency medical treatment if needed.
                    </CheckboxRow>
                    <CheckboxRow checked={consents.photo} onChange={(v) => setConsents((c) => ({ ...c, photo: v }))} testId="checkbox-consent-photo">
                      I'm happy for {child.firstName || "my child"} to appear in club photos and videos used for promotion (optional — you can change this anytime).
                    </CheckboxRow>
                    <CheckboxRow checked={consents.newsletter} onChange={(v) => setConsents((c) => ({ ...c, newsletter: v }))} testId="checkbox-consent-newsletter">
                      Keep me updated with club news and programme info by email.
                    </CheckboxRow>
                  </div>

                  <div>
                    <Label>Anything else we should know? (optional)</Label>
                    <TextareaInput value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-notes" />
                  </div>

                  {/* Promo code. The server re-derives the price when it charges,
                      so this preview can never become the amount taken. */}
                  <div className="rounded-2xl p-4" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
                    <Label>Discount code (optional)</Label>
                    <div className="flex gap-2">
                      <TextInput
                        value={discountCode}
                        onChange={(e) => { setDiscountCode(e.target.value.toUpperCase()); setPromo(null); setPromoError(null); }}
                        placeholder="Enter a code"
                        autoCapitalize="characters"
                        data-testid="input-discount-code"
                      />
                      <button
                        type="button"
                        onClick={applyDiscount}
                        disabled={!discountCode.trim() || promoChecking}
                        className="rounded-xl px-4 text-[13px] font-semibold min-h-[44px] flex-shrink-0 disabled:opacity-40"
                        style={{ background: "transparent", border: `1px solid ${BRAND.gold}`, color: BRAND.goldBright }}
                        data-testid="button-apply-discount"
                      >
                        {promoChecking ? "Checking…" : "Apply"}
                      </button>
                    </div>
                    {promoError && <p className="mt-2 text-[12px]" style={{ color: BRAND.red }}>{promoError}</p>}
                    {promo && (
                      <div
                        className="mt-3 flex items-center justify-between gap-2 rounded-xl px-3 py-2"
                        style={{ background: "rgba(212,175,55,0.10)", border: `1px solid ${BRAND.gold}` }}
                        data-testid="promo-applied"
                      >
                        <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: BRAND.goldBright }}>
                          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                          {promo.code} applied — {money(promo.promoCents)} off
                        </span>
                        <button
                          type="button"
                          onClick={() => { setPromo(null); setPromoError(null); setDiscountCode(""); }}
                          className="flex items-center justify-center w-9 h-9 rounded-lg flex-shrink-0"
                          style={{ color: BRAND.mute }}
                          aria-label={`Remove discount code ${promo.code}`}
                          data-testid="button-remove-discount"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {submitError && <ErrorBanner>{submitError}</ErrorBanner>}

                  <ContinueButton onClick={submitRegistration} disabled={!consentsValid || submitting} testId="button-continue-payment">
                    {submitting ? "Loading payment…" : "Continue to payment"}
                  </ContinueButton>
                </div>
                <SummaryAside programme={programme} term={term} selectedOption={selectedOption} selectedQuote={selectedQuote} promo={promo} />
              </div>
            )}

            {step === "payment" && registerResponse && (
              <div className="max-w-xl mx-auto">
                <h1 className="text-2xl sm:text-3xl font-bold mb-2" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>
                  Pay {money(registerResponse.quote.totalCents)}
                </h1>
                <p className="mb-6 text-sm" style={{ color: BRAND.mute }}>
                  {registerResponse.programme.name} — {registerResponse.option.name}. Receipt goes to {guardian.email}.
                </p>

                <div className="rounded-2xl p-5 mb-6 space-y-2" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
                  {registerResponse.quote.plan === "year" && registerResponse.quote.discountCents > 0 && (
                    <>
                      <div className="flex justify-between text-sm" style={{ color: BRAND.mute }}>
                        <span>4 terms</span><span className="font-mono line-through">{money(registerResponse.quote.subtotalCents)}</span>
                      </div>
                      <div className="flex justify-between text-sm" style={{ color: BRAND.goldBright }}>
                        <span>Full-year saving (5%)</span><span className="font-mono">−{money(registerResponse.quote.discountCents)}</span>
                      </div>
                    </>
                  )}
                  {(registerResponse.quote.promoCents ?? 0) > 0 && (
                    <div className="flex justify-between text-sm" style={{ color: BRAND.goldBright }}>
                      <span>Discount ({registerResponse.quote.discountCode})</span>
                      <span className="font-mono">−{money(registerResponse.quote.promoCents!)}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-bold pt-2" style={{ borderTop: `1px solid ${BRAND.line}` }}>
                    <span>Total</span><span style={{ color: BRAND.goldBright }}>{money(registerResponse.quote.totalCents)} NZD</span>
                  </div>
                </div>

                {!stripePromise ? (
                  <ErrorBanner>
                    Payment is temporarily unavailable. Please try again shortly, or email info@cufc.co.nz and we'll sort your registration.
                  </ErrorBanner>
                ) : (
                  <Elements
                    stripe={stripePromise}
                    options={{
                      clientSecret: registerResponse.clientSecret,
                      appearance: {
                        theme: "night",
                        variables: {
                          colorPrimary: BRAND.gold,
                          colorBackground: BRAND.ink,
                          colorText: "#ffffff",
                          colorTextSecondary: "rgba(255,255,255,0.7)",
                          colorTextPlaceholder: "rgba(255,255,255,0.45)",
                          colorIcon: "rgba(255,255,255,0.7)",
                          colorDanger: "#ef4444",
                          fontFamily: "Inter, system-ui, sans-serif",
                          spacingUnit: "4px",
                          borderRadius: "12px",
                          fontSizeBase: "15px",
                        },
                        rules: {
                          ".Input": { border: `1px solid ${BRAND.line}`, backgroundColor: BRAND.navy, color: "#ffffff" },
                          ".Input:focus": { border: `1px solid ${BRAND.gold}`, boxShadow: `0 0 0 1px ${BRAND.gold}` },
                          ".Input::placeholder": { color: "rgba(255,255,255,0.4)" },
                          ".Label": { color: "rgba(255,255,255,0.7)", fontWeight: "500" },
                          ".Tab": { border: `1px solid ${BRAND.line}`, backgroundColor: BRAND.navy, color: "#ffffff" },
                          ".Tab:hover": { color: "#ffffff" },
                          ".Tab--selected": { border: `1px solid ${BRAND.gold}`, color: "#ffffff" },
                          ".TabLabel": { color: "#ffffff" },
                        },
                      },
                    }}
                  >
                    <PaymentForm
                      reg={registerResponse}
                      guardianEmail={guardian.email}
                      guardianName={`${guardian.firstName} ${guardian.lastName}`.trim()}
                      onSuccess={() => setPaymentSucceeded(true)}
                      onError={(msg) => setSubmitError(msg)}
                    />
                  </Elements>
                )}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── Step 1: choose option + plan ────────────────────────────────────────

function ChooseStep({
  programme, term, quotes, selectedOptionId, setSelectedOptionId, plan, setPlan, selectedOption, selectedQuote, onContinue, disabled,
}: {
  programme: Programme;
  term: TermInfo | null;
  quotes: Quote[];
  selectedOptionId: number | null;
  setSelectedOptionId: (id: number) => void;
  plan: AcademyPaymentPlan;
  setPlan: (p: AcademyPaymentPlan) => void;
  selectedOption: ProgrammeOption | null;
  selectedQuote: Quote | null;
  onContinue: () => void;
  disabled: boolean;
}) {
  const ageBand =
    programme.ageMin != null && programme.ageMax != null ? `U${programme.ageMin}–U${programme.ageMax}`
      : programme.ageMin != null ? `U${programme.ageMin}+`
      : programme.ageMax != null ? `Up to U${programme.ageMax}`
      : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
      <div className="space-y-6 order-2 lg:order-1">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.28em] mb-3" style={{ color: BRAND.gold }}>
            {programme.section === "core" ? "Academy Pathway" : "Programme Add-on"}
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold mb-3" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>{programme.name}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] mb-3" style={{ color: BRAND.mute }}>
            {ageBand && <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> {ageBand}</span>}
            {programme.location && <span className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" /> {programme.location}</span>}
            {term && <span>{term.name ?? `Term ${term.termNumber}`} {term.year}</span>}
          </div>
          {(programme.descriptionShort || programme.description) && (
            <p className="text-[15px] leading-relaxed" style={{ color: "rgba(255,255,255,0.8)" }}>{programme.descriptionShort || programme.description}</p>
          )}
          {typeof programme.spotsRemaining === "number" && (
            <p className="mt-2 text-[13px] font-semibold" style={{ color: programme.spotsRemaining <= 5 ? BRAND.red : BRAND.goldBright }}>
              {programme.spotsRemaining} spot{programme.spotsRemaining === 1 ? "" : "s"} remaining
            </p>
          )}
        </div>

        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: BRAND.white }}>Choose your option</h2>
          <div className="space-y-3">
            {programme.options.map((opt) => {
              const q = quotes.find((qq) => qq.optionId === opt.id && qq.plan === "term");
              const isSelected = selectedOptionId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSelectedOptionId(opt.id)}
                  data-testid={`option-${opt.id}`}
                  className="w-full text-left rounded-xl p-4 sm:p-5 transition"
                  style={{
                    border: `1px solid ${isSelected ? BRAND.gold : BRAND.line}`,
                    background: isSelected ? "rgba(212,175,55,0.08)" : BRAND.ink,
                  }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-[16px]">{opt.name}</div>
                      {opt.scheduleText && <div className="text-sm mt-0.5" style={{ color: BRAND.mute }}>{opt.scheduleText}</div>}
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-xl font-bold" style={{ color: isSelected ? BRAND.goldBright : BRAND.white }}>{money((q?.totalCents ?? opt.termPriceCents))}</div>
                      <div className="text-[10px]" style={{ color: BRAND.mute }}>/term</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {selectedOptionId && programme.allowFullYear && (
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wide mb-3" style={{ color: BRAND.white }}>How would you like to pay?</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(["term", "year"] as AcademyPaymentPlan[]).map((p) => {
                const q = quotes.find((qq) => qq.optionId === selectedOptionId && qq.plan === p);
                const isSelected = plan === p;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlan(p)}
                    data-testid={`plan-${p}`}
                    className="text-left rounded-xl p-4 transition min-h-[44px]"
                    style={{ border: `1px solid ${isSelected ? BRAND.gold : BRAND.line}`, background: isSelected ? "rgba(212,175,55,0.08)" : BRAND.ink }}
                  >
                    <div className="font-bold text-[15px]">{p === "term" ? "Pay per term" : "Pay for the full year"}</div>
                    {q && (
                      <div className="mt-1">
                        <span className="font-mono text-[15px]" style={{ color: isSelected ? BRAND.goldBright : BRAND.white }}>{money(q.totalCents)}</span>
                        {/* Mid-term join: strike the full term fee so the parent can
                            see they are only paying for the sessions that are left.
                            An unexplained lower price reads as an error. */}
                        {p === "term" && q.discountCents > 0 && (
                          <span className="ml-2 font-mono text-[12px] line-through" style={{ color: BRAND.mute }}>{money(q.subtotalCents)}</span>
                        )}
                        {p === "year" && q.discountCents > 0 && (
                          <span className="ml-2 text-[12px] font-semibold" style={{ color: BRAND.goldBright }}>save {money(q.discountCents)} (5%)</span>
                        )}
                      </div>
                    )}
                    {p === "term" && q?.sessionsRemaining != null && q.totalSessions != null && q.sessionsRemaining < q.totalSessions && (
                      <div className="mt-1.5 text-[12px] leading-snug" style={{ color: BRAND.goldBright }}>
                        {q.sessionsRemaining} of {q.totalSessions} sessions left — you only pay for what's left
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <ContinueButton onClick={onContinue} disabled={disabled} testId="button-continue-choose">Continue</ContinueButton>
      </div>

      <SummaryAside programme={programme} term={term} selectedOption={selectedOption} selectedQuote={selectedQuote} />
    </div>
  );
}

// ── Shared price summary sidebar (never fixed-position — can't cover a CTA) ─

function SummaryAside({
  programme, term, selectedOption, selectedQuote, promo,
}: {
  programme: Programme; term: TermInfo | null;
  selectedOption: ProgrammeOption | null; selectedQuote: Quote | null;
  promo?: AppliedPromo | null;
}) {
  // Belt and braces: a promo is only ever drawn against the exact total it was
  // quoted on. If they disagree, the code is stale — show the undiscounted
  // price rather than a number the server would refuse to charge.
  const promoActive = !!promo && !!selectedQuote && promo.wasCents === selectedQuote.totalCents;
  const totalCents = promoActive ? promo!.totalCents : selectedQuote?.totalCents ?? 0;

  return (
    <aside className="order-1 lg:order-2 lg:sticky lg:top-20 lg:self-start">
      <div className="rounded-2xl p-5" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
        <div className="text-[10px] uppercase tracking-[0.14em] font-bold mb-2" style={{ color: BRAND.mute }}>Your registration</div>
        <div className="font-bold" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>{programme.name}</div>
        {selectedOption && (
          <div className="text-sm mt-0.5" style={{ color: BRAND.mute }}>
            {selectedOption.name}{selectedOption.scheduleText ? ` · ${selectedOption.scheduleText}` : ""}
          </div>
        )}
        {term && <div className="text-[12px] mt-1" style={{ color: BRAND.mute }}>{term.name ?? `Term ${term.termNumber}`} {term.year}</div>}

        {selectedQuote && (
          <div className="mt-4 pt-4 space-y-1.5 text-sm" style={{ borderTop: `1px solid ${BRAND.line}` }}>
            {selectedQuote.plan === "year" && selectedQuote.discountCents > 0 && (
              <>
                <div className="flex justify-between" style={{ color: BRAND.mute }}>
                  <span>4 terms</span><span className="font-mono line-through">{money(selectedQuote.subtotalCents)}</span>
                </div>
                <div className="flex justify-between" style={{ color: BRAND.goldBright }}>
                  <span>Full-year saving (5%)</span><span className="font-mono">−{money(selectedQuote.discountCents)}</span>
                </div>
              </>
            )}
            {promoActive && (
              <>
                <div className="flex justify-between" style={{ color: BRAND.mute }}>
                  <span>Subtotal</span>
                  <span className="font-mono line-through">{money(selectedQuote.totalCents)}</span>
                </div>
                <div className="flex justify-between" style={{ color: BRAND.goldBright }} data-testid="summary-promo-line">
                  <span className="flex items-center gap-1.5"><Tag className="w-3.5 h-3.5" />{promo!.code}</span>
                  <span className="font-mono">−{money(promo!.promoCents)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between font-bold text-base pt-2" style={{ borderTop: `1px solid ${BRAND.line}` }}>
              <span>{selectedQuote.plan === "year" ? "Total (full year)" : "Total (this term)"}</span>
              <span className="font-mono" style={{ color: BRAND.goldBright }} data-testid="summary-total">{money(totalCents)}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Success panel — in-page confirmation, never navigates off-domain ───────

function SuccessPanel({
  title, body, details, footnote,
}: { title: string; body: string; details?: { label: string; value: string }[]; footnote?: string }) {
  return (
    <div className="max-w-md mx-auto text-center space-y-6 py-6">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: "rgba(212,175,55,0.14)" }}>
        <CheckCircle2 className="w-8 h-8" style={{ color: BRAND.goldBright }} />
      </div>
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold" style={{ fontFamily: FONT_DISPLAY, textTransform: "uppercase" }}>{title}</h1>
        <p className="mt-2 text-sm" style={{ color: BRAND.mute }}>{body}</p>
      </div>

      {details && details.length > 0 && (
        <div className="rounded-2xl p-5 text-left space-y-2" style={{ background: BRAND.ink, border: `1px solid ${BRAND.line}` }}>
          {details.map((d) => (
            <div key={d.label} className="flex justify-between text-sm">
              <span style={{ color: BRAND.mute }}>{d.label}</span>
              <span className="font-semibold">{d.value}</span>
            </div>
          ))}
        </div>
      )}

      {footnote && (
        <div className="rounded-2xl p-4 text-left flex items-start gap-3" style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${BRAND.line}` }}>
          <Mail className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: BRAND.goldBright }} />
          <p className="text-sm" style={{ color: BRAND.mute }}>{footnote}</p>
        </div>
      )}

      <a href="https://cufc.co.nz" className="inline-block w-full py-3.5 rounded-full font-bold min-h-[52px]" style={{ background: BRAND.gold, color: BRAND.navy }}>
        Back to cufc.co.nz
      </a>
    </div>
  );
}

/**
 * Club Events — the public ticket page (join.cufc.co.nz/events/{slug}).
 *
 * Opened from cufc.co.nz/dinner, a board at the ground, or a flyer, on a phone.
 * The details are the event's own row in ClubOS, so a price or a time changes
 * without a deploy. The card form is Stripe's embedded PaymentElement on OUR
 * page — never a redirect. The amount is decided by the server; the browser
 * sends a quantity and who is coming.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { CalendarDays, MapPin, Users, Minus, Plus, Lock, Loader2, CheckCircle2, Clock, ShieldCheck } from "lucide-react";
import { clubEventBrand, dollars, nzLongDate, nzClock, nzShortDate } from "@shared/club-events";
import { getFbp, getFbc, trackEvent } from "@/lib/meta-pixel";
import { TeampayShell, Card, Button, Field, inputStyle, Notice, Loading, NotFoundPage } from "../teampay/shell";

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.message || "Something went wrong."), { status: r.status, body });
  return body;
};

type Guest = { fullName: string; dietary: string };

/** Stripe.js, loaded once per publishable key. The API says which account. */
const stripeCache = new Map<string, Promise<StripeJs | null>>();
function stripeFor(pk: string | null | undefined): Promise<StripeJs | null> | null {
  const key = pk || (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY || "";
  if (!key) return null;
  if (!stripeCache.has(key)) stripeCache.set(key, loadStripe(key));
  return stripeCache.get(key)!;
}

export default function ClubEventPage() {
  const [, params] = useRoute("/events/:slug");
  const slug = params?.slug || "";
  const { data, isLoading, isError } = useQuery<any>({
    queryKey: ["club-event", slug],
    queryFn: () => api(`/api/public/club-events/${slug}`),
    enabled: !!slug,
    retry: false,
  });
  const brand = useMemo(() => clubEventBrand(data?.event?.brand), [data?.event?.brand]);

  // Oswald is the club's display face; Team Pay's shell loads the others.
  useEffect(() => {
    const id = "club-events-fonts";
    if (document.getElementById(id)) return;
    const l = document.createElement("link");
    l.id = id; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
  }, []);
  useEffect(() => { if (data?.event?.name) document.title = `${data.event.name} — ${data.event.siteName}`; }, [data?.event?.name, data?.event?.siteName]);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !data) return <NotFoundPage brand={brand} />;

  const ev = data.event;
  const when = `${nzLongDate(ev.startsAt)}`;
  const time = `${nzClock(ev.startsAt)}${ev.endsAt ? ` to ${nzClock(ev.endsAt)}` : ""}`;

  return (
    <TeampayShell brand={brand} wide>
      {/* ── hero ── */}
      <header className="mb-8 sm:mb-10">
        <div className="flex items-center gap-3">
          <img src={brand.crest} alt="" width={44} height={44} className="h-11 w-11 object-contain" />
          <div className="text-[11px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.16em" }}>
            {ev.siteName}
          </div>
        </div>
        <h1 className="mt-4 text-[36px] leading-[1.02] sm:text-[52px]" style={{ fontFamily: brand.fontHeading, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.01em" }}>
          {ev.name}
        </h1>
        <p className="mt-3 text-[16px] sm:text-[18px]" style={{ color: brand.ink }}>
          <span className="font-semibold">{when}</span>
          <span style={{ color: brand.mute }}> · {time}</span>
        </p>
        {ev.tagline && <p className="mt-2 max-w-2xl text-[15px] leading-relaxed" style={{ color: brand.mute }}>{ev.tagline}</p>}
      </header>

      <div className="grid gap-6 md:grid-cols-[1fr_400px] md:items-start">
        {/* ── details ── */}
        <div className="space-y-5 md:order-1">
          <Card brand={brand} className="p-5 sm:p-6">
            <dl className="grid gap-4 sm:grid-cols-3">
              <Fact brand={brand} icon={<CalendarDays size={16} />} label="When" value={<>{when}<br /><span style={{ color: brand.mute }}>{time}</span></>} />
              <Fact brand={brand} icon={<MapPin size={16} />} label="Where" value={<>{ev.venueName}{ev.venueAddress && <><br /><span style={{ color: brand.mute }}>{ev.venueAddress}</span></>}</>} />
              <Fact brand={brand} icon={<Users size={16} />} label="Seating" value={<>Tables of {ev.tableSize}{ev.ageRestriction && <><br /><span style={{ color: brand.mute }}>{ev.ageRestriction} only</span></>}</>} />
            </dl>
          </Card>

          {Array.isArray(ev.includes) && ev.includes.length > 0 && (
            <Card brand={brand} className="p-5 sm:p-6">
              <h2 className="text-[13px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.14em" }}>On the night</h2>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {ev.includes.map((line: string, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-[15px] leading-snug">
                    <CheckCircle2 size={16} className="mt-[3px] flex-none" style={{ color: brand.accent }} />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {ev.description && (
            <Card brand={brand} className="p-5 sm:p-6">
              {String(ev.description).split(/\n\s*\n/).map((p: string, i: number) => (
                <p key={i} className={`text-[15px] leading-relaxed ${i ? "mt-4" : ""}`} style={{ color: "#DCE2F5" }}>{p}</p>
              ))}
            </Card>
          )}

          {(data.pricing?.allTypes?.length > 1) && (
            <Card brand={brand} className="p-5 sm:p-6">
              <h2 className="text-[13px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.14em" }}>Ticket prices</h2>
              <ul className="mt-3 divide-y" style={{ borderColor: brand.line }}>
                {data.pricing.allTypes.map((t: any, i: number) => (
                  <li key={i} className="flex items-baseline justify-between py-2.5 text-[15px]" style={{ borderColor: brand.line }}>
                    <span>{t.name}<span style={{ color: brand.mute }}>{windowLabel(t)}</span></span>
                    <span className="font-semibold" style={{ fontFamily: brand.fontHeading, fontSize: 18 }}>{dollars(t.priceCents)}<span className="text-[12px] font-normal" style={{ color: brand.mute }}> pp</span></span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {ev.contactEmail && (
            <p className="px-1 text-[13px]" style={{ color: brand.mute }}>
              Questions, or a lot to donate for the auction? Email <a href={`mailto:${ev.contactEmail}`} className="underline" style={{ color: brand.ink }}>{ev.contactEmail}</a>.
            </p>
          )}
        </div>

        {/* ── tickets ── */}
        <div className="md:sticky md:top-6 md:order-2">
          <TicketCard brand={brand} slug={slug} data={data} />
        </div>
      </div>
    </TeampayShell>
  );
}

function windowLabel(t: { salesStart?: string | null; salesEnd?: string | null }): string {
  if (t.salesEnd) return ` · until ${nzShortDate(t.salesEnd)}`;
  if (t.salesStart) return ` · from ${nzShortDate(t.salesStart)}`;
  return "";
}

function Fact({ brand, icon, label, value }: { brand: any; icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.12em" }}>{icon}{label}</dt>
      <dd className="mt-1.5 text-[15px] leading-snug">{value}</dd>
    </div>
  );
}

// ── the purchase ─────────────────────────────────────────────────────────────
function TicketCard({ brand, slug, data }: { brand: any; slug: string; data: any }) {
  const ev = data.event;
  const pricing = data.pricing;
  const current = pricing?.current;
  const next = pricing?.next;

  const [qty, setQty] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [tableName, setTableName] = useState("");
  const [showGuests, setShowGuests] = useState(false);
  const [guests, setGuests] = useState<Guest[]>([{ fullName: "", dietary: "" }]);
  const [ageOk, setAgeOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intent, setIntent] = useState<{ clientSecret: string | null; orderToken: string; ref: string; amountCents: number; publishableKey: string | null } | null>(null);
  const [paidRef, setPaidRef] = useState<string | null>(null);
  // The pending order from a previous attempt — a retry reuses it instead of
  // holding a second block of seats.
  const [heldToken, setHeldToken] = useState<string | null>(null);

  useEffect(() => {
    setGuests((g) => {
      const out = g.slice(0, qty);
      while (out.length < qty) out.push({ fullName: "", dietary: "" });
      return out;
    });
  }, [qty]);

  const stripePromise = useMemo(() => stripeFor(intent?.publishableKey), [intent?.publishableKey]);

  const total = (current?.priceCents ?? 0) * qty;
  const max = Math.max(1, Math.min(50, ev.maxPerOrder || 10));

  if (paidRef) {
    return (
      <Card brand={brand} className="p-6 text-center">
        <CheckCircle2 size={40} className="mx-auto" style={{ color: "#34C759" }} />
        <h2 className="mt-3 text-[26px]" style={{ fontFamily: brand.fontHeading, fontWeight: 700 }}>You're in</h2>
        <div className="mt-3 rounded-xl px-4 py-3" style={{ border: `1px solid ${brand.accent}` }}>
          <div className="text-[11px] uppercase" style={{ color: brand.mute, letterSpacing: "0.14em" }}>Ticket number</div>
          <div className="mt-1 text-[24px] font-bold" style={{ color: brand.accent, letterSpacing: "0.04em" }}>{paidRef}</div>
        </div>
        <p className="mt-4 text-[14px] leading-relaxed" style={{ color: brand.mute }}>
          We've emailed your ticket to <span style={{ color: brand.ink }}>{email}</span>. Show it on your phone at the door, or just give your name.
        </p>
        {intent?.orderToken && (
          <a href={`/events/${slug}/order/${intent.orderToken}`} className="mt-5 inline-flex min-h-[44px] items-center justify-center rounded-full px-5 font-semibold" style={{ background: brand.accent, color: brand.onAccent }}>
            Add guest names
          </a>
        )}
      </Card>
    );
  }

  if (!data.selling) {
    return (
      <Card brand={brand} className="p-6">
        <h2 className="text-[22px]" style={{ fontFamily: brand.fontHeading, fontWeight: 700 }}>
          {data.soldOut ? "Sold out" : ev.status === "closed" ? "Ticket sales have closed" : next ? `Tickets open ${nzShortDate(next.salesStart)}` : "Tickets aren't on sale yet"}
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed" style={{ color: brand.mute }}>
          {data.soldOut ? "Every seat has gone." : "Check back soon."}{ev.contactEmail ? <> Questions: <a className="underline" href={`mailto:${ev.contactEmail}`}>{ev.contactEmail}</a>.</> : null}
        </p>
      </Card>
    );
  }

  // ── step 2: pay ──
  if (intent && intent.clientSecret) {
    return (
      <Card brand={brand} className="p-5 sm:p-6">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[11px] uppercase" style={{ color: brand.accent, letterSpacing: "0.14em" }}>Pay</div>
            <div className="mt-1 text-[15px]">{qty} × {dollars(current?.priceCents)} · {current?.name}</div>
          </div>
          <div className="text-[28px] font-bold" style={{ fontFamily: brand.fontHeading }}>{dollars(intent.amountCents)}</div>
        </div>
        <div className="mt-4">
          {stripePromise ? (
            <Elements
              stripe={stripePromise}
              options={{
                clientSecret: intent.clientSecret,
                appearance: {
                  theme: "night",
                  variables: { colorPrimary: brand.accent, colorBackground: brand.bg, colorText: brand.ink, colorTextPlaceholder: brand.mute, colorDanger: "#FF6961", fontFamily: "Inter, system-ui, sans-serif", borderRadius: "10px" },
                },
              }}
            >
              <PayForm brand={brand} slug={slug} orderToken={intent.orderToken} amountCents={intent.amountCents} onPaid={(ref) => { trackEvent("Purchase", { value: intent.amountCents / 100, currency: "NZD", content_name: ev.name }); setPaidRef(ref); }} />
            </Elements>
          ) : (
            <Notice brand={brand} tone="error">Card payment isn't available right now. Please contact the club.</Notice>
          )}
        </div>
        <button type="button" onClick={() => setIntent(null)} className="mt-4 min-h-[44px] w-full text-[13px] underline" style={{ color: brand.mute }}>Back to your details</button>
        {ev.paymentNote && <p className="mt-3 text-[12px]" style={{ color: brand.mute }}>{ev.paymentNote}</p>}
      </Card>
    );
  }

  // ── step 1: details ──
  const submit = async () => {
    setError(null);
    if (name.trim().length < 2) return setError("Please enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Please enter a valid email — your ticket is sent there.");
    if (phone.replace(/\D/g, "").length < 7) return setError("Please enter a phone number.");
    if (ev.ageRestriction && !ageOk) return setError(`Please confirm everyone attending is ${ev.ageRestriction}.`);
    setBusy(true);
    try {
      const source = new URLSearchParams(window.location.search).get("source") || null;
      const r = await api(`/api/public/club-events/${slug}/intent`, {
        method: "POST",
        body: JSON.stringify({
          quantity: qty, buyerName: name.trim(), buyerEmail: email.trim(), buyerPhone: phone.trim(),
          tableName: tableName.trim() || null, guests: showGuests ? guests : [],
          ageConfirmed: ev.ageRestriction ? ageOk : true,
          orderToken: heldToken ?? undefined,
          source, sourceUrl: window.location.href, fbp: getFbp(), fbc: getFbc(),
        }),
      });
      trackEvent("InitiateCheckout", { value: r.amountCents / 100, currency: "NZD", content_name: ev.name, num_items: qty });
      setHeldToken(r.orderToken);
      // A free ticket has no card step: the server marked it paid already.
      if (!r.clientSecret) setPaidRef(r.ref);
      else setIntent(r);
    } catch (e: any) {
      if (e?.body?.alreadyPaid) setError("That booking is already paid — check your email for the ticket.");
      else setError(e.message);
    }
    setBusy(false);
  };

  return (
    <Card brand={brand} className="p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.14em" }}>{current.name}</div>
          <div className="mt-1 text-[13px]" style={{ color: brand.mute }}>
            {current.salesEnd ? `Until ${nzShortDate(current.salesEnd)}` : "Per person"}
            {next ? `, then ${dollars(next.priceCents)}` : ""}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[34px] font-bold leading-none" style={{ fontFamily: brand.fontHeading }}>{dollars(current.priceCents)}</div>
          <div className="text-[12px]" style={{ color: brand.mute }}>per person</div>
        </div>
      </div>
      {data.seatsLeft != null && data.seatsLeft <= 30 && (
        <div className="mt-3 text-[13px] font-medium" style={{ color: brand.accent }}>{data.seatsLeft} {data.seatsLeft === 1 ? "seat" : "seats"} left</div>
      )}

      <div className="mt-5 space-y-4">
        <Field brand={brand} label="How many tickets" hint={`Tables of ${ev.tableSize}. Book ${ev.tableSize} and you have a table.`}>
          <div className="flex items-center gap-3">
            <button type="button" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))} className="flex h-11 w-11 items-center justify-center rounded-full" style={{ border: `1px solid ${brand.line}` }}><Minus size={16} /></button>
            <div className="min-w-[44px] text-center text-[24px] font-bold" style={{ fontFamily: brand.fontHeading }}>{qty}</div>
            <button type="button" aria-label="More" onClick={() => setQty((q) => Math.min(max, q + 1))} className="flex h-11 w-11 items-center justify-center rounded-full" style={{ border: `1px solid ${brand.line}` }}><Plus size={16} /></button>
            <div className="ml-auto text-right">
              <div className="text-[11px] uppercase" style={{ color: brand.mute, letterSpacing: "0.1em" }}>Total</div>
              <div className="text-[20px] font-bold" style={{ fontFamily: brand.fontHeading }}>{dollars(total)}</div>
            </div>
          </div>
        </Field>

        <Field brand={brand} label="Your name">
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" style={inputStyle(brand)} className="min-h-[44px] w-full" />
        </Field>
        <Field brand={brand} label="Email" hint="Your ticket is sent here.">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email" autoComplete="email" style={inputStyle(brand)} className="min-h-[44px] w-full" />
        </Field>
        <Field brand={brand} label="Mobile">
          <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" inputMode="tel" autoComplete="tel" style={inputStyle(brand)} className="min-h-[44px] w-full" />
        </Field>
        <Field brand={brand} label="Sit us with (optional)" hint="A table name, so your group is seated together. Team managers: name your team's table and share it.">
          <input value={tableName} onChange={(e) => setTableName(e.target.value)} placeholder="e.g. U12 Blues parents" style={inputStyle(brand)} className="min-h-[44px] w-full" />
        </Field>

        {!showGuests ? (
          <button type="button" onClick={() => setShowGuests(true)} className="min-h-[44px] text-left text-[13px] underline" style={{ color: brand.mute }}>
            Add guest names and dietary requirements now (you can also do this later)
          </button>
        ) : (
          <div className="space-y-3 rounded-xl p-3" style={{ border: `1px solid ${brand.line}` }}>
            <div className="text-[12px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.12em" }}>Guests</div>
            {guests.map((g, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-2">
                <input value={g.fullName} onChange={(e) => setGuests((gs) => gs.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} placeholder={`Guest ${i + 1} name`} style={inputStyle(brand)} className="min-h-[44px] w-full" />
                <input value={g.dietary} onChange={(e) => setGuests((gs) => gs.map((x, j) => (j === i ? { ...x, dietary: e.target.value } : x)))} placeholder="Dietary (optional)" style={inputStyle(brand)} className="min-h-[44px] w-full" />
              </div>
            ))}
          </div>
        )}

        {ev.ageRestriction && (
          <label className="flex min-h-[44px] cursor-pointer items-start gap-3 text-[14px]">
            <input type="checkbox" checked={ageOk} onChange={(e) => setAgeOk(e.target.checked)} className="mt-1 h-5 w-5 flex-none accent-[#D4AF37]" />
            <span>Everyone attending is {ev.ageRestriction}. This is a strict rule on the night.</span>
          </label>
        )}

        {error && <Notice brand={brand} tone="error">{error}</Notice>}

        <Button brand={brand} onClick={submit} disabled={busy} className="w-full">
          {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : <Lock size={15} className="mr-2" />}
          Continue to payment · {dollars(total)}
        </Button>
        <p className="flex items-center justify-center gap-1.5 text-[12px]" style={{ color: brand.mute }}>
          <ShieldCheck size={13} /> Card payment on this page, processed by Stripe.
        </p>
      </div>
    </Card>
  );
}

function PayForm({ brand, slug, orderToken, amountCents, onPaid }: { brand: any; slug: string; orderToken: string; amountCents: number; onPaid: (ref: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!stripe || !elements) return;
    setBusy(true); setError(null);
    const { error: err } = await stripe.confirmPayment({ elements, redirect: "if_required", confirmParams: { return_url: window.location.href } });
    if (err) { setError(err.message || "That card was declined. Try another one."); setBusy(false); return; }
    // 🔴 Our server asks Stripe. The browser saying "it worked" is not evidence.
    try {
      const r = await api(`/api/public/club-events/order/${orderToken}/confirm`, { method: "POST" });
      if (r.paid) onPaid(r.ref);
      else setError("Your bank is still processing that. Give it a moment and press Pay again.");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div>
      <PaymentElement options={{ layout: "tabs" }} />
      {error && <div className="mt-4"><Notice brand={brand} tone="error">{error}</Notice></div>}
      <div className="mt-5">
        <Button brand={brand} onClick={submit} disabled={!stripe || busy} className="w-full">
          {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : <Lock size={15} className="mr-2" />}
          Pay {dollars(amountCents)}
        </Button>
      </div>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px]" style={{ color: brand.mute }}><Clock size={12} /> Your seats are held while you pay.</p>
      <span className="hidden">{slug}</span>
    </div>
  );
}

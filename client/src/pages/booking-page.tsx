import { useState, useEffect, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useRoute, Link, useLocation } from "wouter";
import { ArrowLeft, Plus, X, User, Calendar, CreditCard, ShieldCheck, Clock, ArrowRight, CheckCircle, Lock, Sparkles, Heart, Tag } from "lucide-react";
import { trackEvent, getFbp, getFbc, generateEventId } from "@/lib/meta-pixel";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { brandForOrg, type CampBrand } from "@/lib/camp-brand";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

interface ChildData {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  allergies: string;
  epiPen: boolean;
  medicalNotes: string;
}

interface BookingItem {
  childIndex: number;
  campDateId: number;
  productType: string;
  dateName: string;
}

const sessionTypes: Record<string, { label: string; time: string }> = {
  MORNING: { label: "Morning", time: "9am–12pm" },
  AFTERNOON: { label: "Afternoon", time: "12pm–3pm" },
  FULL_DAY: { label: "Full Day", time: "9am–3pm" },
};

const hardcodedPrices: Record<string, number> = {
  MORNING: 3000,
  AFTERNOON: 3000,
  FULL_DAY: 5000,
};

function StripePay({ clientSecret, slug, registrationId, totalCents, parentEmail, parentName, campName, itemCount, currency, brand }: {
  clientSecret: string;
  slug: string;
  registrationId: number;
  totalCents: number;
  parentEmail: string;
  parentName: string;
  campName: string;
  itemCount: number;
  currency: string;
  brand: CampBrand;
}) {
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: {
          theme: "stripe",
          variables: {
            colorPrimary: brand.primary,
            colorBackground: "#ffffff",
            colorText: "#1e293b",
            colorDanger: "#ef4444",
            fontFamily: "'Inter Tight', system-ui, -apple-system, sans-serif",
            spacingUnit: "4px",
            borderRadius: "12px",
            fontSizeBase: "14px",
          },
          rules: {
            ".Input": { border: "1px solid #e2e8f0", boxShadow: "none", padding: "12px 14px" },
            ".Input:focus": { border: `1px solid ${brand.primary}80`, boxShadow: `0 0 0 3px ${brand.primary}15` },
            ".Label": { fontSize: "13px", fontWeight: "500", color: "#64748b", marginBottom: "6px" },
            ".Tab": { border: "1px solid #e2e8f0", borderRadius: "12px" },
            ".Tab--selected": { border: `2px solid ${brand.primary}`, backgroundColor: `${brand.primary}08` },
          },
        },
      }}
    >
      <PaymentFormInner
        slug={slug}
        registrationId={registrationId}
        totalCents={totalCents}
        parentEmail={parentEmail}
        parentName={parentName}
        campName={campName}
        itemCount={itemCount}
        currency={currency}
        brand={brand}
      />
    </Elements>
  );
}

function PaymentFormInner({ slug, registrationId, totalCents, parentEmail, parentName, campName, itemCount, currency, brand }: {
  slug: string;
  registrationId: number;
  totalCents: number;
  parentEmail: string;
  parentName: string;
  campName: string;
  itemCount: number;
  currency: string;
  brand: CampBrand;
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

    const returnUrl = `${window.location.protocol}//${window.location.host}/${slug}/feedback?registrationId=${registrationId}`;

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl, receipt_email: parentEmail },
      redirect: "if_required",
    });

    if (stripeError) {
      setError(stripeError.message || "Payment failed. Please try again.");
      setProcessing(false);
      return;
    }

    if (paymentIntent) {
      if (paymentIntent.status === "succeeded") {
        try {
          await fetch("/api/public/confirm-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ registrationId, paymentIntentId: paymentIntent.id }),
          });
        } catch {}

        const eventId = generateEventId();
        trackEvent("Purchase", {
          value: totalCents / 100,
          currency,
          content_name: campName,
          content_ids: [String(registrationId)],
          num_items: itemCount,
        }, eventId);

        try {
          const sv = (window as any)._cufc_split_variants;
          if (sv) {
            for (const field of Object.keys(sv)) {
              if (sv[field]?.id) {
                fetch("/api/public/split-test/conversion", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ variantId: sv[field].id, revenue: totalCents }),
                }).catch(() => {});
              }
            }
          }
        } catch {}

        setLocation(`/${slug}/feedback?registrationId=${registrationId}`);
      } else if (paymentIntent.status === "processing") {
        setLocation(`/${slug}/feedback?registrationId=${registrationId}`);
      } else {
        setError("Payment could not be processed. Please try a different payment method.");
        setProcessing(false);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <PaymentElement
          options={{
            layout: "tabs",
            defaultValues: { billingDetails: { email: parentEmail, name: parentName } },
          }}
        />
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-[13px] text-red-700" data-testid="text-payment-error">
          {error}
        </div>
      )}

      <Button
        type="submit"
        disabled={!stripe || processing}
        className="w-full border-0 rounded-xl h-14 text-[16px] font-bold shadow-lg transition-all text-white cursor-pointer"
        style={{ background: brand.primary, boxShadow: `0 8px 24px ${brand.primary}30` }}
        data-testid="button-pay"
      >
        <Lock className="w-4 h-4 mr-2" />
        {processing ? "Processing payment..." : `Pay ${formatCurrency(totalCents, { fromCents: true })} NZD`}
      </Button>

      <div className="flex items-center justify-center gap-6 text-[11px] text-slate-400 pt-1">
        <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> SSL Encrypted</span>
        <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Powered by Stripe</span>
      </div>
    </form>
  );
}

export default function BookingPage() {
  const [, params] = useRoute("/:slug/book");
  const slug = params?.slug || "";
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState(1);

  const [items, setItems] = useState<BookingItem[]>([]);

  const [parentFirst, setParentFirst] = useState("");
  const [parentLast, setParentLast] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentPhone, setParentPhone] = useState("");

  const [children, setChildren] = useState<ChildData[]>([{
    firstName: "", lastName: "", dateOfBirth: "", allergies: "", epiPen: false, medicalNotes: "",
  }]);

  const [bookingResult, setBookingResult] = useState<any>(null);
  const [checkoutData, setCheckoutData] = useState<any>(null);
  const [promoCode, setPromoCode] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<{ id: number; code: string; type: string; valueType: string; value: string; title: string } | null>(null);
  const [promoError, setPromoError] = useState("");
  const [promoLoading, setPromoLoading] = useState(false);

  const { data, isLoading } = useQuery<{ camp: any; organization?: { slug: string; name: string; logoUrl: string | null }; pricing: any[]; dates: any[]; discounts: any[] }>({
    queryKey: ["/api/public/camps", slug],
    queryFn: async () => {
      const res = await fetch(`/api/public/camps/${slug}`);
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
  });

  // Brand the whole form off the camp's owning club (CUFC default, SIU black/gold).
  const clubBrand = brandForOrg(data?.organization?.slug);
  const BRAND = { blue: clubBrand.primary, darkBlue: clubBrand.dark, white: clubBrand.pageBg, gold: clubBrand.gold };

  // Real per-camp prices from camp_pricing; legacy hardcoded values as fallback.
  const priceFor = (pt: string) => {
    const m = (data?.pricing || []).find((p: any) => p.productType === pt);
    return m ? m.priceCents : (hardcodedPrices[pt] || 0);
  };

  const bookMutation = useMutation({
    mutationFn: async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const res = await apiRequest("POST", "/api/public/book", {
        campSlug: slug,
        parent: { firstName: parentFirst, lastName: parentLast, email: parentEmail, phone: parentPhone },
        children: children.filter(c => c.firstName.trim()),
        items: (() => {
          const validChildren = children.filter(c => c.firstName.trim());
          const expandedItems: { childIndex: number; campDateId: number; productType: string }[] = [];
          for (let ci = 0; ci < validChildren.length; ci++) {
            for (const item of items) {
              expandedItems.push({ childIndex: ci, campDateId: item.campDateId, productType: item.productType });
            }
          }
          return expandedItems;
        })(),
        discountCode: appliedPromo?.code || null,
        utmSource: urlParams.get("utm_source"),
        utmMedium: urlParams.get("utm_medium"),
        utmCampaign: urlParams.get("utm_campaign"),
        fbclid: urlParams.get("fbclid"),
        fbp: getFbp(),
        fbc: getFbc(),
        userAgent: navigator.userAgent,
      });
      return res.json();
    },
    onSuccess: async (result: any) => {
      setBookingResult(result);

      if (result.totalCents === 0) {
        fetch("/api/public/book/confirm-free", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registrationId: result.registrationId }),
        });
        try {
          const sv = (window as any)._cufc_split_variants;
          if (sv) {
            for (const field of Object.keys(sv)) {
              if (sv[field]?.id) {
                fetch("/api/public/split-test/conversion", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ variantId: sv[field].id, revenue: 0 }),
                }).catch(() => {});
              }
            }
          }
        } catch {}
        setLocation(`/${slug}/feedback?registrationId=${result.registrationId}`);
        return;
      }

      if (result.requiresPayment) {
        try {
          const res = await fetch(`/api/public/checkout/${result.registrationId}`);
          if (!res.ok) throw new Error("Could not load checkout");
          const cd = await res.json();
          setCheckoutData(cd);
          setStep(4);
        } catch (err: any) {
          toast({ title: "Error loading payment", description: err.message, variant: "destructive" });
        }
      } else {
        setLocation(`/${slug}/feedback?registrationId=${result.registrationId}`);
      }
    },
    onError: (e: Error) => toast({ title: "Booking failed", description: e.message, variant: "destructive" }),
  });

  const addChild = () => setChildren([...children, { firstName: "", lastName: "", dateOfBirth: "", allergies: "", epiPen: false, medicalNotes: "" }]);
  const removeChild = (i: number) => {
    setChildren(children.filter((_, idx) => idx !== i));
  };
  const updateChild = (i: number, field: keyof ChildData, value: any) => {
    const n = [...children];
    (n[i] as any)[field] = value;
    setChildren(n);
  };

  const toggleItem = (childIndex: number, campDateId: number, productType: string, dateName: string) => {
    const exists = items.find(i => i.childIndex === childIndex && i.campDateId === campDateId && i.productType === productType);
    if (exists) {
      setItems(items.filter(i => !(i.childIndex === childIndex && i.campDateId === campDateId && i.productType === productType)));
    } else {
      const filtered = items.filter(i => !(i.childIndex === childIndex && i.campDateId === campDateId));
      setItems([...filtered, { childIndex, campDateId, productType, dateName }]);
    }
  };

  const validChildCount = Math.max(1, children.filter(c => c.firstName.trim()).length);

  const applyPromoCode = async () => {
    if (!promoCode.trim()) return;
    setPromoLoading(true);
    setPromoError("");
    try {
      const res = await fetch("/api/public/validate-discount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: promoCode.trim(), campSlug: slug }),
      });
      const result = await res.json();
      if (result.valid) {
        setAppliedPromo(result.discount);
        setPromoError("");
      } else {
        setPromoError(result.message || "Invalid code");
        setAppliedPromo(null);
      }
    } catch {
      setPromoError("Could not validate code");
    }
    setPromoLoading(false);
  };

  const removePromoCode = () => {
    setAppliedPromo(null);
    setPromoCode("");
    setPromoError("");
  };

  const calcTotal = () => {
    let perChildSubtotal = 0;
    items.forEach(item => {
      perChildSubtotal += priceFor(item.productType);
    });
    const subtotal = perChildSubtotal * validChildCount;
    const totalItems = items.length * validChildCount;
    let discount = 0;
    let discountLabel = "";

    if (appliedPromo) {
      if (appliedPromo.valueType === "percentage") {
        discount = Math.round(subtotal * Number(appliedPromo.value) / 100);
        discountLabel = `${Number(appliedPromo.value)}% (${appliedPromo.code})`;
      } else {
        discount = Math.round(Number(appliedPromo.value) * 100);
        discountLabel = `${formatCurrency(Number(appliedPromo.value))} (${appliedPromo.code})`;
      }
      if (discount > subtotal) discount = subtotal;
    } else if (data?.discounts) {
      const applicable = data.discounts
        .filter((d: any) => totalItems >= d.minBookings)
        .sort((a: any, b: any) => Number(b.discountPercent) - Number(a.discountPercent))[0];
      if (applicable) {
        discount = Math.round(subtotal * Number(applicable.discountPercent) / 100);
        discountLabel = `${applicable.discountPercent}%`;
      }
    }
    return { subtotal, discount, total: subtotal - discount, discountLabel, totalItems };
  };

  const pricing = calcTotal();

  useEffect(() => {
    if (step === 4) {
      const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
      if (pixelId) {
        trackEvent("InitiateCheckout", {
          content_name: data?.camp?.name,
          value: pricing.total / 100,
          currency: "NZD",
          num_items: items.length,
        });
      }
    }
  }, [step]);

  if (isLoading) {
    return (
      <div className="min-h-screen" style={{ background: BRAND.white }}>
        <div className="max-w-2xl mx-auto px-5 py-16 space-y-6">
          <Skeleton className="h-10 w-48 bg-slate-100" />
          <Skeleton className="h-[400px] w-full rounded-2xl bg-slate-100" />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const stepLabels = ["Sessions", "Your Details", "Children", "Payment"];
  const stepIcons = [Calendar, User, Heart, CreditCard];

  const canProceedStep1 = items.length > 0;
  const canProceedStep2 = parentFirst.trim() && parentLast.trim() && parentEmail.trim() && parentEmail.includes("@");
  const canProceedStep3 = children.some(c => c.firstName.trim() && c.lastName.trim());

  return (
    <div className="min-h-screen" style={{ background: BRAND.white, fontFamily: "'Inter Tight', system-ui, -apple-system, sans-serif" }}>
      <header className="bg-white border-b border-slate-100 sticky top-0 z-40">
        <div className="max-w-2xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href={`/${slug}`}>
            <button className="flex items-center gap-2 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" data-testid="link-back">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-[13px] font-medium">Back</span>
            </button>
          </Link>
          <div className="flex items-center gap-2">
            <img
              src={data.organization?.logoUrl || clubBrand.logoUrl}
              alt={data.organization?.name || clubBrand.clubName}
              className="w-6 h-6 object-contain"
            />
            <span className="text-[12px] text-slate-400 font-medium hidden sm:block">{data.camp.name}</span>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-6 sm:py-8 space-y-6">
        <div className="flex items-center gap-1 sm:gap-2">
          {stepLabels.map((label, i) => {
            const s = i + 1;
            const active = step === s;
            const done = step > s;
            const Icon = stepIcons[i];
            return (
              <Fragment key={s}>
                <div className="flex items-center gap-1.5">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0 transition-all duration-300"
                    style={{
                      background: done ? '#10b981' : active ? BRAND.blue : '#f1f5f9',
                      color: done || active ? '#fff' : '#94a3b8',
                    }}
                  >
                    {done ? <CheckCircle className="w-4 h-4" /> : <Icon className="w-3.5 h-3.5" />}
                  </div>
                  <span className={`text-[11px] font-semibold hidden sm:block transition-colors ${active ? 'text-slate-700' : 'text-slate-400'}`}>{label}</span>
                </div>
                {i < 3 && (
                  <div className="flex-1 h-[2px] rounded-full mx-1 transition-all duration-300" style={{ background: done ? '#10b981' : '#f1f5f9' }} />
                )}
              </Fragment>
            );
          })}
        </div>

        {step === 1 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-step-title">
                Choose Your Sessions
              </h2>
              <p className="text-[13px] text-slate-500 mt-1 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Takes less than 2 minutes
              </p>
            </div>

            <div className="space-y-3">
              {data.dates.map((d: any) => {
                const dateObj = new Date(d.date + 'T12:00:00');
                const dayName = dateObj.toLocaleDateString('en-NZ', { weekday: 'long' });
                const dateLabel = dateObj.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' });
                const fullLabel = `${dayName}, ${dateLabel}`;

                return (
                  <div key={d.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:shadow-md" data-testid={`date-card-${d.id}`}>
                    <div className="flex items-center gap-2.5 mb-3.5">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${BRAND.blue}10` }}>
                        <Calendar className="w-4 h-4" style={{ color: BRAND.blue }} />
                      </div>
                      <div>
                        <p className="text-[14px] font-bold text-slate-800">{dayName}</p>
                        <p className="text-[12px] text-slate-400">{dateLabel}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {(["MORNING", "AFTERNOON", "FULL_DAY"] as const).map(pt => {
                        const isSelected = items.some(i => i.childIndex === 0 && i.campDateId === d.id && i.productType === pt);
                        const price = priceFor(pt);
                        const info = sessionTypes[pt];
                        return (
                          <button
                            key={pt}
                            onClick={() => toggleItem(0, d.id, pt, fullLabel)}
                            className="flex-1 rounded-xl py-3 px-2 text-center transition-all duration-200 cursor-pointer border-2"
                            style={{
                              background: isSelected ? BRAND.blue : '#fff',
                              borderColor: isSelected ? BRAND.blue : '#e2e8f0',
                              color: isSelected ? '#fff' : '#334155',
                            }}
                            data-testid={`toggle-0-${d.id}-${pt}`}
                          >
                            <span className="block text-[13px] font-semibold">{info.label}</span>
                            <span className="block text-[10px] mt-0.5" style={{ opacity: isSelected ? 0.7 : 0.5 }}>{info.time}</span>
                            <span className="block text-[13px] font-bold mt-1">${(price / 100).toFixed(0)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {items.length > 0 && (
              <div className="rounded-2xl border-2 p-5 space-y-3 transition-all" style={{ borderColor: `${BRAND.gold}40`, background: `${BRAND.gold}06` }} data-testid="card-pricing-summary">
                <h3 className="text-[13px] font-bold flex items-center gap-1.5" style={{ color: BRAND.darkBlue }}>
                  <Sparkles className="w-4 h-4" style={{ color: BRAND.gold }} /> Your Selection
                </h3>
                <div className="space-y-1.5">
                  {items.map((item, i) => (
                    <div key={i} className="flex justify-between text-[13px]">
                      <span className="text-slate-600">{sessionTypes[item.productType]?.label} — {item.dateName}</span>
                      <span className="text-slate-700 font-semibold">${(priceFor(item.productType) / 100).toFixed(0)}</span>
                    </div>
                  ))}
                </div>
                <div className="border-t pt-3" style={{ borderColor: `${BRAND.gold}25` }}>
                  <div className="flex justify-between text-[14px]">
                    <span className="text-slate-600">{items.length} session{items.length !== 1 ? "s" : ""}</span>
                    <span className="font-bold" style={{ color: BRAND.darkBlue }}>{formatCurrency(pricing.subtotal, { fromCents: true })}</span>
                  </div>
                  {pricing.discount > 0 && (
                    <div className="flex justify-between text-[13px] mt-1">
                      <span className="text-emerald-600">Discount ({pricing.discountLabel})</span>
                      <span className="text-emerald-600 font-semibold">−{formatCurrency(pricing.discount, { fromCents: true })}</span>
                    </div>
                  )}
                  {pricing.discount > 0 && (
                    <div className="flex justify-between text-[16px] font-bold mt-2 pt-2" style={{ borderTop: `1px solid ${BRAND.gold}25` }}>
                      <span style={{ color: BRAND.darkBlue }}>Total</span>
                      <span style={{ color: BRAND.darkBlue }}>{formatCurrency(pricing.total, { fromCents: true })}</span>
                    </div>
                  )}
                </div>
                {data.discounts.length > 0 && pricing.discount === 0 && !appliedPromo && (
                  <p className="text-[12px] rounded-lg px-3 py-2" style={{ background: `${BRAND.gold}12`, color: '#92750a' }}>
                    Book {data.discounts[0]?.minBookings}+ sessions to unlock {data.discounts[0]?.discountPercent}% off
                  </p>
                )}
                <div className="border-t pt-3" style={{ borderColor: `${BRAND.gold}25` }}>
                  {appliedPromo ? (
                    <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: '#ecfdf5' }} data-testid="promo-applied">
                      <div className="flex items-center gap-2">
                        <Tag className="w-3.5 h-3.5 text-emerald-600" />
                        <span className="text-[13px] font-semibold text-emerald-700">{appliedPromo.code}</span>
                      </div>
                      <button
                        onClick={removePromoCode}
                        className="text-[12px] text-slate-400 hover:text-slate-600 font-medium"
                        data-testid="button-remove-promo"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div>
                      <div className="flex gap-2">
                        <Input
                          value={promoCode}
                          onChange={e => { setPromoCode(e.target.value.toUpperCase()); setPromoError(""); }}
                          placeholder="Discount code"
                          className="rounded-xl border-slate-200 focus:border-blue-400 focus:ring-blue-400/20 h-9 text-[13px] font-mono flex-1"
                          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); applyPromoCode(); } }}
                          data-testid="input-promo-code"
                        />
                        <Button
                          onClick={applyPromoCode}
                          disabled={!promoCode.trim() || promoLoading}
                          variant="outline"
                          className="rounded-xl border-slate-200 text-slate-600 hover:bg-slate-50 h-9 text-[13px] px-4"
                          data-testid="button-apply-promo"
                        >
                          {promoLoading ? "..." : "Apply"}
                        </Button>
                      </div>
                      {promoError && (
                        <p className="text-[12px] text-red-500 mt-1" data-testid="text-promo-error">{promoError}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            <Button
              onClick={() => setStep(2)}
              disabled={!canProceedStep1}
              className="w-full border-0 rounded-xl h-13 text-[15px] font-bold shadow-md transition-all text-white cursor-pointer disabled:opacity-40"
              style={{ background: canProceedStep1 ? BRAND.blue : '#94a3b8', boxShadow: canProceedStep1 ? `0 6px 20px ${BRAND.blue}25` : 'none' }}
              data-testid="button-next-step-2"
            >
              Continue <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-step-title">
                Your Details
              </h2>
              <p className="text-[13px] text-slate-500 mt-1">We'll send the booking confirmation here</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4 shadow-sm">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[12px] text-slate-500 font-semibold">First Name *</label>
                  <Input value={parentFirst} onChange={e => setParentFirst(e.target.value)} className="rounded-xl border-slate-200 focus:border-blue-400 focus:ring-blue-400/20 h-11" placeholder="Jane" data-testid="input-parent-first" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] text-slate-500 font-semibold">Last Name *</label>
                  <Input value={parentLast} onChange={e => setParentLast(e.target.value)} className="rounded-xl border-slate-200 focus:border-blue-400 focus:ring-blue-400/20 h-11" placeholder="Smith" data-testid="input-parent-last" />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] text-slate-500 font-semibold">Email *</label>
                <Input type="email" value={parentEmail} onChange={e => setParentEmail(e.target.value)} className="rounded-xl border-slate-200 focus:border-blue-400 focus:ring-blue-400/20 h-11" placeholder="jane@example.com" data-testid="input-parent-email" />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] text-slate-500 font-semibold">Phone</label>
                <Input value={parentPhone} onChange={e => setParentPhone(e.target.value)} className="rounded-xl border-slate-200 focus:border-blue-400 focus:ring-blue-400/20 h-11" placeholder="021 123 4567" data-testid="input-parent-phone" />
              </div>
            </div>

            <div className="rounded-xl px-4 py-3 flex items-start gap-2.5" style={{ background: `${BRAND.blue}06` }}>
              <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: BRAND.blue }} />
              <p className="text-[12px] text-slate-500">Your information is secure and only used to manage your booking.</p>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(1)} className="flex-1 rounded-xl h-12 text-[14px] border-slate-200 text-slate-600 cursor-pointer" data-testid="button-back-step-1">Back</Button>
              <Button
                onClick={() => setStep(3)}
                disabled={!canProceedStep2}
                className="flex-1 border-0 rounded-xl h-12 text-[14px] font-bold text-white cursor-pointer disabled:opacity-40"
                style={{ background: canProceedStep2 ? BRAND.blue : '#94a3b8' }}
                data-testid="button-next-step-3"
              >
                Continue <ArrowRight className="w-4 h-4 ml-1.5" />
              </Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-step-title">
                Children Attending
              </h2>
              <p className="text-[13px] text-slate-500 mt-1">Add each child who'll be at camp</p>
            </div>
            {children.map((child, i) => (
              <div key={i} className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4 shadow-sm" data-testid={`card-child-${i}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-bold" style={{ color: BRAND.blue }}>Child {i + 1}</span>
                  {children.length > 1 && (
                    <button onClick={() => removeChild(i)} className="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center hover:bg-red-50 transition-colors cursor-pointer" data-testid={`button-remove-child-${i}`}>
                      <X className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[12px] text-slate-500 font-semibold">First Name *</label>
                    <Input value={child.firstName} onChange={e => updateChild(i, "firstName", e.target.value)} className="rounded-xl border-slate-200 h-11" placeholder="Oliver" data-testid={`input-child-first-${i}`} />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[12px] text-slate-500 font-semibold">Last Name *</label>
                    <Input value={child.lastName} onChange={e => updateChild(i, "lastName", e.target.value)} className="rounded-xl border-slate-200 h-11" placeholder="Smith" data-testid={`input-child-last-${i}`} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] text-slate-500 font-semibold">Date of Birth</label>
                  <DatePickerInput value={child.dateOfBirth} onChange={e => updateChild(i, "dateOfBirth", e.target.value)} className="rounded-xl border-slate-200 h-11" data-testid={`input-child-dob-${i}`} />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[12px] text-slate-500 font-semibold">Allergies / Medical Notes</label>
                  <Input value={child.allergies} onChange={e => updateChild(i, "allergies", e.target.value)} placeholder="None" className="rounded-xl border-slate-200 h-11" data-testid={`input-child-allergies-${i}`} />
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" checked={child.epiPen} onChange={e => updateChild(i, "epiPen", e.target.checked)} className="rounded w-4 h-4" style={{ accentColor: BRAND.blue }} data-testid={`input-child-epipen-${i}`} />
                  <span className="text-[13px] text-slate-600">Child carries an EpiPen</span>
                </label>
              </div>
            ))}
            <button onClick={addChild} className="w-full py-3.5 rounded-xl border-2 border-dashed border-slate-200 text-[13px] text-slate-500 font-semibold hover:border-blue-300 hover:text-blue-600 transition-all cursor-pointer flex items-center justify-center gap-1.5" data-testid="button-add-child">
              <Plus className="w-4 h-4" /> Add Another Child
            </button>

            {items.length > 0 && (
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="card-order-review">
                <h3 className="text-[13px] font-bold mb-3" style={{ color: BRAND.darkBlue }}>Order Summary</h3>
                <div className="space-y-1.5 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-slate-500">{pricing.totalItems} session{pricing.totalItems !== 1 ? "s" : ""}{validChildCount > 1 ? ` (${items.length} × ${validChildCount} children)` : ""}</span>
                    <span className="text-slate-700 font-medium">{formatCurrency(pricing.subtotal, { fromCents: true })}</span>
                  </div>
                  {pricing.discount > 0 && (
                    <div className="flex justify-between text-emerald-600">
                      <span>Discount ({pricing.discountLabel})</span>
                      <span className="font-medium">−{formatCurrency(pricing.discount, { fromCents: true })}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-[15px] font-bold pt-2 border-t border-slate-100">
                    <span style={{ color: BRAND.darkBlue }}>Total</span>
                    <span style={{ color: BRAND.darkBlue }} data-testid="text-total">{formatCurrency(pricing.total, { fromCents: true })} NZD</span>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => setStep(2)} className="flex-1 rounded-xl h-12 text-[14px] border-slate-200 text-slate-600 cursor-pointer" data-testid="button-back-step-2">Back</Button>
              <Button
                onClick={() => bookMutation.mutate()}
                disabled={!canProceedStep3 || bookMutation.isPending}
                className="flex-1 border-0 rounded-xl h-12 text-[15px] font-bold text-white cursor-pointer disabled:opacity-40"
                style={{ background: canProceedStep3 ? BRAND.blue : '#94a3b8', boxShadow: `0 6px 20px ${BRAND.blue}25` }}
                data-testid="button-submit-booking"
              >
                <ShieldCheck className="w-4 h-4 mr-1.5" />
                {bookMutation.isPending ? "Processing..." : pricing.total > 0 ? "Proceed to Payment" : "Confirm Booking"}
              </Button>
            </div>
          </div>
        )}

        {step === 4 && checkoutData && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-step-title">
                Complete Payment
              </h2>
              <p className="text-[13px] text-slate-500 mt-1">Secure payment powered by Stripe</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm" data-testid="card-order-summary">
              <h3 className="text-[13px] font-bold mb-3" style={{ color: BRAND.darkBlue }}>Order Summary</h3>
              <div className="space-y-2 mb-4">
                {items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-2.5">
                    <div>
                      <p className="text-[13px] font-medium text-slate-700">{sessionTypes[item.productType]?.label}</p>
                      <p className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                        <Calendar className="w-3 h-3" /> {item.dateName}
                      </p>
                    </div>
                    <span className="text-[13px] font-semibold text-slate-700">${(priceFor(item.productType) / 100).toFixed(0)}</span>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-100 pt-3 space-y-1.5 text-[13px]">
                <div className="flex justify-between">
                  <span className="text-slate-500">Subtotal</span>
                  <span className="text-slate-700 font-medium">{formatCurrency(pricing.subtotal, { fromCents: true })}</span>
                </div>
                {pricing.discount > 0 && (
                  <div className="flex justify-between text-emerald-600">
                    <span>Discount ({pricing.discountLabel})</span>
                    <span className="font-medium">−{formatCurrency(pricing.discount, { fromCents: true })}</span>
                  </div>
                )}
                <div className="flex justify-between text-[16px] font-bold pt-2 border-t border-slate-100">
                  <span style={{ color: BRAND.darkBlue }}>Total</span>
                  <span style={{ color: BRAND.darkBlue }} data-testid="text-checkout-total">{formatCurrency(checkoutData.totalCents, { fromCents: true })} NZD</span>
                </div>
              </div>
            </div>

            <StripePay
              clientSecret={checkoutData.clientSecret}
              slug={slug}
              registrationId={checkoutData.registrationId}
              totalCents={checkoutData.totalCents}
              parentEmail={checkoutData.parentEmail}
              parentName={checkoutData.parentName}
              campName={checkoutData.campName}
              itemCount={items.length}
              currency={checkoutData.currency}
              brand={clubBrand}
            />
          </div>
        )}

        {step < 4 && (
          <div className="flex items-center justify-center gap-5 text-[11px] text-slate-400 pt-2 pb-4">
            <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Secure booking</span>
            <span className="flex items-center gap-1"><Lock className="w-3 h-3" /> SSL encrypted</span>
            <span className="flex items-center gap-1"><CreditCard className="w-3 h-3" /> Stripe payments</span>
          </div>
        )}
      </main>
    </div>
  );
}

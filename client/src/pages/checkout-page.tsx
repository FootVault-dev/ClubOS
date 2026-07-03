import { useState, useEffect } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Lock, ShieldCheck, CreditCard, CheckCircle, Calendar, User } from "lucide-react";
import { trackEvent } from "@/lib/meta-pixel";
import { purchaseEventId } from "@shared/meta-events";
import { formatCurrency } from "@/lib/format";
import { brandForOrg, type CampBrand } from "@/lib/camp-brand";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

interface CheckoutData {
  clientSecret: string;
  registrationId: number;
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  currency: string;
  campName: string;
  campSlug: string;
  organizationSlug?: string | null;
  parentName: string;
  parentEmail: string;
  items: { dateName: string; productType: string; childIndex: number }[];
  childrenNames: string[];
}

const sessionTypeLabels: Record<string, string> = {
  MORNING: "Morning Session",
  AFTERNOON: "Afternoon Session",
  FULL_DAY: "Full Day",
};

function PaymentForm({ checkoutData, slug, brand }: { checkoutData: CheckoutData; slug: string; brand: CampBrand }) {
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

    const protocol = window.location.protocol;
    const host = window.location.host;
    const returnUrl = `${protocol}//${host}/${slug}/feedback?registrationId=${checkoutData.registrationId}`;

    const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: returnUrl,
        receipt_email: checkoutData.parentEmail,
      },
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
            body: JSON.stringify({
              registrationId: checkoutData.registrationId,
              paymentIntentId: paymentIntent.id,
            }),
          });
        } catch (e) {}

        // Deterministic id → dedups with the server CAPI Purchase (handlePaymentSuccess).
        trackEvent("Purchase", {
          value: checkoutData.totalCents / 100,
          currency: checkoutData.currency,
          content_name: checkoutData.campName,
          content_ids: [String(checkoutData.registrationId)],
          num_items: checkoutData.items.length,
        }, purchaseEventId(checkoutData.registrationId));

        setLocation(`/${slug}/feedback?registrationId=${checkoutData.registrationId}`);
      } else if (paymentIntent.status === "requires_action") {
        setError("Additional authentication required. Please complete the verification.");
        setProcessing(false);
      } else if (paymentIntent.status === "processing") {
        setLocation(`/${slug}/feedback?registrationId=${checkoutData.registrationId}`);
      } else {
        setError("Payment could not be processed. Please try a different payment method.");
        setProcessing(false);
      }
    }
  };

  const gstAmount = Math.round(checkoutData.totalCents * 3 / 23);
  const exGstAmount = checkoutData.totalCents - gstAmount;

  const groupedItems: Record<string, { dateName: string; productType: string }[]> = {};
  checkoutData.items.forEach(item => {
    const childName = checkoutData.childrenNames[item.childIndex] || `Child ${item.childIndex + 1}`;
    if (!groupedItems[childName]) groupedItems[childName] = [];
    groupedItems[childName].push({ dateName: item.dateName, productType: item.productType });
  });

  return (
    <form onSubmit={handleSubmit} className="space-y-0">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
        <div className="lg:col-span-3 space-y-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" data-testid="card-payment-details">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2.5 mb-6">
              <CreditCard className="w-5 h-5" style={{ color: brand.primary }} /> Payment Details
            </h2>
            <PaymentElement
              options={{
                layout: "tabs",
                defaultValues: {
                  billingDetails: {
                    email: checkoutData.parentEmail,
                    name: checkoutData.parentName,
                  },
                },
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
            className="w-full text-white border-0 rounded-xl h-14 text-[16px] font-semibold shadow-lg transition-all hover:opacity-90"
            style={{ background: brand.primary, boxShadow: `0 8px 24px ${brand.primary}30` }}
            data-testid="button-pay"
          >
            <Lock className="w-4 h-4 mr-2" />
            {processing ? "Processing payment..." : `Pay ${formatCurrency(checkoutData.totalCents, { fromCents: true })} NZD`}
          </Button>

          <div className="flex items-center justify-center gap-6 text-[12px] text-slate-400">
            <span className="flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" /> SSL Encrypted</span>
            <span className="flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Secure Payment</span>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:sticky lg:top-24" data-testid="card-order-summary">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2.5 mb-5">
              <CheckCircle className="w-5 h-5" style={{ color: brand.primary }} /> Order Summary
            </h2>
            <div className="space-y-3 mb-5">
              {Object.entries(groupedItems).map(([childName, items]) => (
                <div key={childName} className="space-y-2">
                  <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: brand.primary }}>{childName}</span>
                  {items.map((item, i) => (
                    <div key={i} className="flex items-start justify-between rounded-xl border border-slate-100 bg-slate-50/50 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-slate-800 truncate">{sessionTypeLabels[item.productType] || item.productType}</p>
                        <p className="text-[12px] text-slate-400 flex items-center gap-1 mt-0.5">
                          <Calendar className="w-3 h-3" /> {item.dateName}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-4 space-y-2.5">
              <div className="flex justify-between text-[13px]">
                <span className="text-slate-500">Subtotal (ex GST)</span>
                <span className="text-slate-700 font-medium">{formatCurrency(exGstAmount, { fromCents: true })}</span>
              </div>
              <div className="flex justify-between text-[13px]">
                <span className="text-slate-500">GST (15%)</span>
                <span className="text-slate-700 font-medium">{formatCurrency(gstAmount, { fromCents: true })}</span>
              </div>
              {checkoutData.discountCents > 0 && (
                <div className="flex justify-between text-[13px]">
                  <span className="text-emerald-600">Discount</span>
                  <span className="text-emerald-600 font-medium">-{formatCurrency(checkoutData.discountCents, { fromCents: true })}</span>
                </div>
              )}
              <div className="flex justify-between text-[16px] font-bold pt-2 border-t border-slate-100">
                <span className="text-slate-800">Total</span>
                <span className="text-slate-900" data-testid="text-checkout-total">{formatCurrency(checkoutData.totalCents, { fromCents: true })} NZD</span>
              </div>
            </div>

            <div className="mt-5 space-y-2.5">
              <div className="flex items-start gap-2.5 text-[12px] text-slate-400">
                <ShieldCheck className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span>Your payment is securely processed by Stripe. We never store your card details.</span>
              </div>
              <div className="flex items-start gap-2.5 text-[12px] text-slate-400">
                <User className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: brand.primary }} />
                <span>Booking for <strong className="text-slate-600">{checkoutData.parentName}</strong> ({checkoutData.parentEmail})</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}

export default function CheckoutPage() {
  const [, params] = useRoute("/:slug/checkout");
  const slug = params?.slug || "";
  const [checkoutData, setCheckoutData] = useState<CheckoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const brand = brandForOrg(checkoutData?.organizationSlug);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const registrationId = urlParams.get("registrationId");
    if (!registrationId) {
      setError("Missing registration ID");
      setLoading(false);
      return;
    }

    fetch(`/api/public/checkout/${registrationId}`)
      .then(res => {
        if (!res.ok) throw new Error("Could not load checkout details");
        return res.json();
      })
      .then(data => {
        setCheckoutData(data);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50">
        <header className="bg-white border-b border-slate-100 sticky top-0 z-40">
          <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
            <span className="text-[13px] text-slate-400">Loading...</span>
            <span className="text-[13px] text-slate-400 font-medium flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> Secure Checkout
            </span>
          </div>
        </header>
        <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
          <Skeleton className="h-10 w-64 bg-slate-100" />
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
            <div className="lg:col-span-3">
              <Skeleton className="h-[400px] w-full rounded-2xl bg-slate-100" />
            </div>
            <div className="lg:col-span-2">
              <Skeleton className="h-[300px] w-full rounded-2xl bg-slate-100" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (error || !checkoutData) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center space-y-4">
          <p className="text-slate-500 text-[14px]">{error || "Unable to load checkout"}</p>
          <Link href={`/${slug}/book`}>
            <button className="text-blue-600 text-[13px] font-medium hover:underline cursor-pointer" data-testid="link-back-to-booking">Return to booking</button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href={`/${slug}/book`}>
            <button className="flex items-center gap-2 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer" data-testid="link-back-to-booking">
              <ArrowLeft className="w-4 h-4" />
              <span className="text-[13px] font-medium">Back to booking</span>
            </button>
          </Link>
          <span className="text-[13px] text-slate-400 font-medium flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" /> Secure Checkout
          </span>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-10">
        <div className="mb-8">
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight" data-testid="text-checkout-heading">Complete Your Booking</h1>
          <p className="text-[14px] text-slate-500 mt-1.5">Review your booking and enter payment details</p>
        </div>

        <Elements
          stripe={stripePromise}
          options={{
            clientSecret: checkoutData.clientSecret,
            appearance: {
              theme: "stripe",
              variables: {
                colorPrimary: brand.primary,
                colorBackground: "#ffffff",
                colorText: "#1e293b",
                colorDanger: "#ef4444",
                fontFamily: "system-ui, -apple-system, sans-serif",
                spacingUnit: "4px",
                borderRadius: "12px",
                fontSizeBase: "14px",
              },
              rules: {
                ".Input": {
                  border: "1px solid #e2e8f0",
                  boxShadow: "none",
                  padding: "12px 14px",
                },
                ".Input:focus": {
                  border: `1px solid ${brand.primary}80`,
                  boxShadow: `0 0 0 3px ${brand.primary}15`,
                },
                ".Label": {
                  fontSize: "13px",
                  fontWeight: "500",
                  color: "#64748b",
                  marginBottom: "6px",
                },
                ".Tab": {
                  border: "1px solid #e2e8f0",
                  borderRadius: "12px",
                },
                ".Tab--selected": {
                  border: `2px solid ${brand.primary}`,
                  backgroundColor: `${brand.primary}08`,
                },
              },
            },
          }}
        >
          <PaymentForm checkoutData={checkoutData} slug={slug} brand={brand} />
        </Elements>
      </main>
    </div>
  );
}

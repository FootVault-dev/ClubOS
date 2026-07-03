import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRoute, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle, Calendar, Mail, ArrowRight, Home, Clock, ShieldCheck, Sparkles } from "lucide-react";
import { trackEvent } from "@/lib/meta-pixel";
import { purchaseEventId } from "@shared/meta-events";
import { formatCurrency } from "@/lib/format";
import { brandForOrg } from "@/lib/camp-brand";

export default function BookingSuccess() {
  const [, params] = useRoute("/:slug/success");
  const slug = params?.slug || "";
  const urlParams = new URLSearchParams(window.location.search);
  const registrationId = urlParams.get("registrationId");
  const [confirmed, setConfirmed] = useState(false);

  // Brand off the camp's owning club (shares the landing/booking page query cache).
  const { data: campData } = useQuery<{ organization?: { slug: string; name: string; logoUrl: string | null } }>({
    queryKey: ["/api/public/camps", slug],
    queryFn: async () => {
      const res = await fetch(`/api/public/camps/${slug}`);
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
    enabled: !!slug,
  });
  const clubBrand = brandForOrg(campData?.organization?.slug);
  const BRAND = { blue: clubBrand.primary, darkBlue: clubBrand.dark, white: clubBrand.pageBg, gold: clubBrand.gold };

  const { data: registration, isLoading } = useQuery<any>({
    queryKey: ["/api/public/registrations", registrationId],
    queryFn: async () => {
      const res = await fetch(`/api/public/registrations/${registrationId}`);
      if (!res.ok) throw new Error("Registration not found");
      return res.json();
    },
    enabled: !!registrationId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === "confirmed" || confirmed) return false;
      return 2000;
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/public/confirm-payment", {
        registrationId: parseInt(registrationId || "0"),
      });
      return res.json();
    },
    onSuccess: () => setConfirmed(true),
  });

  useEffect(() => {
    if (registrationId && !confirmed) {
      confirmMutation.mutate();
    }
  }, [registrationId]);

  useEffect(() => {
    if (registration && (registration.status === "confirmed" || confirmed)) {
      const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
      if (pixelId) {
        // Deterministic id → dedups with the server CAPI Purchase (handlePaymentSuccess).
        trackEvent("Purchase", {
          content_name: registration.campName,
          content_category: "Holiday Camp",
          value: (registration.totalCents || 0) / 100,
          currency: registration.currency || "NZD",
          content_ids: [registration.campSlug],
          num_items: registration.itemCount,
        }, purchaseEventId(registration.id));
      }
    }
  }, [registration, confirmed]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.white }}>
        <div className="max-w-md mx-auto px-6 py-16 space-y-6 text-center">
          <Skeleton className="h-16 w-16 rounded-full bg-slate-100 mx-auto" />
          <Skeleton className="h-8 w-64 bg-slate-100 mx-auto" />
          <Skeleton className="h-32 w-full rounded-2xl bg-slate-100" />
        </div>
      </div>
    );
  }

  const isConfirmed = registration?.status === "confirmed" || confirmed;
  const isPending = registration?.status === "pending" && !confirmed;

  return (
    <div className="min-h-screen" style={{ background: BRAND.white, fontFamily: "'Inter Tight', system-ui, -apple-system, sans-serif" }}>
      <header className="bg-white border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img
              src={campData?.organization?.logoUrl || clubBrand.logoUrl}
              alt={campData?.organization?.name || clubBrand.clubName}
              className="w-7 h-7 object-contain"
            />
            <span className="text-[12px] text-slate-400 font-medium">{campData?.organization?.name || clubBrand.clubName}</span>
          </div>
        </div>
      </header>

      <main className="max-w-md mx-auto px-6 py-12 sm:py-16 text-center">
        {isConfirmed ? (
          <div className="space-y-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto" style={{ background: '#ecfdf5' }}>
                <CheckCircle className="w-10 h-10 text-emerald-500" />
              </div>
              <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center mx-auto" style={{ background: BRAND.gold, left: '58%' }}>
                <Sparkles className="w-3 h-3 text-white" />
              </div>
            </div>

            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-success-title">
                Booking Confirmed!
              </h1>
              <p className="text-[15px] text-slate-500 mt-2">
                You're all set for an amazing camp experience
              </p>
            </div>

            {registration && (
              <div className="rounded-2xl border border-slate-200 bg-white p-6 text-left space-y-3 shadow-sm" data-testid="card-booking-summary">
                <h3 className="text-[12px] uppercase tracking-[0.12em] font-bold" style={{ color: BRAND.blue }}>Booking Summary</h3>
                <div className="space-y-2.5">
                  <div className="flex justify-between text-[14px]">
                    <span className="text-slate-500">Camp</span>
                    <span className="text-slate-800 font-semibold">{registration.campName}</span>
                  </div>
                  <div className="flex justify-between text-[14px]">
                    <span className="text-slate-500">Booking No.</span>
                    <span className="text-slate-800 font-semibold" style={{ color: BRAND.blue }}>#{registration.id}</span>
                  </div>
                  <div className="flex justify-between text-[14px]">
                    <span className="text-slate-500">Sessions</span>
                    <span className="text-slate-800 font-semibold">{registration.itemCount} booked</span>
                  </div>
                  {registration.totalCents > 0 && (
                    <div className="flex justify-between text-[16px] font-bold pt-3 border-t border-slate-100">
                      <span className="text-slate-600">Total Paid</span>
                      <span style={{ color: BRAND.darkBlue }}>{formatCurrency(registration.totalCents, { fromCents: true })} {registration.currency}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm">
              <div className="flex items-start gap-3">
                <Mail className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: BRAND.blue }} />
                <div>
                  <p className="text-[14px] font-semibold text-slate-800">Confirmation email sent</p>
                  <p className="text-[13px] text-slate-500 mt-0.5">
                    Check your inbox at {registration?.parentEmail || "your email"} for full details.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl p-5 text-left space-y-4" style={{ background: `${BRAND.blue}06`, border: `1px solid ${BRAND.blue}12` }}>
              <h3 className="text-[13px] font-bold" style={{ color: BRAND.darkBlue }}>What Happens Next</h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white" style={{ background: BRAND.blue }}>1</div>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-700">Check your email</p>
                    <p className="text-[12px] text-slate-500">You'll receive a detailed confirmation with everything you need to know.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white" style={{ background: BRAND.blue }}>2</div>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-700">Prepare for camp</p>
                    <p className="text-[12px] text-slate-500">Bring boots, shin pads, water bottle, and lunch (full day). Arrive 10 mins early on day one.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white" style={{ background: BRAND.blue }}>3</div>
                  <div>
                    <p className="text-[13px] font-semibold text-slate-700">Show up and have fun!</p>
                    <p className="text-[12px] text-slate-500">Our qualified UEFA-licensed coaches will handle the rest.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 pt-2">
              <Link href={`/${slug}`}>
                <Button
                  className="w-full border-0 rounded-xl h-12 text-[15px] font-bold text-white cursor-pointer"
                  style={{ background: BRAND.blue, boxShadow: `0 6px 20px ${BRAND.blue}25` }}
                  data-testid="button-back-to-camp"
                >
                  <ArrowRight className="w-4 h-4 mr-1.5" /> View Camp Details
                </Button>
              </Link>
              <Link href="/">
                <Button variant="outline" className="w-full rounded-xl h-12 text-[14px] border-slate-200 text-slate-600 cursor-pointer" data-testid="button-home">
                  <Home className="w-4 h-4 mr-1.5" /> All Camps
                </Button>
              </Link>
            </div>

            <div className="flex items-center justify-center gap-5 text-[11px] text-slate-400 pt-2">
              <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Secure booking</span>
              <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Instant confirmation</span>
            </div>
          </div>
        ) : isPending ? (
          <div className="space-y-6">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto" style={{ background: `${BRAND.gold}15` }}>
              <Calendar className="w-10 h-10" style={{ color: BRAND.gold }} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-pending-title">
                Confirming Your Booking
              </h1>
              <p className="text-[15px] text-slate-500 mt-2">
                {confirmMutation.isPending ? "Verifying your payment..." : "Your booking is awaiting payment confirmation."}
              </p>
            </div>
            <div className="flex items-center justify-center gap-2 text-[13px] text-slate-400">
              <div className="w-4 h-4 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
              <span>This usually takes a few seconds</span>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center mx-auto">
              <Calendar className="w-10 h-10 text-slate-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }}>Booking Not Found</h1>
              <p className="text-[15px] text-slate-500 mt-2">We couldn't find this booking. Please try again.</p>
            </div>
            <Link href="/">
              <Button variant="outline" className="rounded-xl h-12 text-[14px] border-slate-200 text-slate-600 cursor-pointer" data-testid="button-back-to-camps">
                Back to Camps
              </Button>
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}

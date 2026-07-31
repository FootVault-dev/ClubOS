import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { saveSplitTokens, stashSetupSecret } from "@/lib/split-pay";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Calendar as CalendarIcon, Clock, MapPin, Plus, Trash2, ArrowLeft, ArrowRight,
  CheckCircle2, Lightbulb, Users, ShoppingCart, Loader2, Lock, X,
  ChevronLeft, ChevronRight, Shield, Minus, ScrollText, Share2,
} from "lucide-react";
import { FacilityCarousel } from "@/components/FacilityCarousel";
import { cellsOverlap, QUARTER_POSITIONS, type FieldSize } from "@shared/field-cells";
import { waiverSectionsFor, USC_WAIVER_VERSION } from "@shared/usc-waiver";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

function facilityImages(f: { imageUrls: string[] | null; imageUrl: string | null }): string[] {
  const arr = (f.imageUrls || []).filter(Boolean);
  if (arr.length > 0) return arr;
  return f.imageUrl ? [f.imageUrl] : [];
}

type FacilityType = "field" | "mini_pitch" | "meeting_room" | "changing_room" | "futsal" | "court" | "other";

interface PricingRule {
  id: number;
  facilityId: number;
  name: string;
  dayOfWeek: number | null;
  startTime: string | null;
  endTime: string | null;
  pricePerHour: string;
  halfFieldPricePerHour?: string | null;
  quarterFieldPricePerHour?: string | null;
  isDefault: boolean | null;
}

interface Addon {
  id: number;
  name: string;
  description: string | null;
  price: string;
  unit: string;
  appliesToAll: boolean | null;
  active: boolean;
}

interface PublicFacility {
  id: number;
  organizationId: number;
  name: string;
  type: FacilityType;
  description: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  halfFull: boolean | null;
  quarterField: boolean | null;
  floodlights: boolean | null;
  bufferMinutes: number | null;
  pricePerHourCents: number | null;
  halfFieldPricePerHourCents: number | null;
  quarterFieldPricePerHourCents: number | null;
  pricingRules: PricingRule[];
  addons: Addon[];
}

interface VenueSettings {
  id: number;
  organizationId: number;
  siteTitle: string;
  introText: string | null;
  brandColor: string | null;
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  minDurationMinutes: number;
  advanceBookingDays: number;
  gstRatePercent: string;
  contactEmail: string | null;
  contactPhone: string | null;
  footerText: string | null;
  paymentPolicy: string | null;
  successMessage: string | null;
}

interface ResolveResp {
  organization: { id: number; name: string; slug: string; logoUrl: string | null };
  settings: VenueSettings;
}

interface AvailabilitySlot {
  date: string;
  startTime: string;
  endTime: string;
  halfFull: string | null;
  halfPosition: string | null;
  status: string;
}

interface CartItem {
  id: string;
  facility: PublicFacility;
  date: string;
  startTime: string;
  endTime: string;
  halfFull: FieldSize | null;
  halfPosition: string | null;
  addons: { addonId: number; qty: number }[];
  // Tag carried from the configure panel so checkout knows which Stripe path
  // to use. All items in a single recurring batch share the same group key.
  paymentMode?: "upfront" | "weekly";
  recurringGroupKey?: string;
}

interface QuoteLine {
  facilityId: number;
  facilityName: string;
  date: string;
  startTime: string;
  endTime: string;
  halfFull: string | null;
  halfPosition: string | null;
  hours: number;
  baseCents: number;
  addons: { addonId: number; name: string; unit: string; qty: number; priceCents: number }[];
  totalCents: number;
}
interface Quote {
  lineItems: QuoteLine[];
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  gstRate: number;
  preDiscountCents?: number;
  discountCents?: number;
  discount?: { code: string | null; title: string; valueType: string; value: number; amountCents: number } | null;
}

const FACILITY_TYPE_LABELS: Record<FacilityType, string> = {
  field: "Field", mini_pitch: "Mini Pitch", meeting_room: "Meeting Room",
  changing_room: "Changing Room", futsal: "Futsal", court: "Court", other: "Other",
};

const fmtMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// Human label for a booking's size + sub-position, e.g. "front half", "quarter Q3".
function fieldSizeLabel(halfFull: string | null | undefined, halfPosition: string | null | undefined): string {
  if (halfFull === "half") return halfPosition ? `${halfPosition} half` : "half";
  if (halfFull === "quarter") return halfPosition ? `quarter ${halfPosition.toUpperCase()}` : "quarter";
  return "";
}

function getOrgSlug(): string | undefined {
  const url = new URL(window.location.href);
  const slug = url.searchParams.get("slug");
  if (slug) return slug;
  // In dev, fall back to USC slug so /book works directly
  const host = window.location.hostname;
  if (host === "localhost" || host.endsWith(".replit.dev") || host.endsWith(".repl.co") || host.endsWith(".replit.app")) {
    return "united-sports-centre";
  }
  return undefined;
}

// Marketing attribution — where this booking session came from. The cufc.co.nz
// "Field Hire" menu link routes through the /l/ tracker and lands here as
// book.unitedsportscentre.com/?source=field-hire-mainmenu (plus utm_*). Capture
// it on first load and stash it in sessionStorage so it survives the multi-step
// flow / a reload, then stamp it on the booking at checkout for revenue
// attribution. Falls back to utm_campaign / utm_source so a direct utm-tagged
// link also attributes. Capped and null-safe.
const ATTRIBUTION_KEY = "vb:attribution_source";
function getAttributionSource(): string | null {
  try {
    const params = new URL(window.location.href).searchParams;
    const fromUrl = params.get("source") || params.get("utm_campaign") || params.get("utm_source");
    if (fromUrl) {
      const v = fromUrl.trim().slice(0, 120);
      if (v) { sessionStorage.setItem(ATTRIBUTION_KEY, v); return v; }
    }
    return sessionStorage.getItem(ATTRIBUTION_KEY);
  } catch {
    return null;
  }
}

function fmtDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Current calendar date + wall-clock time in New Zealand (Pacific/Auckland),
// independent of the visitor's device timezone. United Sports Centre runs on
// NZ time, so "today" and "now" for availability must always be NZ. The old
// new Date().setHours(0,0,0,0).toISOString() version returned *yesterday* for
// anyone east of UTC (incl. NZ itself), because local midnight converts back a
// day in UTC — which is why a past date (June 1) was selectable on June 2.
function nzNow(): { today: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour"); // some engines render midnight as 24
  return { today: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${hh}:${get("minute")}` };
}

function todayISO() {
  return nzNow().today;
}

// Add (or subtract) whole days to a YYYY-MM-DD string using local calendar
// fields only. Never round-trips through toISOString(), which would shift the
// result by a day for any timezone east of UTC.
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function genTimeSlots(opening: string, closing: string, slotMin: number): string[] {
  const [oh, om] = opening.split(":").map(Number);
  const [ch, cm] = closing.split(":").map(Number);
  const start = oh * 60 + om;
  const end = ch * 60 + cm;
  const out: string[] = [];
  for (let t = start; t <= end; t += slotMin) {
    const h = Math.floor(t / 60), m = t % 60;
    out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return out;
}

// Compute the per-hour rate (inc GST) for a given facility, date, slot, and
// half/full mode. Mirrors the server-side resolution at routes.ts:1700-1735
// so the customer sees the same number on the slot button as they'll be
// charged at checkout.
function pricePerHourForSlot(
  facility: PublicFacility,
  date: string,
  slot: string,
  halfFull: FieldSize,
): number {
  const dayOfWeek = new Date(date + "T00:00:00").getDay();
  const rule = facility.pricingRules.find(r =>
    r.dayOfWeek != null && r.dayOfWeek === dayOfWeek &&
    r.startTime && r.endTime &&
    slot >= r.startTime && slot < r.endTime
  );
  const fullRate = rule ? parseFloat(rule.pricePerHour) : (facility.pricePerHourCents ?? 0) / 100;
  if (halfFull === "half") {
    if (rule?.halfFieldPricePerHour != null) return parseFloat(rule.halfFieldPricePerHour);
    return facility.halfFieldPricePerHourCents != null ? facility.halfFieldPricePerHourCents / 100 : fullRate / 2;
  }
  if (halfFull === "quarter") {
    // Mirrors the server: rule quarter → facility quarter → half/2 → full/4.
    if (rule?.quarterFieldPricePerHour != null) return parseFloat(rule.quarterFieldPricePerHour);
    if (facility.quarterFieldPricePerHourCents != null) return facility.quarterFieldPricePerHourCents / 100;
    if (rule?.halfFieldPricePerHour != null) return parseFloat(rule.halfFieldPricePerHour) / 2;
    if (facility.halfFieldPricePerHourCents != null) return facility.halfFieldPricePerHourCents / 200;
    return fullRate / 4;
  }
  return fullRate;
}

// "From $X" — the lowest hourly rate you can get on this facility at any
// time, in the cheapest mode (half if available, full otherwise). Used as
// a hint on the facility cards so customers know what they're walking into.
function cheapestRateForFacility(facility: PublicFacility): number | null {
  const candidates: number[] = [];
  for (const r of facility.pricingRules) {
    if (facility.quarterField && r.quarterFieldPricePerHour != null) candidates.push(parseFloat(r.quarterFieldPricePerHour));
    else if (facility.halfFull && r.halfFieldPricePerHour != null) candidates.push(parseFloat(r.halfFieldPricePerHour));
    else candidates.push(parseFloat(r.pricePerHour));
  }
  if (facility.quarterField && facility.quarterFieldPricePerHourCents != null) candidates.push(facility.quarterFieldPricePerHourCents / 100);
  if (facility.halfFull && facility.halfFieldPricePerHourCents != null) candidates.push(facility.halfFieldPricePerHourCents / 100);
  if (facility.pricePerHourCents) candidates.push(facility.pricePerHourCents / 100);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

// ============ MAIN PAGE ============
export default function VenueBookPage() {
  const slug = getOrgSlug();
  const [resolved, setResolved] = useState<ResolveResp | null>(null);
  const [loadingResolve, setLoadingResolve] = useState(true);
  const [errResolve, setErrResolve] = useState<string | null>(null);

  // The public booking flow is hardcoded dark. The shared light-mode polyfill
  // in index.css flips `text-white` to dark slate when `html` lacks `.dark`,
  // which makes every label invisible on visitors whose OS defaults to light.
  // Force `.dark` while this page is mounted; restore on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    const prevColorScheme = root.style.colorScheme;
    const prevDataTheme = root.getAttribute("data-theme");
    root.classList.add("dark");
    root.style.colorScheme = "dark";
    root.setAttribute("data-theme", "dark");
    return () => {
      if (!hadDark) root.classList.remove("dark");
      root.style.colorScheme = prevColorScheme;
      if (prevDataTheme) root.setAttribute("data-theme", prevDataTheme);
      else root.removeAttribute("data-theme");
    };
  }, []);

  // Capture marketing attribution from the landing URL on first load, before any
  // in-app step navigation can drop the query string.
  useEffect(() => { getAttributionSource(); }, []);

  useEffect(() => {
    (async () => {
      try {
        const url = slug ? `/api/public/venue/resolve?slug=${encodeURIComponent(slug)}` : `/api/public/venue/resolve`;
        const r = await fetch(url);
        if (!r.ok) throw new Error((await r.json()).message || "Venue not found");
        setResolved(await r.json());
      } catch (e: any) {
        setErrResolve(e.message);
      } finally {
        setLoadingResolve(false);
      }
    })();
  }, [slug]);

  if (loadingResolve) {
    return <FullPageLoader label="Loading booking site…" />;
  }
  if (errResolve || !resolved) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-2">Venue not found</h1>
          <p className="text-white/60 text-sm">{errResolve || "We couldn't find this booking site."}</p>
        </div>
      </div>
    );
  }
  return <BookingFlow resolved={resolved} />;
}

function FullPageLoader({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-white/60" />
        <p className="text-white/60 text-sm">{label}</p>
      </div>
    </div>
  );
}

// ============ BOOKING FLOW ============
type Step = "items" | "review" | "details" | "payment";

function BookingFlow({ resolved }: { resolved: ResolveResp }) {
  const { organization, settings } = resolved;
  const brand = settings.brandColor || "#6366f1";
  const [step, setStep] = useState<Step>("items");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [discountCode, setDiscountCode] = useState("");

  const [facilities, setFacilities] = useState<PublicFacility[] | null>(null);
  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/public/venue/${organization.id}/facilities`);
      if (r.ok) setFacilities(await r.json());
    })();
  }, [organization.id]);

  // Recompute quote whenever cart changes
  useEffect(() => {
    if (cart.length === 0) { setQuote(null); return; }
    setLoadingQuote(true);
    (async () => {
      try {
        const r = await fetch(`/api/public/venue/${organization.id}/bookings/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: cart.map(c => ({
              facilityId: c.facility.id,
              date: c.date,
              startTime: c.startTime,
              endTime: c.endTime,
              halfFull: c.halfFull,
              halfPosition: c.halfPosition,
              addons: c.addons,
            })),
            discountCode: discountCode.trim() || undefined,
          }),
        });
        if (r.ok) setQuote(await r.json());
      } finally {
        setLoadingQuote(false);
      }
    })();
  }, [cart, organization.id, discountCode]);

  const removeFromCart = (id: string) => setCart(prev => prev.filter(c => c.id !== id));

  const [customer, setCustomer] = useState({ name: "", email: "", phone: "", club: "", notes: "" });
  // Facility Use Terms & Liability Waiver tick — required before checkout,
  // mirrored server-side (checkoutSchema requires waiverAccepted === true).
  const [waiverAgreed, setWaiverAgreed] = useState(false);
  const [checkout, setCheckout] = useState<{ clientSecret: string; bookingGroupId: string; quote: Quote } | null>(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutErr, setCheckoutErr] = useState<string | null>(null);
  // Two ways to split: Player Pay (ours — a squad size up front, our own hub)
  // and PayShare (theirs — they run the invites and decide the shares).
  const [payMode, setPayMode] = useState<"full" | "split" | "payshare">("full");
  const [splitCount, setSplitCount] = useState(4);
  const [, setNavLocation] = useLocation();

  const startCheckout = async () => {
    setCheckingOut(true);
    setCheckoutErr(null);
    const attributionSource = getAttributionSource() ?? undefined;
    try {
      // If any cart item is flagged for weekly subscription, route the WHOLE
      // cart to the subscription endpoint. The current UX only allows one
      // recurring batch per cart, so this is safe; the server enforces that
      // every item shares the same slot.
      const isSubscription = cart.some(c => c.paymentMode === "weekly");
      const items = cart.map(c => ({
        facilityId: c.facility.id,
        date: c.date,
        startTime: c.startTime,
        endTime: c.endTime,
        halfFull: c.halfFull,
        halfPosition: c.halfPosition,
        addons: c.addons,
      }));

      // PayShare: reserve the slots, open a PayShare session, hand the organiser
      // over to PayShare's own hub. A full page load, not a client route — the
      // session lives on their domain.
      if (payMode === "payshare" && !isSubscription) {
        const r = await fetch(`/api/payshare/start-split`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId: organization.id, customer, items, discountCode: discountCode.trim() || undefined, waiverAccepted: waiverAgreed, attributionSource }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error?.message || data.message || "Couldn't start PayShare");
        if (!data.sessionUrl) throw new Error("PayShare didn't return a session link");
        window.location.href = data.sessionUrl;
        return;
      }

      // Player Pay: reserve the slots, create a split, and hand off to the hub.
      if (payMode === "split" && !isSubscription) {
        const r = await fetch(`/api/public/venue/${organization.id}/bookings/checkout-split`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer, items, discountCode: discountCode.trim() || undefined, waiverAccepted: waiverAgreed, targetCount: splitCount, attributionSource }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || "Couldn't start the split");
        saveSplitTokens(data.splitCode, { organiserToken: data.organiserToken, memberToken: data.memberToken });
        if (data.paymentClientSecret) stashSetupSecret(data.splitCode, data.paymentClientSecret);
        setNavLocation(`/book/split/${data.splitCode}`);
        return;
      }

      const endpoint = isSubscription
        ? `/api/public/venue/${organization.id}/bookings/checkout-subscription`
        : `/api/public/venue/${organization.id}/bookings/checkout`;

      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer,
          items,
          discountCode: discountCode.trim() || undefined,
          waiverAccepted: waiverAgreed,
          attributionSource,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Checkout failed");
      // Use the server-returned quote so the displayed total is guaranteed to match the Stripe PI amount
      setCheckout({ clientSecret: data.clientSecret, bookingGroupId: data.bookingGroupId, quote: data.quote });
      // Stash the email so the success page can authenticate its read of the booking group
      try {
        sessionStorage.setItem(`vbg:${data.bookingGroupId}`, customer.email);
      } catch {}
      setStep("payment");
    } catch (e: any) {
      setCheckoutErr(e.message);
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(180deg, #0a0e1a 0%, #050810 100%)" }}>
      {/* Header */}
      <header className="border-b border-white/[0.06] backdrop-blur-xl sticky top-0 z-30" style={{ background: "rgba(10,14,26,0.85)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          {organization.logoUrl ? (
            <img src={organization.logoUrl} alt={organization.name} className="h-8 w-auto" />
          ) : (
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: brand }}>
              <MapPin className="w-4 h-4 text-white" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" data-testid="text-site-title">{settings.siteTitle}</div>
            <div className="text-[11px] text-white/40 truncate">{organization.name}</div>
          </div>
          {settings.contactPhone && (
            <a href={`tel:${settings.contactPhone}`} className="hidden sm:flex text-xs text-white/60 hover:text-white">
              {settings.contactPhone}
            </a>
          )}
        </div>
        <Stepper step={step} brand={brand} />
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <div>
          {step === "items" && (
            <AddItemsStep
              facilities={facilities}
              settings={settings}
              brand={brand}
              cart={cart}
              setCart={setCart}
            />
          )}
          {step === "review" && (
            <ReviewStep cart={cart} setCart={setCart} brand={brand} onBack={() => setStep("items")} onNext={() => setStep("details")} />
          )}
          {step === "details" && (
            <DetailsStep
              customer={customer}
              setCustomer={setCustomer}
              waiverAgreed={waiverAgreed}
              setWaiverAgreed={setWaiverAgreed}
              brand={brand}
              onBack={() => setStep("review")}
              onSubmit={startCheckout}
              loading={checkingOut}
              error={checkoutErr}
              allowSplit={!cart.some(c => c.paymentMode === "weekly") && !!(settings as any).splitEnabled}
              allowPayShare={!cart.some(c => c.paymentMode === "weekly") && !!(settings as any).payshareEnabled}
              payMode={payMode}
              setPayMode={setPayMode}
              splitCount={splitCount}
              setSplitCount={setSplitCount}
              totalCents={quote?.totalCents ?? 0}
            />
          )}
          {step === "payment" && checkout && (
            <Elements stripe={stripePromise} options={{ clientSecret: checkout.clientSecret, appearance: { theme: "night" } }}>
              <PaymentStep
                bookingGroupId={checkout.bookingGroupId}
                customer={customer}
                quote={checkout.quote}
                brand={brand}
                onBack={async () => {
                  // Release the held slots so the user can change details and resubmit without conflict.
                  // The endpoint requires the customer email (proof-of-ownership of the group id).
                  try {
                    await fetch(`/api/public/venue/booking-group/${checkout.bookingGroupId}/cancel-pending`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ email: customer.email }),
                    });
                  } catch {}
                  setCheckout(null);
                  setStep("details");
                }}
              />
            </Elements>
          )}
        </div>

        {/* Cart sidebar */}
        <aside className="order-first lg:order-last">
          <CartSummary
            cart={cart}
            quote={quote}
            loadingQuote={loadingQuote}
            brand={brand}
            onRemove={removeFromCart}
            step={step}
            discountCode={discountCode}
            setDiscountCode={setDiscountCode}
            onContinue={() => {
              if (step === "items") setStep("review");
              else if (step === "review") setStep("details");
            }}
          />
        </aside>
      </main>

      {settings.footerText && (
        <footer className="border-t border-white/[0.06] mt-8">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 text-xs text-white/40 whitespace-pre-wrap">{settings.footerText}</div>
        </footer>
      )}
    </div>
  );
}

function Stepper({ step, brand }: { step: Step; brand: string }) {
  const steps: { k: Step; label: string }[] = [
    { k: "items", label: "Add Items" },
    { k: "review", label: "Review Cart" },
    { k: "details", label: "Your Details" },
    { k: "payment", label: "Payment" },
  ];
  const idx = steps.findIndex(s => s.k === step);
  return (
    <div className="border-t border-white/[0.04]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-2 overflow-x-auto">
        {steps.map((s, i) => {
          const active = i === idx, done = i < idx;
          return (
            <div key={s.k} className="flex items-center gap-2 shrink-0" data-testid={`step-${s.k}`}>
              <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold"
                style={{
                  background: done || active ? brand : "rgba(255,255,255,0.06)",
                  color: done || active ? "white" : "rgba(255,255,255,0.4)",
                }}>
                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <div className={`text-xs ${active ? "text-white" : "text-white/40"}`}>{s.label}</div>
              {i < steps.length - 1 && <div className="w-6 h-px bg-white/10 mx-1" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ STEP 1 — Add Items ============
function AddItemsStep({
  facilities, settings, brand, cart, setCart,
}: {
  facilities: PublicFacility[] | null;
  settings: VenueSettings;
  brand: string;
  cart: CartItem[];
  setCart: (fn: (prev: CartItem[]) => CartItem[]) => void;
}) {
  const [selectedFacility, setSelectedFacility] = useState<PublicFacility | null>(null);
  return (
    <div>
      {settings.introText && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 mb-5">
          <p className="text-sm text-white/70 whitespace-pre-wrap">{settings.introText}</p>
        </div>
      )}
      {!facilities ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Skeleton className="aspect-video rounded-2xl" />
          <Skeleton className="aspect-video rounded-2xl" />
        </div>
      ) : facilities.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] p-12 text-center text-white/50">
          No facilities available right now.
        </div>
      ) : (
        <>
          <h2 className="text-lg font-semibold mb-3">Choose a facility</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
            {facilities.map(f => {
              const selected = selectedFacility?.id === f.id;
              const subtitle = f.halfFull ? "Half or Full Field" : FACILITY_TYPE_LABELS[f.type];
              const imgs = facilityImages(f);
              return (
                <div
                  key={f.id}
                  onClick={() => setSelectedFacility(selected ? null : f)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedFacility(selected ? null : f); } }}
                  data-testid={`button-facility-${f.id}`}
                  className="group cursor-pointer rounded-2xl border overflow-hidden transition-all duration-200 ease-out hover:bg-white/[0.04]"
                  style={{
                    borderColor: selected ? brand : "rgba(255,255,255,0.08)",
                    background: selected ? `${brand}10` : "rgba(255,255,255,0.02)",
                  }}
                >
                  {imgs.length > 0 && (
                    <FacilityCarousel
                      images={imgs}
                      alt={f.name}
                      brand={brand}
                      testIdPrefix={`facility-${f.id}-card`}
                      className="w-full"
                    />
                  )}
                  <div className="flex items-center gap-3 p-4">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
                      style={{
                        background: selected ? `${brand}30` : "rgba(255,255,255,0.04)",
                        color: selected ? brand : "rgba(255,255,255,0.5)",
                      }}
                    >
                      <Shield className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm truncate flex items-center gap-1.5">
                        {f.name}
                        {f.floodlights && <Lightbulb className="w-3 h-3 text-yellow-400/70 flex-shrink-0" />}
                      </div>
                      <div className="text-[11px] text-white/40 mt-0.5 truncate flex items-center gap-1.5">
                        <span>{subtitle}</span>
                        {(() => {
                          const rate = cheapestRateForFacility(f);
                          return rate != null && rate > 0 ? (
                            <>
                              <span className="text-white/20">·</span>
                              <span className="text-white/60">from ${rate.toFixed(2)}/hr</span>
                            </>
                          ) : null;
                        })()}
                      </div>
                    </div>
                    <div
                      className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-200"
                      style={{
                        background: selected ? brand : "rgba(255,255,255,0.04)",
                        color: selected ? "white" : "rgba(255,255,255,0.4)",
                        transform: selected ? "rotate(45deg)" : "rotate(0)",
                      }}
                    >
                      <Plus className="w-4 h-4" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {selectedFacility && (
            <div className="animate-in fade-in slide-in-from-top-2 duration-200">
              <ConfigureFacility
                facility={selectedFacility}
                settings={settings}
                brand={brand}
                onAdd={(items) => setCart(prev => [...prev, ...items])}
                cart={cart}
                onClose={() => setSelectedFacility(null)}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ConfigureFacility({
  facility, settings, brand, onAdd, cart, onClose,
}: {
  facility: PublicFacility;
  settings: VenueSettings;
  brand: string;
  onAdd: (items: CartItem[]) => void;
  cart: CartItem[];
  onClose?: () => void;
}) {
  const slots = useMemo(
    () => genTimeSlots(settings.openingTime, settings.closingTime, settings.slotMinutes),
    [settings.openingTime, settings.closingTime, settings.slotMinutes],
  );
  const [date, setDate] = useState(todayISO());
  // Tap-to-pick time selection: first tap sets start, second tap sets end.
  // Null start means "waiting for first tap"; null end means "waiting for end tap".
  const [startTime, setStartTime] = useState<string | null>(null);
  const [endTime, setEndTime] = useState<string | null>(null);
  const [halfFull, setHalfFull] = useState<FieldSize>(facility.halfFull ? "half" : "full");
  const [halfPosition, setHalfPosition] = useState<"front" | "back">("front");
  const [quarterPos, setQuarterPos] = useState<"q1" | "q2" | "q3" | "q4">("q1");
  const [selectedAddons, setSelectedAddons] = useState<Record<number, number>>({});
  const [multiDay, setMultiDay] = useState(false);
  const [extraDates, setExtraDates] = useState<string[]>([]);
  const [busy, setBusy] = useState<AvailabilitySlot[]>([]);
  // Recurring weekly: locks the same time on every weekday-of-`date` from
  // `date` through `recurringUntil` inclusive. Mutually exclusive with
  // Multi-day (which lets you cherry-pick dates manually).
  const [recurring, setRecurring] = useState(false);
  const [recurringUntil, setRecurringUntil] = useState(addDays(todayISO(), 84)); // 12 weeks default
  const [paymentMode, setPaymentMode] = useState<"upfront" | "weekly">("upfront");

  // Compute the recurring date list when recurring mode is on.
  const recurringDates = useMemo(() => {
    if (!recurring) return [] as string[];
    const out: string[] = [];
    const start = new Date(date + "T00:00:00");
    const end = new Date(recurringUntil + "T00:00:00");
    if (end < start) return [];
    const cur = new Date(start);
    cur.setDate(cur.getDate() + 7); // skip the start date itself (already in primary)
    while (cur <= end) {
      const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      out.push(iso);
      cur.setDate(cur.getDate() + 7);
    }
    return out;
  }, [recurring, date, recurringUntil]);

  // Recurring overrides multi-day's extraDates source.
  const effectiveExtraDates = recurring ? recurringDates : (multiDay ? extraDates : []);

  const durationMinutes = useMemo(() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
  }, [startTime, endTime]);

  const allDates = useMemo(() => Array.from(new Set([date, ...effectiveExtraDates])), [date, effectiveExtraDates]);

  // Fetch availability whenever facility/dates change
  useEffect(() => {
    if (allDates.length === 0) return;
    (async () => {
      const r = await fetch(`/api/public/venue/${facility.organizationId}/availability?facilityId=${facility.id}&dates=${allDates.join(",")}`);
      if (r.ok) setBusy(await r.json());
    })();
  }, [facility.id, facility.organizationId, allDates.join(",")]);

  // Full/half/quarter conflict via the shared cell model (the same code the
  // server uses at checkout): two bookings collide iff they share a pitch cell.
  // wantPos is the sub-position being booked — front/back for a half, q1–q4 for
  // a quarter, none for a full pitch.
  const wantPos = halfFull === "half" ? halfPosition : halfFull === "quarter" ? quarterPos : null;
  const blocks = (existingHalf: string | null, existingPos: string | null | undefined) =>
    cellsOverlap(existingHalf, existingPos, halfFull, wantPos);
  const cartConflicts = (d: string, s: string, e: string) =>
    cart.some(c =>
      c.facility.id === facility.id &&
      c.date === d &&
      c.startTime < e &&
      c.endTime > s &&
      blocks(c.halfFull, c.halfPosition)
    );

  const isSlotConflicted = (d: string, s: string, e: string) =>
    busy.some(b =>
      b.date === d &&
      b.startTime < e &&
      b.endTime > s &&
      blocks(b.halfFull, b.halfPosition)
    ) || cartConflicts(d, s, e);

  const conflictDates = startTime && endTime
    ? allDates.filter(d => isSlotConflicted(d, startTime, endTime))
    : [];
  const validDates = startTime && endTime
    ? allDates.filter(d => !isSlotConflicted(d, startTime, endTime))
    : [];

  const canAdd = !!startTime && !!endTime && validDates.length > 0
    && durationMinutes >= settings.minDurationMinutes;

  const handleAdd = () => {
    if (!startTime || !endTime) return;
    // Recurring items share a group key so checkout can detect the batch and
    // route to the subscription endpoint when paymentMode is "weekly".
    const recurringGroupKey = recurring && paymentMode === "weekly"
      ? `rec_${facility.id}_${startTime}_${Math.random().toString(36).slice(2, 8)}`
      : undefined;
    const items: CartItem[] = validDates.map(d => ({
      id: `${facility.id}-${d}-${startTime}-${Math.random().toString(36).slice(2, 8)}`,
      facility,
      date: d,
      startTime,
      endTime,
      halfFull: (facility.halfFull || facility.quarterField) ? halfFull : null,
      halfPosition: halfFull === "half" ? halfPosition : halfFull === "quarter" ? quarterPos : null,
      addons: Object.entries(selectedAddons).filter(([, q]) => q > 0).map(([id, q]) => ({ addonId: parseInt(id), qty: q })),
      paymentMode: recurring ? paymentMode : undefined,
      recurringGroupKey,
    }));
    if (items.length > 0) {
      onAdd(items);
      // Reset time selection after adding so the customer can configure another slot.
      setStartTime(null);
      setEndTime(null);
    }
  };

  // Slot click handler — first click sets start, second click sets end (must be after start).
  // Clicking the current start clears the selection.
  const handleSlotClick = (slot: string) => {
    if (slot === startTime && !endTime) { setStartTime(null); return; }
    if (!startTime) { setStartTime(slot); setEndTime(null); return; }
    if (!endTime) {
      // End must be strictly after start (which is the slot label, e.g. "17:00")
      if (slot > startTime) {
        // Slot label is the start of a slot; end of that slot = slot + slotMinutes.
        // Picking 18:00 as the "end slot" means booking ends at 18:00.
        setEndTime(slot);
      } else {
        // User picked an earlier slot — treat as new start.
        setStartTime(slot);
      }
      return;
    }
    // Both already set — start a new selection.
    setStartTime(slot);
    setEndTime(null);
  };

  // Grey out time slots that have already passed in NZ time when the chosen
  // date is today. The grid is shared across all selected dates but is keyed
  // off the primary `date`, which can only be today or later (calendar min is
  // NZ today). A slot is past once its start is at or before the current NZ
  // time, so the very slot you're in (e.g. 13:00 at 13:21) is no longer bookable.
  const { today: nzToday, hhmm: nzHHMM } = nzNow();
  const isPastSlot = (slot: string) => date === nzToday && slot <= nzHHMM;

  const heroImages = facilityImages(facility);

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden transition-all duration-300 ease-out">
      {heroImages.length > 0 && (
        <FacilityCarousel
          images={heroImages}
          alt={facility.name}
          brand={brand}
          size="hero"
          testIdPrefix={`facility-${facility.id}-hero`}
          className="w-full"
        />
      )}
      <div className="p-5 sm:p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="font-semibold flex items-center gap-2 text-white">
              <MapPin className="w-4 h-4 text-white/40" />
              Configure: {facility.name}
            </h3>
            {facility.description && (
              <p className="text-xs text-white/50 mt-1">{facility.description}</p>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition flex-shrink-0"
              data-testid="button-close-configure"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        {/* Calendar grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs text-white/60">Date</Label>
            <button
              onClick={() => setMultiDay(v => !v)}
              className={`text-[10px] flex items-center gap-1 px-2 py-0.5 rounded transition ${multiDay ? "text-blue-300 bg-blue-500/10" : "text-white/40 hover:text-white/60"}`}
              data-testid="button-toggle-multiday"
            >
              <CalendarIcon className="w-3 h-3" />
              Multi-day
            </button>
          </div>
          <CalendarPicker
            date={date}
            setDate={setDate}
            extraDates={multiDay ? extraDates : []}
            toggleExtraDate={multiDay ? (d) => setExtraDates(prev =>
              prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort()
            ) : undefined}
            min={todayISO()}
            max={(settings.advanceBookingDays > 0 ? addDays(todayISO(), settings.advanceBookingDays) : "9999-12-31")}
            brand={brand}
          />
        </div>

        {/* Time slot grid */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs text-white/60">Time</Label>
            <span className="text-[10px] text-white/40">
              {!startTime ? "Tap your start time" : !endTime ? "Tap your end time" : "Time selected"}
            </span>
          </div>
          <TimeSlotGrid
            slots={slots}
            startTime={startTime}
            endTime={endTime}
            onSelect={handleSlotClick}
            isBusy={(s, e) => allDates.some(d => isSlotConflicted(d, s, e))}
            isPast={isPastSlot}
            brand={brand}
            priceFor={(s) => pricePerHourForSlot(facility, date, s, halfFull)}
          />
          {startTime && endTime && (
            <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-white/40">Start</div>
                <div className="text-sm font-semibold">{fmtTime(startTime)}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-white/30" />
              <div className="flex-1">
                <div className="text-[10px] uppercase tracking-wider text-white/40">End</div>
                <div className="text-sm font-semibold">{fmtTime(endTime)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-white/40">Duration</div>
                <div className="text-sm font-semibold">{durationMinutes >= 60 ? `${durationMinutes / 60}hr` : `${durationMinutes}m`}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {(facility.halfFull || facility.quarterField) && (
        <div className="mb-4">
          <Label className="text-xs text-white/60 mb-1.5 block">Field size</Label>
          <div className="flex gap-2">
            {(["full", "half", "quarter"] as FieldSize[])
              .filter(opt => opt === "full" || (opt === "half" && facility.halfFull) || (opt === "quarter" && facility.quarterField))
              .map(opt => (
              <button
                key={opt}
                onClick={() => setHalfFull(opt)}
                data-testid={`button-size-${opt}`}
                className="flex-1 px-3 py-2 rounded-lg text-sm border transition capitalize"
                style={{
                  borderColor: halfFull === opt ? brand : "rgba(255,255,255,0.1)",
                  background: halfFull === opt ? `${brand}25` : "transparent",
                  color: halfFull === opt ? "white" : "rgba(255,255,255,0.7)",
                }}
              >
                {opt} field
              </button>
            ))}
          </div>
          {halfFull === "half" && (
            <div className="mt-3">
              <Label className="text-xs text-white/60 mb-1.5 block">Which half?</Label>
              <div className="flex gap-2">
                {(["front", "back"] as const).map(pos => (
                  <button
                    key={pos}
                    onClick={() => setHalfPosition(pos)}
                    data-testid={`button-half-${pos}`}
                    className="flex-1 px-3 py-2 rounded-lg text-sm border transition capitalize"
                    style={{
                      borderColor: halfPosition === pos ? brand : "rgba(255,255,255,0.1)",
                      background: halfPosition === pos ? `${brand}25` : "transparent",
                      color: halfPosition === pos ? "white" : "rgba(255,255,255,0.7)",
                    }}
                  >
                    {pos} half
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-white/40 mt-1.5">Booking one half leaves the other half free for someone else.</p>
            </div>
          )}
          {halfFull === "quarter" && (
            <div className="mt-3">
              <Label className="text-xs text-white/60 mb-1.5 block">Which quarter?</Label>
              <div className="grid grid-cols-2 gap-2">
                {QUARTER_POSITIONS.map(q => (
                  <button
                    key={q.value}
                    onClick={() => setQuarterPos(q.value)}
                    data-testid={`button-quarter-${q.value}`}
                    className="px-3 py-2 rounded-lg text-sm border transition"
                    style={{
                      borderColor: quarterPos === q.value ? brand : "rgba(255,255,255,0.1)",
                      background: quarterPos === q.value ? `${brand}25` : "transparent",
                      color: quarterPos === q.value ? "white" : "rgba(255,255,255,0.7)",
                    }}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-white/40 mt-1.5">Q1–Q2 are the front half, Q3–Q4 the back half. Booking one quarter leaves the rest free.</p>
            </div>
          )}
        </div>
      )}

      {facility.addons.length > 0 && (
        <div className="mb-4">
          <Label className="text-xs text-white/60 mb-2 block">Add-ons</Label>
          <div className="space-y-2">
            {facility.addons.map(addon => {
              const qty = selectedAddons[addon.id] || 0;
              const on = qty > 0;
              const useStepper = addon.unit === "per_booking";
              return (
                <div
                  key={addon.id}
                  className="flex items-center justify-between gap-3 rounded-xl border p-3 transition-all duration-200"
                  style={{
                    borderColor: on ? brand : "rgba(255,255,255,0.08)",
                    background: on ? `${brand}10` : "rgba(255,255,255,0.02)",
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-200"
                      style={{
                        background: on ? `${brand}25` : "rgba(255,255,255,0.04)",
                        color: on ? "#fbbf24" : "rgba(251,191,36,0.4)",
                        boxShadow: on ? `0 0 16px ${brand}40` : undefined,
                      }}
                    >
                      <Lightbulb className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold truncate">{addon.name}</div>
                      <div className="text-[11px] text-white/50">${parseFloat(addon.price).toFixed(2)} {addon.unit === "per_hour" ? "/ hour" : "per room"} inc GST</div>
                    </div>
                  </div>
                  {useStepper ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: Math.max(0, (prev[addon.id] || 0) - 1) }))}
                        disabled={qty === 0}
                        data-testid={`button-addon-${addon.id}-minus`}
                        className="w-8 h-8 rounded-md bg-white/[0.08] hover:bg-white/[0.12] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <div
                        className="w-10 text-center text-sm font-semibold tabular-nums"
                        style={{ color: on ? "white" : "rgba(255,255,255,0.6)" }}
                        data-testid={`addon-${addon.id}-qty`}
                      >
                        {qty}
                      </div>
                      <button
                        onClick={() => setSelectedAddons(prev => ({
                          ...prev,
                          [addon.id]: Math.min(addon.maxQty ?? 99, (prev[addon.id] || 0) + 1),
                        }))}
                        disabled={addon.maxQty != null && qty >= addon.maxQty}
                        data-testid={`button-addon-${addon.id}-plus`}
                        className="w-8 h-8 rounded-md flex items-center justify-center transition text-white disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ background: on ? brand : "rgba(255,255,255,0.08)" }}
                        title={addon.maxQty != null && qty >= addon.maxQty ? `Maximum ${addon.maxQty}` : undefined}
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectedAddons(prev => ({ ...prev, [addon.id]: on ? 0 : 1 }))}
                      data-testid={`button-addon-${addon.id}-toggle`}
                      className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold transition-all duration-200 flex-shrink-0 border"
                      style={{
                        background: on ? brand : "rgba(255,255,255,0.06)",
                        borderColor: on ? brand : "rgba(255,255,255,0.12)",
                        color: on ? "white" : "rgba(255,255,255,0.7)",
                        boxShadow: on ? `0 4px 12px ${brand}50` : undefined,
                      }}
                    >
                      {on ? (
                        <>
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Added
                        </>
                      ) : (
                        <>
                          <Plus className="w-3.5 h-3.5" />
                          Add
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recurring weekly — lock in the same slot every week until a chosen end date.
          When on, this overrides the manual Multi-day picker. */}
      <div
        className="rounded-xl border p-3 mb-3 transition-all duration-200"
        style={{
          borderColor: recurring ? brand : "rgba(255,255,255,0.08)",
          background: recurring ? `${brand}10` : "rgba(255,255,255,0.02)",
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 transition-all duration-200"
              style={{
                background: recurring ? `${brand}25` : "rgba(255,255,255,0.04)",
                color: recurring ? brand : "rgba(255,255,255,0.5)",
              }}
            >
              <CalendarIcon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold">Recurring weekly</div>
              <div className="text-[11px] text-white/50">
                {recurring
                  ? `Repeats every ${new Date(date + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "long" })} until your chosen date`
                  : "Lock in the same time every week"}
              </div>
            </div>
          </div>
          <button
            onClick={() => {
              const turnOn = !recurring;
              setRecurring(turnOn);
              if (turnOn) setMultiDay(false);
            }}
            data-testid="button-recurring-toggle"
            className="flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold transition-all duration-200 flex-shrink-0 border"
            style={{
              background: recurring ? brand : "rgba(255,255,255,0.06)",
              borderColor: recurring ? brand : "rgba(255,255,255,0.12)",
              color: recurring ? "white" : "rgba(255,255,255,0.7)",
              boxShadow: recurring ? `0 4px 12px ${brand}50` : undefined,
            }}
          >
            {recurring ? <><CheckCircle2 className="w-3.5 h-3.5" /> On</> : <><Plus className="w-3.5 h-3.5" /> Add</>}
          </button>
        </div>

        {recurring && (
          <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
            <div>
              <Label className="text-[11px] text-white/60 mb-1.5 block">Repeat until</Label>
              <DatePickerInput
                value={recurringUntil}
                min={date}
                max={(settings.advanceBookingDays > 0 ? addDays(todayISO(), settings.advanceBookingDays) : "9999-12-31")}
                onChange={e => setRecurringUntil(e.target.value)}
                data-testid="input-recurring-until"
                className="bg-white/[0.04] border-white/10 text-white"
              />
              <div className="text-[10px] text-white/40 mt-1">
                {recurringDates.length + 1} weekly bookings: {fmtDateLong(date)} → {fmtDateLong(recurringUntil)}
              </div>
            </div>

            <div>
              <Label className="text-[11px] text-white/60 mb-1.5 block">Payment</Label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { key: "upfront", title: "Pay upfront", sub: "All bookings paid in one go" },
                  { key: "weekly",  title: "Pay weekly",  sub: "Auto-charged each week" },
                ] as const).map(opt => {
                  const active = paymentMode === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => setPaymentMode(opt.key)}
                      data-testid={`button-payment-mode-${opt.key}`}
                      className="text-left p-3 rounded-lg border transition-all duration-200"
                      style={{
                        borderColor: active ? brand : "rgba(255,255,255,0.1)",
                        background: active ? `${brand}15` : "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: active ? "white" : "rgba(255,255,255,0.8)" }}>
                        {active && <CheckCircle2 className="w-3 h-3" style={{ color: brand }} />}
                        {opt.title}
                      </div>
                      <div className="text-[10px] text-white/40 mt-0.5">{opt.sub}</div>
                    </button>
                  );
                })}
              </div>
              {paymentMode === "weekly" && (
                <div className="mt-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-200/90 text-[10px] p-2 leading-snug">
                  Your card will be charged automatically each week. Cancel anytime by emailing us — already-paid weeks aren't refunded, future weeks won't be charged.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {(multiDay && extraDates.length > 0) && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 mb-4">
          <div className="text-[11px] text-white/40 mb-2">
            Multi-day: same time on {extraDates.length + 1} dates
          </div>
          <div className="flex flex-wrap gap-1.5">
            {[date, ...extraDates].map(d => (
              <span key={d} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/[0.06] text-[11px]" data-testid={`chip-date-${d}`}>
                {fmtDateLong(d)}
              </span>
            ))}
          </div>
        </div>
      )}

      {startTime && endTime && conflictDates.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs p-2.5 mb-3">
          {conflictDates.length} date{conflictDates.length > 1 ? "s" : ""} unavailable at that time and will be skipped.
        </div>
      )}

      <Button
        onClick={handleAdd}
        disabled={!canAdd}
        data-testid="button-add-to-cart"
        className="w-full h-11 text-white border-0 text-sm font-semibold transition-all duration-200 disabled:opacity-30"
        style={{ background: brand }}
      >
        <ShoppingCart className="w-4 h-4 mr-2" />
        {!startTime || !endTime
          ? "Select a time to continue"
          : validDates.length > 1
            ? `Add ${validDates.length} bookings to cart`
            : "Add to cart"}
      </Button>
      </div>
    </div>
  );
}

// Full-month grid date picker. Shows the month containing `date`, lets user
// click a day to select it. In multi-day mode, additional clicks toggle dates
// in/out of `extraDates`.
function CalendarPicker({
  date, setDate, extraDates, toggleExtraDate, min, max, brand,
}: {
  date: string;
  setDate: (d: string) => void;
  extraDates: string[];
  toggleExtraDate?: (d: string) => void;
  min: string;
  max: string;
  brand: string;
}) {
  const current = new Date(date + "T00:00:00");
  const [viewMonth, setViewMonth] = useState({ year: current.getFullYear(), month: current.getMonth() });
  const first = new Date(viewMonth.year, viewMonth.month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(viewMonth.year, viewMonth.month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewMonth.year, viewMonth.month, d));

  const monthLabel = first.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = todayISO();

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="calendar-picker">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(v => v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 })}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          data-testid="button-prev-month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-medium">{monthLabel}</div>
        <button
          onClick={() => setViewMonth(v => v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 })}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          data-testid="button-next-month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
          <div key={d} className="text-[10px] text-white/30 text-center py-1 uppercase tracking-wider">{d.slice(0, 3)}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          if (!d) return <div key={`p${i}`} />;
          const dStr = ymd(d);
          const isPrimary = dStr === date;
          const isExtra = extraDates.includes(dStr);
          const isToday = dStr === todayStr;
          const disabled = dStr < min || dStr > max;
          const selected = isPrimary || isExtra;
          return (
            <button
              key={dStr}
              disabled={disabled}
              onClick={() => {
                if (toggleExtraDate && !isPrimary) {
                  toggleExtraDate(dStr);
                } else {
                  setDate(dStr);
                }
              }}
              data-testid={`day-${dStr}`}
              className={`aspect-square rounded-full text-xs font-medium transition-all duration-150 border ${
                disabled
                  ? "text-white/15 cursor-not-allowed border-transparent"
                  : isPrimary
                    ? "text-white border-transparent"
                    : isExtra
                      ? "text-white border-transparent"
                      : isToday
                        ? "text-blue-300 border-transparent hover:bg-blue-500/[0.08]"
                        : "text-white/70 border-transparent hover:bg-white/[0.06]"
              }`}
              style={selected ? {
                borderColor: brand,
                background: isPrimary ? `${brand}25` : `${brand}10`,
              } : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Time slot grid — tap once to set start, tap again to set end. Slots between
// start and (selected) end are highlighted as the range. Busy slots are dimmed.
// Each slot also shows its per-hour rate so customers can compare peak/off-peak
// at a glance, like flights/hotels showing per-day prices.
function TimeSlotGrid({
  slots, startTime, endTime, onSelect, isBusy, isPast, brand, priceFor,
}: {
  slots: string[];
  startTime: string | null;
  endTime: string | null;
  onSelect: (slot: string) => void;
  isBusy: (s: string, e: string) => boolean;
  isPast?: (slot: string) => boolean;
  brand: string;
  priceFor: (slot: string) => number;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="time-slot-grid">
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-1 max-h-[320px] overflow-y-auto">
        {slots.map((s, i) => {
          const next = slots[i + 1] || s;
          const slotBusy = isBusy(s, next);
          const slotPast = isPast?.(s) ?? false;
          const isStart = s === startTime;
          const inBooking = !!(startTime && (
            (endTime && s >= startTime && s < endTime) ||
            (!endTime && isStart)
          ));
          const isEndMarker = s === endTime;
          // A past slot can never be part of an active selection (its start is
          // before "now"), so disabling it outright is safe.
          const unavailable = (slotBusy || slotPast) && !inBooking && !isEndMarker;
          const rate = priceFor(s);
          return (
            <button
              key={s}
              onClick={() => onSelect(s)}
              disabled={unavailable}
              data-testid={`slot-${s}`}
              title={slotPast && !slotBusy ? "This time has already passed" : undefined}
              className={`h-12 rounded-md text-xs font-medium transition-all duration-150 border flex flex-col items-center justify-center gap-0 ${
                unavailable
                  ? slotPast && !slotBusy
                    ? "text-white/15 cursor-not-allowed border-transparent bg-white/[0.02]"
                    : "text-white/15 line-through cursor-not-allowed border-transparent bg-white/[0.02]"
                  : inBooking
                    ? "text-white border-transparent"
                    : isEndMarker
                      ? "text-white border-transparent"
                      : "text-white/70 border-white/[0.08] bg-transparent hover:bg-white/[0.05] hover:border-white/15 hover:text-white"
              }`}
              style={
                inBooking || isEndMarker
                  ? {
                      borderColor: brand,
                      background: isStart || isEndMarker
                        ? `${brand}30`
                        : `${brand}15`,
                    }
                  : undefined
              }
            >
              <span className="leading-tight">{s}</span>
              {rate > 0 && (
                <span className={`text-[9px] leading-tight ${unavailable ? "text-white/10" : "text-white/40"}`}>
                  ${rate.toFixed(0)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ STEP 2 — Review ============
function ReviewStep({
  cart, setCart, brand, onBack, onNext,
}: {
  cart: CartItem[];
  setCart: (fn: (prev: CartItem[]) => CartItem[]) => void;
  brand: string;
  onBack: () => void;
  onNext: () => void;
}) {
  if (cart.length === 0) {
    return (
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
        <ShoppingCart className="w-10 h-10 text-white/20 mx-auto mb-3" />
        <p className="text-white/60 mb-4">Your cart is empty</p>
        <Button onClick={onBack} variant="outline" data-testid="button-back-to-items">
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Add items
        </Button>
      </div>
    );
  }
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Review your cart</h2>
      <div className="space-y-2 mb-5">
        {cart.map(c => (
          <div key={c.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 flex items-start justify-between gap-4" data-testid={`cart-item-${c.id}`}>
            <div className="min-w-0">
              <div className="font-medium">{c.facility.name} {c.halfFull && c.halfFull !== "full" && <span className="text-xs text-white/40">({fieldSizeLabel(c.halfFull, c.halfPosition) || c.halfFull})</span>}</div>
              <div className="text-xs text-white/60 mt-0.5">{fmtDateLong(c.date)} · {fmtTime(c.startTime)} – {fmtTime(c.endTime)}</div>
              {c.addons.length > 0 && (
                <div className="text-[11px] text-white/40 mt-1">
                  + {c.addons.map(a => c.facility.addons.find(x => x.id === a.addonId)?.name).filter(Boolean).join(", ")}
                </div>
              )}
            </div>
            <button onClick={() => setCart(prev => prev.filter(x => x.id !== c.id))} className="text-white/40 hover:text-red-400" data-testid={`button-remove-${c.id}`}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 justify-between">
        <Button variant="outline" onClick={onBack} data-testid="button-back-review">
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Add more
        </Button>
        <Button onClick={onNext} className="text-white border-0" style={{ background: brand }} data-testid="button-continue-details">
          Continue <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}

// ============ STEP 3 — Details ============
function DetailsStep({
  customer, setCustomer, waiverAgreed, setWaiverAgreed, brand, onBack, onSubmit, loading, error,
  allowSplit, allowPayShare, payMode, setPayMode, splitCount, setSplitCount, totalCents,
}: {
  customer: { name: string; email: string; phone: string; club: string; notes: string };
  setCustomer: (c: { name: string; email: string; phone: string; club: string; notes: string }) => void;
  waiverAgreed: boolean;
  setWaiverAgreed: (v: boolean) => void;
  brand: string;
  onBack: () => void;
  onSubmit: () => void;
  loading: boolean;
  error: string | null;
  allowSplit: boolean;
  allowPayShare: boolean;
  payMode: "full" | "split" | "payshare";
  setPayMode: (m: "full" | "split" | "payshare") => void;
  splitCount: number;
  setSplitCount: (n: number) => void;
  totalCents: number;
}) {
  const valid = customer.name.trim() && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email) && waiverAgreed;
  const waiverSections = waiverSectionsFor("public");
  const perShareCents = splitCount > 0 ? Math.round(totalCents / splitCount) : totalCents;
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Your details</h2>
      <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-4 mb-5">
        <div>
          <Label className="text-xs text-white/60 mb-1.5 block">Full name *</Label>
          <Input value={customer.name} onChange={e => setCustomer({ ...customer, name: e.target.value })} data-testid="input-name" className="bg-white/[0.04] border-white/10 text-white" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Email *</Label>
            <Input type="email" value={customer.email} onChange={e => setCustomer({ ...customer, email: e.target.value })} data-testid="input-email" className="bg-white/[0.04] border-white/10 text-white" />
          </div>
          <div>
            <Label className="text-xs text-white/60 mb-1.5 block">Phone</Label>
            <Input value={customer.phone} onChange={e => setCustomer({ ...customer, phone: e.target.value })} data-testid="input-phone" className="bg-white/[0.04] border-white/10 text-white" />
          </div>
        </div>
        <div>
          <Label className="text-xs text-white/60 mb-1.5 block">Club / organisation</Label>
          <Input value={customer.club} onChange={e => setCustomer({ ...customer, club: e.target.value })} data-testid="input-club" className="bg-white/[0.04] border-white/10 text-white" />
        </div>
        <div>
          <Label className="text-xs text-white/60 mb-1.5 block">Notes</Label>
          <Textarea value={customer.notes} onChange={e => setCustomer({ ...customer, notes: e.target.value })} data-testid="input-notes" className="bg-white/[0.04] border-white/10 text-white min-h-[80px]" />
        </div>
      </div>

      {/* Facility Use Terms & Liability Waiver — same agreement as the member
          booking site, with booking/cancellation sections adapted for paid
          public bookings. Must be ticked to continue. */}
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden mb-5">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
          <ScrollText className="w-4 h-4 text-white/40" />
          <div className="text-sm font-semibold">Facility Use Terms &amp; Liability Waiver</div>
          <div className="text-[10px] text-white/30 ml-auto">v{USC_WAIVER_VERSION}</div>
        </div>
        <div className="max-h-64 overflow-y-auto px-5 py-4 space-y-4" data-testid="waiver-scrollbox">
          {waiverSections.map(s => (
            <div key={s.title}>
              <div className="text-xs font-semibold text-white/80 mb-1">{s.title}</div>
              <p className="text-xs text-white/50 leading-relaxed">{s.body}</p>
            </div>
          ))}
        </div>
        <label
          className="flex items-start gap-3 px-5 py-4 border-t border-white/[0.06] cursor-pointer transition"
          style={{ background: waiverAgreed ? `${brand}10` : "rgba(255,255,255,0.02)" }}
        >
          <input
            type="checkbox"
            checked={waiverAgreed}
            onChange={e => setWaiverAgreed(e.target.checked)}
            data-testid="checkbox-waiver"
            className="mt-0.5 w-4 h-4 accent-[#6366f1] flex-shrink-0"
          />
          <span className="text-xs text-white/70 leading-relaxed">
            I have read and agree to the
            <span className="text-white font-medium"> Facility Use Terms &amp; Liability Waiver</span> above
            on behalf of myself and my group, and I accept full liability for any damage and responsibility
            for any injury as set out in those terms.
          </span>
        </label>
      </div>

      {/* Payment method — pay in full, or split it. Two split options can be on
          at once (Player Pay is ours, PayShare is theirs), each behind its own
          venue switch, so either can be turned off without touching the other. */}
      {(allowSplit || allowPayShare) && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 mb-5">
          <div className="text-sm font-semibold mb-3">How would you like to pay?</div>
          <div className="grid gap-3">
            <button type="button" onClick={() => setPayMode("full")}
              className="rounded-xl px-4 py-3 text-left transition-all border"
              style={{ background: payMode === "full" ? `${brand}1f` : "rgba(255,255,255,0.02)", borderColor: payMode === "full" ? brand : "rgba(255,255,255,0.10)" }}
              data-testid="venue-pay-full">
              <div className="font-semibold text-sm">Pay in full</div>
              <div className="text-[12px] text-white/50 mt-0.5">One payment of {money(totalCents)} now.</div>
            </button>
            {allowSplit && (
            <button type="button" onClick={() => setPayMode("split")}
              className="rounded-xl px-4 py-3 text-left transition-all border"
              style={{ background: payMode === "split" ? `${brand}1f` : "rgba(255,255,255,0.02)", borderColor: payMode === "split" ? brand : "rgba(255,255,255,0.10)" }}
              data-testid="venue-pay-split">
              <div className="font-semibold text-sm flex items-center gap-2"><Users className="w-4 h-4" style={{ color: brand }} /> Player Pay — split across your group</div>
              <div className="text-[12px] text-white/50 mt-0.5">Everyone pays their own share on their own card. The booking holds until your group has paid.</div>
            </button>
            )}
            {allowPayShare && (
            <button type="button" onClick={() => setPayMode("payshare")}
              className="rounded-xl px-4 py-3 text-left transition-all border"
              style={{ background: payMode === "payshare" ? `${brand}1f` : "rgba(255,255,255,0.02)", borderColor: payMode === "payshare" ? brand : "rgba(255,255,255,0.10)" }}
              data-testid="venue-pay-payshare">
              <div className="font-semibold text-sm flex items-center gap-2"><Share2 className="w-4 h-4" style={{ color: brand }} /> Split with PayShare</div>
              <div className="text-[12px] text-white/50 mt-0.5">Send one link to your group. PayShare works out the shares and tracks who's paid.</div>
            </button>
            )}
          </div>

          {payMode === "payshare" && (
            <div className="mt-3 rounded-xl p-4" style={{ background: `${brand}12`, border: `1px solid ${brand}3a` }}>
              <div className="text-sm font-semibold">You'll set the group up on PayShare</div>
              <div className="text-[12px] text-white/50 mt-1 leading-relaxed">
                We'll hold your slot, then hand you over to PayShare to invite everyone. Each person pays their
                own share back here on our checkout. The booking is confirmed once the group has finished.
              </div>
            </div>
          )}

          {payMode === "split" && (
            <div className="mt-3 rounded-xl p-4" style={{ background: `${brand}12`, border: `1px solid ${brand}3a` }}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">How many are splitting?</div>
                  <div className="text-[12px] text-white/50 mt-0.5">Including you. They can pay any time before the hold expires.</div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <button type="button" onClick={() => setSplitCount(Math.max(2, splitCount - 1))} disabled={splitCount <= 2}
                    className="w-9 h-9 rounded-full flex items-center justify-center border border-white/10 bg-white/[0.04] text-white disabled:opacity-40" data-testid="venue-split-minus">−</button>
                  <span className="text-xl font-bold tabular-nums w-7 text-center" data-testid="venue-split-count">{splitCount}</span>
                  <button type="button" onClick={() => setSplitCount(Math.min(30, splitCount + 1))} disabled={splitCount >= 30}
                    className="w-9 h-9 rounded-full flex items-center justify-center border border-white/10 bg-white/[0.04] text-white disabled:opacity-40" data-testid="venue-split-plus">+</button>
                </div>
              </div>
              <div className="mt-3 pt-3 flex items-baseline justify-between border-t" style={{ borderColor: `${brand}3a` }}>
                <span className="text-sm text-white/60">Each pays</span>
                <span className="text-2xl font-bold tracking-tight" style={{ color: brand }} data-testid="venue-split-each">{money(perShareCents)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5 mb-5">{error}</div>}

      <div className="flex gap-2 justify-between">
        <Button variant="outline" onClick={onBack} data-testid="button-back-details" disabled={loading}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
        </Button>
        <Button onClick={onSubmit} disabled={!valid || loading} className="text-white border-0" style={{ background: brand }} data-testid="button-continue-payment">
          {loading ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Preparing…</> : payMode === "split" ? <>Start Player Pay <ArrowRight className="w-4 h-4 ml-1.5" /></> : <>Continue to payment <ArrowRight className="w-4 h-4 ml-1.5" /></>}
        </Button>
      </div>
    </div>
  );
}

// ============ STEP 4 — Payment ============
function PaymentStep({
  bookingGroupId, customer, quote, brand, onBack,
}: {
  bookingGroupId: string;
  customer: { email: string; name: string };
  quote: Quote;
  brand: string;
  onBack: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [, setLocation] = useLocation();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true);
    setError(null);
    const returnUrl = `${window.location.origin}/book/success?ref=${bookingGroupId}`;
    const { error: stripeErr, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl, receipt_email: customer.email },
      redirect: "if_required",
    });
    if (stripeErr) {
      setError(stripeErr.message || "Payment failed");
      setProcessing(false);
      return;
    }
    if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")) {
      setLocation(`/book/success?ref=${bookingGroupId}`);
    } else {
      setError("Payment couldn't be processed.");
      setProcessing(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-3 flex items-center gap-2"><Lock className="w-4 h-4 text-white/40" /> Secure payment</h2>
      <form onSubmit={submit} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-4">
        <PaymentElement />
        {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">{error}</div>}
        <div className="flex gap-2 justify-between pt-2">
          <Button type="button" variant="outline" onClick={onBack} disabled={processing} data-testid="button-back-payment">
            <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
          </Button>
          <Button type="submit" disabled={!stripe || processing} className="text-white border-0" style={{ background: brand }} data-testid="button-pay">
            {processing ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Processing…</> : <>Pay {fmtMoney(quote.totalCents)}</>}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ============ Cart sidebar ============
function CartSummary({
  cart, quote, loadingQuote, brand, onRemove, step, discountCode, setDiscountCode, onContinue,
}: {
  cart: CartItem[];
  quote: Quote | null;
  loadingQuote: boolean;
  brand: string;
  onRemove: (id: string) => void;
  step: Step;
  discountCode: string;
  setDiscountCode: (v: string) => void;
  onContinue: () => void;
}) {
  const showContinue = step === "items" && cart.length > 0;
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sticky top-[110px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold flex items-center gap-2"><ShoppingCart className="w-4 h-4" /> Cart</h3>
        <span className="text-xs text-white/40">{cart.length} item{cart.length !== 1 ? "s" : ""}</span>
      </div>
      {cart.length === 0 ? (
        <p className="text-sm text-white/40 py-6 text-center">No items yet. Choose a facility to start.</p>
      ) : (
        <>
          <div className="space-y-2 mb-3 max-h-[40vh] overflow-y-auto">
            {cart.map(c => (
              <div key={c.id} className="text-xs rounded-lg bg-white/[0.03] p-2.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white/90 truncate">{c.facility.name}{fieldSizeLabel(c.halfFull, c.halfPosition) ? ` (${fieldSizeLabel(c.halfFull, c.halfPosition)})` : ""}</div>
                  <div className="text-white/40 mt-0.5">{fmtDateLong(c.date)}</div>
                  <div className="text-white/40">{fmtTime(c.startTime)}–{fmtTime(c.endTime)}</div>
                </div>
                {step === "items" && (
                  <button onClick={() => onRemove(c.id)} className="text-white/30 hover:text-red-400" data-testid={`button-cart-remove-${c.id}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-white/[0.06] pt-3 space-y-1.5 text-xs">
            {/* Promo / member code */}
            <div className="pb-1">
              <Input
                value={discountCode}
                onChange={e => setDiscountCode(e.target.value.toUpperCase())}
                placeholder="Promo / member code"
                className="h-8 text-xs bg-white/[0.04] border-white/10 text-white uppercase placeholder:normal-case placeholder:text-white/30"
                data-testid="input-promo-code"
              />
            </div>
            {loadingQuote ? <Skeleton className="h-4 w-32" /> : quote && (
              <>
                {quote.discount && (quote.discountCents ?? 0) > 0 && (
                  <>
                    <div className="flex justify-between text-white/40 text-[11px]">
                      <span>Subtotal</span><span className="line-through">{fmtMoney(quote.preDiscountCents ?? quote.totalCents)}</span>
                    </div>
                    <div className="flex justify-between text-[11px] font-medium" style={{ color: brand }}>
                      <span>{quote.discount.code}{quote.discount.valueType === "percentage" ? ` (${quote.discount.value}% off)` : ""}</span>
                      <span data-testid="text-cart-discount">−{fmtMoney(quote.discountCents!)}</span>
                    </div>
                  </>
                )}
                <div className="flex justify-between text-white font-semibold text-sm">
                  <span>Total</span><span data-testid="text-cart-total">{fmtMoney(quote.totalCents)}</span>
                </div>
                <div className="flex justify-between text-white/40 text-[11px]">
                  <span>Includes {quote.gstRate}% GST</span><span>{fmtMoney(quote.gstCents)}</span>
                </div>
                {discountCode.trim().length > 0 && !quote.discount && (
                  <div className="text-[11px] text-amber-400/80" data-testid="text-promo-invalid">That code isn't valid for this booking.</div>
                )}
              </>
            )}
          </div>
          {showContinue && (
            <Button onClick={onContinue} className="w-full mt-3 text-white border-0" style={{ background: brand }} data-testid="button-continue-cart">
              Review cart <ArrowRight className="w-4 h-4 ml-1.5" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}

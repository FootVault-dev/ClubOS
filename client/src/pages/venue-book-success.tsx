import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Calendar, Loader2 } from "lucide-react";

interface BookingGroup {
  bookings: any[];
  status: string;
  customerName: string;
  customerEmail: string;
}

const fmtMoney = (c: number) => `$${(c / 100).toFixed(2)}`;
const fmtDateLong = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
};

export default function VenueBookSuccess() {
  const url = new URL(window.location.href);
  const ref = url.searchParams.get("ref") || "";
  // The booking group endpoint requires the customer email as proof of ownership.
  // venue-book.tsx stashes it in sessionStorage at checkout time.
  const stashedEmail = (() => {
    try { return ref ? sessionStorage.getItem(`vbg:${ref}`) || "" : ""; } catch { return ""; }
  })();
  const [data, setData] = useState<BookingGroup | null>(null);
  const [loading, setLoading] = useState(true);

  // Match venue-book.tsx — force dark theme so the shared light-mode polyfill
  // doesn't strip white text into invisible dark slate.
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

  useEffect(() => {
    if (!ref) { setLoading(false); return; }
    if (!stashedEmail) { setLoading(false); return; }
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts++;
      try {
        const r = await fetch(`/api/public/venue/booking-group/${ref}?email=${encodeURIComponent(stashedEmail)}`);
        if (r.ok) {
          const d = await r.json();
          if (!cancelled) setData(d);
          if (d.status === "paid" || attempts >= 5) {
            if (!cancelled) setLoading(false);
            return;
          }
        }
      } catch {}
      if (!cancelled && attempts < 5) setTimeout(poll, 1500);
      else if (!cancelled) setLoading(false);
    };
    // Self-heal: ask the server to confirm the payment against Stripe in case
    // the webhook is slow or didn't fire, then poll picks up the 'paid' state.
    // Idempotent server-side, so this never double-charges or double-emails.
    (async () => {
      try {
        await fetch(`/api/public/venue/booking-group/${ref}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: stashedEmail }),
        });
      } catch {}
      poll();
    })();
    return () => { cancelled = true; };
  }, [ref, stashedEmail]);

  if (!ref) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-white/60">No booking reference provided.</p>
          <Link href="/book"><Button className="mt-4">Make a booking</Button></Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(180deg, #0a0e1a 0%, #050810 100%)" }}>
      <div className="max-w-xl mx-auto px-4 py-12">
        <div className="rounded-3xl border border-white/[0.06] bg-white/[0.02] p-8 text-center">
          {loading ? (
            <>
              <Loader2 className="w-12 h-12 mx-auto text-white/40 animate-spin mb-4" />
              <h1 className="text-xl font-semibold mb-2">Confirming your booking…</h1>
              <p className="text-sm text-white/60">Just a moment while we finalise things.</p>
            </>
          ) : (
            <>
              <div className="w-14 h-14 mx-auto rounded-full bg-emerald-500/15 flex items-center justify-center mb-4">
                <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              </div>
              <h1 className="text-2xl font-bold mb-2" data-testid="text-success-title">
                Booking {data?.status === "paid" ? "confirmed" : "received"}
              </h1>
              <p className="text-sm text-white/60 mb-6">
                {data?.status === "paid"
                  ? "We've sent a confirmation to your email."
                  : "Your payment is processing. We'll email confirmation shortly."}
              </p>

              {data && data.bookings.length > 0 && (
                <div className="text-left rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4 mb-5">
                  <div className="text-xs text-white/40 mb-2 uppercase tracking-wider">Your sessions</div>
                  <ul className="space-y-2">
                    {data.bookings.map((b, i) => (
                      <li key={i} className="text-sm flex items-start gap-2" data-testid={`success-booking-${i}`}>
                        <Calendar className="w-3.5 h-3.5 mt-1 text-white/40 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-white/90">{b.facilityName} {b.halfFull === "half" && <span className="text-white/40 text-xs">({b.halfPosition ? `${b.halfPosition} ` : ""}half)</span>}{b.halfFull === "quarter" && <span className="text-white/40 text-xs">(quarter {b.halfPosition?.toUpperCase()})</span>}</div>
                          <div className="text-xs text-white/50">{fmtDateLong(b.bookingDate)} · {fmtTime(b.startTime)}–{fmtTime(b.endTime)}</div>
                          <div className="text-xs text-white/60 mt-0.5">{fmtMoney(b.totalCents || 0)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="text-xs text-white/40 mb-5">
                Reference: <code className="text-white/60">{ref}</code>
              </div>
              <Link href="/book">
                <Button data-testid="button-make-another">Make another booking</Button>
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

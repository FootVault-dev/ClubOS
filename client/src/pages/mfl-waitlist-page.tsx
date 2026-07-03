import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { initPixel, trackEvent } from "@/lib/meta-pixel";
import { ArrowLeft, ArrowRight, Loader2, CheckCircle2, Clock, BellRing } from "lucide-react";

// MFL premium black + gold brand (matches the landing + register pages).
const BRAND = {
  black: "#000000", bg: "#0a0a0a", card: "#141414", cardSoft: "#1c1c1c", border: "#2a2a2a",
  gold: "#d1b96e", goldDeep: "#a8915a", white: "#ffffff",
  muted: "rgba(255,255,255,0.62)", dim: "rgba(255,255,255,0.38)",
  red: "#f0564f",
};
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";
const PIXEL_CONTENT = "MFL Waitlist";

const inputCls = "w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors";
const inputStyle: React.CSSProperties = { background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white };

export default function MflWaitlistPage() {
  const [, params] = useRoute("/league/:slug/waitlist");
  const slug = params?.slug || "";
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [teamName, setTeamName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [selected, setSelected] = useState<number[]>([]);

  useEffect(() => {
    const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
    if (pixelId) {
      initPixel(pixelId);
      trackEvent("ViewContent", { content_name: PIXEL_CONTENT, content_category: "League Waitlist", currency: "NZD" });
    }
  }, []);

  useEffect(() => {
    fetch(`/api/public/league/register/${slug}`)
      .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then((d) => {
        setData(d);
        // Preselect the night they came from (?division=), else every sold-out night.
        const wantedId = parseInt(new URLSearchParams(window.location.search).get("division") || "");
        const divs = d.divisions || [];
        if (divs.some((x: any) => x.id === wantedId)) setSelected([wantedId]);
        else setSelected(divs.filter((x: any) => x.spotsLeft != null && x.spotsLeft <= 0).map((x: any) => x.id));
      })
      .catch(() => setError("This league isn't available right now."))
      .finally(() => setLoading(false));
  }, [slug]);

  const divisions: any[] = data?.divisions || [];
  const toggle = (id: number) => setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName || !contactName || !email || selected.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = new URL(window.location.href);
      const res = await fetch("/api/public/league/waitlist", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug, teamName, contactName, email, phone,
          divisionIds: selected,
          utmSource: url.searchParams.get("utm_source"),
          utmMedium: url.searchParams.get("utm_medium"),
          utmCampaign: url.searchParams.get("utm_campaign"),
          fbclid: url.searchParams.get("fbclid"),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Something went wrong — please try again.");
      trackEvent("Lead", { content_name: PIXEL_CONTENT, content_category: "League Waitlist", currency: "NZD" });
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.black }}><Skeleton className="h-80 w-96 rounded-2xl" style={{ background: BRAND.card }} /></div>;
  }
  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center px-6" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
        <div><p style={{ color: BRAND.muted }}>{error}</p><Link href="/league"><a className="mt-3 inline-block font-semibold" style={{ color: BRAND.gold }}>See all leagues</a></Link></div>
      </div>
    );
  }

  const soldOutNames = divisions.filter((d) => d.spotsLeft != null && d.spotsLeft <= 0).map((d) => d.name);

  return (
    <div className="min-h-screen" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
      <header className="border-b sticky top-0 z-20" style={{ borderColor: BRAND.border, background: "rgba(0,0,0,0.9)" }}>
        <div className="max-w-2xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href={`/league/${slug}`}>
            <a className="flex items-center gap-2 text-sm" style={{ color: BRAND.muted }}><ArrowLeft className="w-4 h-4" /> Back</a>
          </Link>
          <span className="text-sm" style={{ color: BRAND.dim }}>{data?.program?.name}</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10 pb-20">
        {done ? (
          <div className="text-center py-10" data-testid="waitlist-success">
            <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center" style={{ background: `${BRAND.gold}1f`, border: `1px solid ${BRAND.gold}55` }}>
              <CheckCircle2 className="w-8 h-8" style={{ color: BRAND.gold }} />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-6">You're on the list 🎉</h1>
            <p className="mt-3 max-w-md mx-auto" style={{ color: BRAND.muted }}>
              <strong style={{ color: BRAND.white }}>{teamName}</strong> is on the waitlist. Spots open when a team drops out or we add capacity — and the waitlist gets <strong style={{ color: BRAND.gold }}>first call, in order</strong>. We've emailed you a confirmation.
            </p>
            <Link href={`/league/${slug}`}>
              <a className="inline-flex items-center gap-2 mt-8 px-8 py-3.5 rounded-full font-bold" style={{ background: BRAND.gold, color: BRAND.black }}>
                See nights with spots left <ArrowRight className="w-4 h-4" />
              </a>
            </Link>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider" style={{ color: BRAND.red }}>
              <BellRing className="w-4 h-4" />
              {soldOutNames.length > 0 ? `${soldOutNames.join(" & ")} — sold out` : "High demand"}
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-2">Join the waitlist</h1>
            <p className="mt-1.5" style={{ color: BRAND.muted }}>
              Teams drop out every term — waitlisted teams get <strong style={{ color: BRAND.gold }}>first call, in order</strong>. No payment until a spot opens.
            </p>

            <form onSubmit={handleSubmit} className="mt-8 space-y-6">
              <div className="rounded-2xl p-5 space-y-4" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
                <div>
                  <label className="block text-sm font-semibold mb-2">Team name</label>
                  <input className={inputCls} style={inputStyle} value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="e.g. The Untouchaballs" data-testid="input-waitlist-team-name" />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-2">Which nights would you take?</label>
                  <p className="text-[12px] mb-3" style={{ color: BRAND.dim }}>Pick every night that works — more nights, faster call-up.</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {divisions.map((d: any) => {
                      const full = d.spotsLeft != null && d.spotsLeft <= 0;
                      const active = selected.includes(d.id);
                      return (
                        <button type="button" key={d.id} onClick={() => toggle(d.id)}
                          className="rounded-xl px-4 py-3 text-left transition-all"
                          style={{ background: active ? `${BRAND.gold}1f` : BRAND.cardSoft, border: `1px solid ${active ? BRAND.gold : BRAND.border}` }}
                          data-testid={`waitlist-division-${d.id}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold">{d.name}</span>
                            {full ? (
                              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: `${BRAND.red}22`, color: BRAND.red, border: `1px solid ${BRAND.red}55` }}>Sold out</span>
                            ) : (
                              <span className="text-sm font-bold flex-shrink-0" style={{ color: BRAND.gold }}>{formatCurrency(d.teamCostCents, { fromCents: true })}</span>
                            )}
                          </div>
                          <span className="text-[12px] flex items-center gap-1 mt-0.5" style={{ color: BRAND.muted }}>
                            <Clock className="w-3 h-3" /> {d.dayOfWeek || "Weeknights"}
                            {!full && d.spotsLeft != null ? ` · ${d.spotsLeft} left — you can still register` : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl p-5 space-y-4" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
                <div>
                  <label className="block text-sm font-semibold mb-2">Your name</label>
                  <input className={inputCls} style={inputStyle} value={contactName} onChange={(e) => setContactName(e.target.value)} data-testid="input-waitlist-name" />
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-semibold mb-2">Email</label>
                    <input type="email" className={inputCls} style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-waitlist-email" />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold mb-2">Phone</label>
                    <input type="tel" className={inputCls} style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-waitlist-phone" />
                  </div>
                </div>
              </div>

              {error && <p className="text-sm font-semibold" style={{ color: BRAND.red }}>{error}</p>}

              <button type="submit" disabled={submitting || !teamName || !contactName || !email || selected.length === 0}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-50"
                style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-join-waitlist">
                {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <>Join the waitlist <ArrowRight className="w-4 h-4" /></>}
              </button>
              <p className="text-center text-[12px]" style={{ color: BRAND.dim }}>Free to join · first call when a spot opens · no payment until then</p>
            </form>
          </>
        )}
      </main>
    </div>
  );
}

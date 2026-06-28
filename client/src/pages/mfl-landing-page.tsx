import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { initPixel, trackEvent } from "@/lib/meta-pixel";
import {
  Trophy, Users, Calendar, MapPin, Clock, Zap, ShieldCheck, Star,
  ArrowRight, ChevronDown, Flame, CreditCard, CheckCircle2,
} from "lucide-react";

// MFL premium black + gold brand (matches the MFL app theme).
const BRAND = {
  black: "#000000",
  bg: "#0a0a0a",
  card: "#141414",
  cardSoft: "#1c1c1c",
  border: "#2a2a2a",
  gold: "#d1b96e",
  goldDeep: "#a8915a",
  white: "#ffffff",
  muted: "rgba(255,255,255,0.62)",
  dim: "rgba(255,255,255,0.38)",
};
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";
const MFL_LOGO = "/logos/mini-football-leagues.png";
const PIXEL_CONTENT = "MFL Term 3 Team Registration";

interface Division {
  id: number; name: string; dayOfWeek: string | null; ageGroup: string | null;
  gender: string | null; maxTeams: number | null; teamCostCents: number;
  teamCount: number; spotsLeft: number | null;
}
interface RegisterData {
  program: any;
  organization: { id: number; name: string; slug: string; logoUrl: string | null } | null;
  competition: any;
  divisions: Division[];
  upsells: { type: string; label: string; priceCents: number }[];
  earlyBird: { deadline: string | null; lateFeeCents: number; active: boolean };
  depositCents: number | null;
  paymentPlan?: string;
  numWeeklyPayments?: number;
}

const FAQS = [
  { q: "Who can enter a team?", a: "Anyone! Grab your mates, your workmates, your five-a-side regulars — one person registers as the team captain and you're in." },
  { q: "How many players do I need?", a: "7-a-side runs with 7 on the pitch (bring subs!), 5-a-side needs 5. You can register with a partial squad and fill spots as you go." },
  { q: "What does it cost?", a: "7-a-side is $600 per team for the term, 5-a-side is $500. That's for the whole team across the full season — split it between your players however you like." },
  { q: "Can I pay in instalments?", a: "Yes — that's how it works. Lock your spot with a $120 deposit today, then we spread the rest into automatic weekly payments across the season. Your deposit covers the final weeks, so there's no big bill up front." },
  { q: "When does it run?", a: "Games run weeknights at our Christchurch facility. Pick your night when you register — see the options below." },
];

function Stars() {
  return (
    <span className="inline-flex gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} className="w-4 h-4" style={{ color: BRAND.gold, fill: BRAND.gold }} />
      ))}
    </span>
  );
}

export default function MflLandingPage() {
  const [, params] = useRoute("/league/:slug");
  const slug = params?.slug;
  const [data, setData] = useState<RegisterData | null>(null);
  const [list, setList] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  // League Builders: capture a ?ref=BUILD-… referral code so it carries through
  // to the register page and attributes the referral on checkout.
  useEffect(() => {
    try { const ref = new URLSearchParams(window.location.search).get("ref"); if (ref) sessionStorage.setItem("mfl_ref", ref.trim()); } catch { /* noop */ }
  }, []);

  // Init the shared Meta pixel + ViewContent (tagged for MFL).
  useEffect(() => {
    const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
    if (pixelId) {
      initPixel(pixelId);
      trackEvent("ViewContent", { content_name: PIXEL_CONTENT, content_category: "League Team Registration", currency: "NZD" });
    }
  }, []);

  useEffect(() => {
    const url = slug ? `/api/public/league/register/${slug}` : `/api/public/league/register`;
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then((d) => { if (slug) setData(d); else setList(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.black }}>
        <Skeleton className="h-40 w-80 rounded-2xl" style={{ background: BRAND.card }} />
      </div>
    );
  }

  // ---- Chooser mode: MFL root with multiple/zero specific slugs ----
  if (!slug) {
    const offerings = list?.offerings ?? [];
    return (
      <div className="min-h-screen" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
        <Hero org={list?.organization} headline="Christchurch's #1 Social Football League" sub="7-a-side & 5-a-side. Grab your mates. Play every week." showCta={false} />
        <section className="max-w-4xl mx-auto px-6 py-14">
          <h2 className="text-2xl font-bold mb-6 text-center" style={{ color: BRAND.gold }}>Choose your format</h2>
          {offerings.length === 0 ? (
            <p className="text-center" style={{ color: BRAND.muted }}>Registrations open soon — check back shortly.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-5">
              {offerings.map((o: any) => (
                <Link key={o.id} href={`/league/${o.slug}`}>
                  <a className="block rounded-2xl p-6 transition-transform hover:-translate-y-0.5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
                    <Trophy className="w-7 h-7 mb-3" style={{ color: BRAND.gold }} />
                    <h3 className="text-lg font-bold">{o.name}</h3>
                    {o.descriptionShort && <p className="text-sm mt-1" style={{ color: BRAND.muted }}>{o.descriptionShort}</p>}
                    <span className="inline-flex items-center gap-1.5 mt-4 text-sm font-semibold" style={{ color: BRAND.gold }}>
                      Register your team <ArrowRight className="w-4 h-4" />
                    </span>
                  </a>
                </Link>
              ))}
            </div>
          )}
        </section>
        <Footer />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-center px-6" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
        <div>
          <p style={{ color: BRAND.muted }}>This league isn't available right now.</p>
          <Link href="/league"><a className="mt-3 inline-block font-semibold" style={{ color: BRAND.gold }}>See all leagues</a></Link>
        </div>
      </div>
    );
  }

  const { program, organization, divisions, upsells, earlyBird, depositCents, paymentPlan, numWeeklyPayments } = data;
  const isWeeklyPlan = paymentPlan === "deposit_weekly";
  // Lowest weekly across the nights (varies by 5s/7s), for the "from $X/week" hint.
  const lowestWeeklyCents = isWeeklyPlan && depositCents && divisions.length
    ? Math.min(...divisions.map((d) => Math.round((d.teamCostCents - depositCents) / (numWeeklyPayments || 8))))
    : 0;
  const lowestCents = divisions.length ? Math.min(...divisions.map((d) => d.teamCostCents)) : (program.termPriceCents ?? 0);
  const registerHref = `/league/${slug}/register`;

  return (
    <div className="min-h-screen" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
      <Hero
        org={organization}
        headline={program.heroHeadline || program.name}
        sub={program.heroSubheadline || "Register your team for Term 3. Grab your mates and play every week."}
        ctaHref={registerHref}
        showCta
      />

      {/* Early-bird urgency banner */}
      {earlyBird.active && earlyBird.deadline && (
        <div className="px-6">
          <div className="max-w-4xl mx-auto -mt-6 rounded-xl px-5 py-3 flex items-center justify-center gap-2 text-sm font-semibold"
            style={{ background: `${BRAND.gold}1a`, border: `1px solid ${BRAND.gold}55`, color: BRAND.gold }}>
            <Flame className="w-4 h-4" />
            Early-bird pricing ends {new Date(earlyBird.deadline + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long" })} — register now to skip the late fee.
          </div>
        </div>
      )}

      {/* Key info */}
      <section className="max-w-5xl mx-auto px-6 py-14 grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon: Trophy, label: "Format", value: program.name },
          { icon: CreditCard, label: "From", value: `${formatCurrency(lowestCents, { fromCents: true })} / team` },
          { icon: Calendar, label: "Season", value: "Full term" },
          { icon: MapPin, label: "Where", value: program.location || "Christchurch" },
        ].map((c, i) => (
          <div key={i} className="rounded-2xl p-5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
            <c.icon className="w-5 h-5 mb-2.5" style={{ color: BRAND.gold }} />
            <p className="text-[11px] uppercase tracking-wider" style={{ color: BRAND.dim }}>{c.label}</p>
            <p className="text-[15px] font-semibold mt-0.5">{c.value}</p>
          </div>
        ))}
      </section>

      {/* Pay-in-two explainer */}
      {depositCents != null && depositCents > 0 && (
        <section className="max-w-4xl mx-auto px-6 pb-4">
          <div className="rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-5" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}` }}>
            <div className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: `${BRAND.gold}1f` }}>
              <CreditCard className="w-6 h-6" style={{ color: BRAND.gold }} />
            </div>
            <div>
              <h3 className="text-lg font-bold">{isWeeklyPlan ? "Deposit now, then pay weekly" : "Pay in two — lock your spot today"}</h3>
              <p className="text-sm mt-1" style={{ color: BRAND.muted }}>
                {isWeeklyPlan ? (
                  <>Pay a {formatCurrency(depositCents, { fromCents: true })} deposit now to secure your team{lowestWeeklyCents > 0 ? <>, then from <strong>{formatCurrency(lowestWeeklyCents, { fromCents: true })}/week</strong></> : ", then automatic weekly payments"} across the season. Your deposit covers the final weeks — no big bill up front.</>
                ) : (
                  <>Pay a {formatCurrency(depositCents, { fromCents: true })} deposit now to secure your team. We'll automatically take the balance about three weeks into the term — no chasing your mates for the full amount up front.</>
                )}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Divisions / nights with spots-left */}
      <section className="max-w-5xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center" style={{ color: BRAND.gold }}>Pick your night</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {divisions.map((d) => {
            const full = d.spotsLeft != null && d.spotsLeft <= 0;
            const weeklyCents = isWeeklyPlan && depositCents ? Math.round((d.teamCostCents - depositCents) / (numWeeklyPayments || 8)) : 0;
            return (
              <Link key={d.id} href={`${registerHref}?division=${d.id}`}>
                <a
                  className="group rounded-2xl p-5 flex flex-col transition-all"
                  style={{ background: BRAND.card, border: `1px solid ${BRAND.border}`, opacity: full ? 0.7 : 1, cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = BRAND.gold; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = BRAND.border; }}
                  data-testid={`division-card-${d.id}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold">{d.name}</h3>
                    <span className="text-[15px] font-bold" style={{ color: BRAND.gold }}>{formatCurrency(d.teamCostCents, { fromCents: true })}</span>
                  </div>
                  <p className="text-sm mt-1 flex items-center gap-1.5" style={{ color: BRAND.muted }}>
                    <Clock className="w-3.5 h-3.5" /> {d.dayOfWeek || "Weeknights"}{d.ageGroup ? ` · ${d.ageGroup}` : ""}
                  </p>
                  {weeklyCents > 0 && (
                    <p className="text-[12px] mt-1" style={{ color: BRAND.dim }}>
                      {formatCurrency(depositCents!, { fromCents: true })} deposit · {formatCurrency(weeklyCents, { fromCents: true })}/week
                    </p>
                  )}
                  <div className="flex items-center justify-between mt-3">
                    {d.spotsLeft != null ? (
                      <span className="text-[12px] font-semibold" style={{ color: full ? BRAND.dim : BRAND.gold }}>
                        {full ? "Full — register for the waitlist" : `${d.spotsLeft} spot${d.spotsLeft === 1 ? "" : "s"} left`}
                      </span>
                    ) : <span />}
                    <span className="text-[13px] font-semibold inline-flex items-center gap-1 opacity-80 group-hover:opacity-100" style={{ color: BRAND.gold }}>
                      Register <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </a>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Upsells preview */}
      {upsells.length > 0 && (
        <section className="max-w-4xl mx-auto px-6 pb-12">
          <div className="grid sm:grid-cols-2 gap-4">
            {upsells.map((u) => (
              <div key={u.type} className="rounded-2xl p-5 flex items-center gap-4" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}` }}>
                <Zap className="w-5 h-5 flex-shrink-0" style={{ color: BRAND.gold }} />
                <div className="flex-1">
                  <p className="font-semibold">{u.label}</p>
                  <p className="text-sm" style={{ color: BRAND.muted }}>Add at checkout</p>
                </div>
                <span className="font-bold" style={{ color: BRAND.gold }}>+{formatCurrency(u.priceCents, { fromCents: true })}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Trust */}
      <section className="max-w-4xl mx-auto px-6 py-10 text-center">
        <div className="flex items-center justify-center gap-2 mb-2"><Stars /></div>
        <p style={{ color: BRAND.muted }}>Run by Christchurch United FC · 50+ teams already playing</p>
        <div className="flex items-center justify-center gap-6 mt-5 text-sm" style={{ color: BRAND.dim }}>
          <span className="flex items-center gap-1.5"><Users className="w-4 h-4" /> Social & competitive</span>
          <span className="flex items-center gap-1.5"><ShieldCheck className="w-4 h-4" /> Qualified refs available</span>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-3xl mx-auto px-6 py-12">
        <h2 className="text-2xl font-bold mb-6 text-center" style={{ color: BRAND.gold }}>Questions?</h2>
        <div className="space-y-3">
          {FAQS.map((f, i) => (
            <div key={i} className="rounded-xl overflow-hidden" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
              <button className="w-full flex items-center justify-between px-5 py-4 text-left font-semibold" onClick={() => setOpenFaq(openFaq === i ? null : i)}>
                {f.q}
                <ChevronDown className="w-4 h-4 transition-transform" style={{ color: BRAND.gold, transform: openFaq === i ? "rotate(180deg)" : "none" }} />
              </button>
              {openFaq === i && <p className="px-5 pb-4 text-sm" style={{ color: BRAND.muted }}>{f.a}</p>}
            </div>
          ))}
        </div>
      </section>

      {/* Final CTA */}
      <section className="max-w-3xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold">Ready to play?</h2>
        <p className="mt-2" style={{ color: BRAND.muted }}>Register your team in under two minutes.</p>
        <Link href={registerHref}>
          <a className="inline-flex items-center gap-2 mt-6 px-9 py-3.5 rounded-full font-bold" style={{ background: BRAND.gold, color: BRAND.black }} data-testid="cta-register-bottom">
            Register your team <ArrowRight className="w-4 h-4" />
          </a>
        </Link>
      </section>

      <Footer />

      {/* Sticky mobile CTA */}
      <div className="fixed bottom-0 inset-x-0 sm:hidden px-4 py-3" style={{ background: "rgba(0,0,0,0.92)", borderTop: `1px solid ${BRAND.border}`, paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}>
        <Link href={registerHref}>
          <a className="flex items-center justify-center gap-2 w-full py-3.5 rounded-full font-bold" style={{ background: BRAND.gold, color: BRAND.black }}>
            Register your team <ArrowRight className="w-4 h-4" />
          </a>
        </Link>
      </div>
    </div>
  );
}

function Hero({ org, headline, sub, ctaHref, showCta }: { org: any; headline: string; sub: string; ctaHref?: string; showCta: boolean }) {
  return (
    <header className="relative overflow-hidden" style={{ background: `radial-gradient(120% 80% at 50% 0%, ${BRAND.cardSoft} 0%, ${BRAND.black} 60%)` }}>
      <div className="max-w-3xl mx-auto px-6 pt-16 pb-14 text-center">
        <img src={org?.logoUrl || MFL_LOGO} alt="Mini Football Leagues" className="h-14 w-auto mx-auto mb-8 object-contain" onError={(e) => { (e.currentTarget as HTMLImageElement).src = MFL_LOGO; }} />
        <h1 className="text-3xl sm:text-5xl font-bold leading-[1.08] tracking-tight">{headline}</h1>
        <p className="text-base sm:text-lg mt-4" style={{ color: BRAND.muted }}>{sub}</p>
        {showCta && ctaHref && (
          <Link href={ctaHref}>
            <a className="inline-flex items-center gap-2 mt-8 px-10 py-3.5 rounded-full font-bold shadow-lg" style={{ background: BRAND.gold, color: BRAND.black }} data-testid="cta-register-hero">
              Register your team <ArrowRight className="w-4 h-4" />
            </a>
          </Link>
        )}
        <div className="flex items-center justify-center gap-2 mt-6 text-sm" style={{ color: BRAND.dim }}>
          <Stars /> <span>50+ teams playing</span>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t mt-8" style={{ borderColor: BRAND.border }}>
      <div className="max-w-4xl mx-auto px-6 py-8 text-center text-[12px]" style={{ color: BRAND.dim }}>
        <CheckCircle2 className="w-4 h-4 inline mr-1.5" style={{ color: BRAND.goldDeep }} />
        Mini Football Leagues · Christchurch United Football Club
      </div>
    </footer>
  );
}

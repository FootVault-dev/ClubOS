import { useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useStripe, useElements } from "@stripe/react-stripe-js";
import { Check, X, Lock, ShieldCheck, ArrowRight, Crown, Star, Sparkles, ChevronDown } from "lucide-react";

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "");

const SIU = { black: "#000000", surface: "#0A0A09", card: "#101010", white: "#FFFFFF", gold: "#C59949", green: "#1B3D24", greenLight: "#255434" };
const CREST = "/logos/south-island-united.png";
const AORAKI = "/brand-siu/land-aoraki.png";
const DISPLAY = "'Rough Cut SIU', Georgia, serif";
const BODY = "'Arpona SIU', 'Inter Tight', system-ui, sans-serif";

interface Tier { id: number; name: string; slug: string; tagline: string | null; priceCents: number; billingInterval: string; color: string | null; benefits: string[]; }

const money = (c: number) => `$${((c || 0) / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
const per = (i: string) => (i === "monthly" ? "/mo" : i === "lifetime" ? " once" : "/yr");

const FONTS = `
  @font-face { font-family:'Rough Cut SIU'; src:url('/fonts/siu/RoughCut.otf') format('opentype'); font-weight:400; font-display:swap; }
  @font-face { font-family:'Arpona SIU'; src:url('/fonts/siu/Arpona-Light.otf') format('opentype'); font-weight:300; font-display:swap; }
  @font-face { font-family:'Arpona SIU'; src:url('/fonts/siu/Arpona-Regular.otf') format('opentype'); font-weight:400; font-display:swap; }
  @font-face { font-family:'Arpona SIU'; src:url('/fonts/siu/Arpona-SemiBold.otf') format('opentype'); font-weight:600; font-display:swap; }
  @font-face { font-family:'Arpona SIU'; src:url('/fonts/siu/Arpona-Bold.otf') format('opentype'); font-weight:700; font-display:swap; }
`;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="uppercase font-semibold" style={{ color: SIU.gold, fontSize: "0.7rem", letterSpacing: "0.34em", fontFamily: BODY }}>{children}</p>;
}

const WHY = [
  { title: "Back the club", desc: "Your membership directly funds the players, the academy and the push into the OFC Pro League." },
  { title: "Get closer than ever", desc: "Access, experiences and moments with the team you can't get anywhere else." },
  { title: "One of the family", desc: "Be part of building something new for football in the South Island — from the ground up." },
];

const FAQ = [
  { q: "What am I paying for?", a: "An annual South Island United membership at the tier you choose. It renews yearly — we'll remind you before it does." },
  { q: "When do the benefits start?", a: "Straight away. You'll get a welcome email the moment you join, and we'll be in touch with everything you need to make the most of your tier." },
  { q: "Is my payment secure?", a: "Yes — payments are processed securely by Stripe on South Island United's own checkout. We never see or store your card details." },
  { q: "Can I upgrade later?", a: "Absolutely. Get in touch any time and we'll move you up a tier." },
];

export default function MembershipPage() {
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [orgName, setOrgName] = useState("South Island United");
  const [loading, setLoading] = useState(true);
  const [join, setJoin] = useState<Tier | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/public/membership/tiers")
      .then((r) => r.json())
      .then((d) => { setTiers(d.tiers || []); if (d.organization?.name) setOrgName(d.organization.name); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const scrollToTiers = () => document.getElementById("tiers")?.scrollIntoView({ behavior: "smooth" });

  return (
    <div style={{ background: SIU.black, color: SIU.white, fontFamily: BODY, minHeight: "100vh" }}>
      <style>{FONTS}</style>

      {/* HERO */}
      <section className="relative overflow-hidden" style={{ minHeight: "78vh" }}>
        <div className="absolute inset-0" style={{ backgroundImage: `url(${AORAKI})`, backgroundSize: "cover", backgroundPosition: "center", opacity: 0.36 }} />
        <div className="absolute inset-0" style={{ background: `linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.7) 55%, ${SIU.black} 100%)` }} />
        <div className="relative max-w-4xl mx-auto px-6 flex flex-col items-center text-center justify-center" style={{ minHeight: "78vh", paddingTop: 60, paddingBottom: 60 }}>
          <img src={CREST} alt={orgName} style={{ width: 72, height: 72, objectFit: "contain", marginBottom: 28 }} />
          <Eyebrow>South Island United · Membership</Eyebrow>
          <h1 className="mt-4" style={{ fontFamily: DISPLAY, fontSize: "clamp(2.6rem, 7vw, 4.6rem)", lineHeight: 1.02, textTransform: "uppercase", letterSpacing: "0.01em" }}>
            Join the Club
          </h1>
          <div style={{ height: 2, width: 64, background: SIU.gold, margin: "22px auto" }} />
          <p style={{ color: "rgba(255,255,255,0.75)", fontSize: "clamp(1rem, 2.2vw, 1.2rem)", maxWidth: 560, lineHeight: 1.6 }}>
            Be part of the South Island's professional football club as we take on the OFC Pro League. Choose your tier, get closer to the team, and help build something that lasts.
          </p>
          <button onClick={scrollToTiers} className="mt-9 inline-flex items-center gap-2 font-semibold transition-transform hover:scale-[1.03]"
            style={{ background: SIU.gold, color: SIU.black, padding: "15px 34px", borderRadius: 999, fontSize: 15, letterSpacing: "0.02em" }}>
            Become a member <ArrowRight className="w-4 h-4" />
          </button>
          <p className="mt-14 uppercase" style={{ color: "rgba(255,255,255,0.35)", fontSize: "0.6rem", letterSpacing: "0.3em" }}>The South Island's Professional Football Club</p>
        </div>
      </section>

      {/* WHY */}
      <section className="max-w-5xl mx-auto px-6 py-20 sm:py-24">
        <div className="text-center mb-14">
          <Eyebrow>Why become a member</Eyebrow>
          <h2 className="mt-3" style={{ fontFamily: DISPLAY, fontSize: "clamp(1.8rem,4vw,2.6rem)", textTransform: "uppercase" }}>More than a supporter</h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-5">
          {WHY.map((w, i) => (
            <div key={i} className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: `${SIU.gold}18`, border: `1px solid ${SIU.gold}40` }}>
                {[<Star className="w-5 h-5" style={{ color: SIU.gold }} />, <Sparkles className="w-5 h-5" style={{ color: SIU.gold }} />, <Crown className="w-5 h-5" style={{ color: SIU.gold }} />][i]}
              </div>
              <h3 style={{ fontFamily: DISPLAY, fontSize: "1.15rem", textTransform: "uppercase", marginBottom: 8 }}>{w.title}</h3>
              <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 14, lineHeight: 1.6 }}>{w.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* TIERS */}
      <section id="tiers" className="py-20 sm:py-24" style={{ background: `linear-gradient(180deg, ${SIU.black}, ${SIU.green}22, ${SIU.black})` }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <Eyebrow>Choose your tier</Eyebrow>
            <h2 className="mt-3" style={{ fontFamily: DISPLAY, fontSize: "clamp(1.8rem,4vw,2.6rem)", textTransform: "uppercase" }}>Membership Tiers</h2>
            <p className="mt-3" style={{ color: "rgba(255,255,255,0.5)", fontSize: 15 }}>Secure online sign-up. Instant confirmation.</p>
          </div>
          {loading ? (
            <div className="grid sm:grid-cols-3 gap-5">{[0, 1, 2].map((i) => <div key={i} className="rounded-2xl h-96 animate-pulse" style={{ background: "rgba(255,255,255,0.04)" }} />)}</div>
          ) : tiers.length === 0 ? (
            <p className="text-center" style={{ color: "rgba(255,255,255,0.4)" }}>Membership tiers are being finalised — check back soon.</p>
          ) : (
            <div className="grid sm:grid-cols-3 gap-5 items-start">
              {tiers.map((t, i) => {
                const featured = i === tiers.length - 1;
                const accent = t.color || SIU.gold;
                return (
                  <div key={t.id} className="rounded-2xl p-6 flex flex-col relative"
                    style={{ background: featured ? `linear-gradient(180deg, ${SIU.green}, ${SIU.card})` : SIU.card, border: featured ? `2px solid ${SIU.gold}` : "1px solid rgba(255,255,255,0.09)" }}>
                    {featured && <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full" style={{ background: SIU.gold, color: SIU.black }}>Most Popular</span>}
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-3 h-3 rounded-full" style={{ background: accent }} />
                      <h3 style={{ fontFamily: DISPLAY, fontSize: "1.5rem", textTransform: "uppercase" }}>{t.name}</h3>
                    </div>
                    {t.tagline && <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, marginBottom: 16 }}>{t.tagline}</p>}
                    <div className="flex items-baseline gap-1 mb-5">
                      <span style={{ fontFamily: DISPLAY, fontSize: "2.4rem", color: accent }}>{money(t.priceCents)}</span>
                      <span style={{ color: "rgba(255,255,255,0.45)", fontSize: 14 }}>{per(t.billingInterval)}</span>
                    </div>
                    <div className="space-y-2.5 flex-1 mb-6">
                      {(t.benefits || []).map((b, j) => (
                        <div key={j} className="flex items-start gap-2.5" style={{ fontSize: 13.5, color: "rgba(255,255,255,0.8)", lineHeight: 1.45 }}>
                          <Check className="w-4 h-4 mt-0.5 shrink-0" style={{ color: accent }} /> {b}
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setJoin(t)} className="w-full font-semibold transition-transform hover:scale-[1.02]"
                      style={{ background: featured ? SIU.gold : "transparent", color: featured ? SIU.black : SIU.white, border: featured ? "none" : `1px solid ${SIU.gold}`, padding: "13px", borderRadius: 12, fontSize: 14.5 }}
                      data-testid={`join-${t.slug}`}>
                      Join {t.name}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-2xl mx-auto px-6 py-20">
        <div className="text-center mb-10"><Eyebrow>Good to know</Eyebrow><h2 className="mt-3" style={{ fontFamily: DISPLAY, fontSize: "clamp(1.6rem,4vw,2.2rem)", textTransform: "uppercase" }}>Questions</h2></div>
        <div className="space-y-2">
          {FAQ.map((f, i) => (
            <div key={i} className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
              <button onClick={() => setOpenFaq(openFaq === i ? null : i)} className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left">
                <span style={{ fontWeight: 600, fontSize: 14.5 }}>{f.q}</span>
                <ChevronDown className="w-4 h-4 shrink-0 transition-transform" style={{ color: SIU.gold, transform: openFaq === i ? "rotate(180deg)" : "none" }} />
              </button>
              {openFaq === i && <div className="px-5 pb-4" style={{ color: "rgba(255,255,255,0.6)", fontSize: 13.5, lineHeight: 1.6 }}>{f.a}</div>}
            </div>
          ))}
        </div>
      </section>

      {/* FOOTER */}
      <footer className="py-12 text-center" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <img src={CREST} alt={orgName} style={{ width: 40, height: 40, objectFit: "contain", margin: "0 auto 12px", opacity: 0.8 }} />
        <p className="uppercase" style={{ color: "rgba(255,255,255,0.4)", fontSize: "0.62rem", letterSpacing: "0.28em" }}>South Island United — Uniting the South</p>
      </footer>

      {join && <JoinModal tier={join} onClose={() => setJoin(null)} />}
    </div>
  );
}

// ── Join modal: details → embedded payment → done ────────────────────────────
function JoinModal({ tier, onClose }: { tier: Tier; onClose: () => void }) {
  const [step, setStep] = useState<"details" | "pay" | "done">("details");
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [clientSecret, setClientSecret] = useState("");
  const [memberId, setMemberId] = useState(0);
  const [err, setErr] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const start = async () => {
    if (!form.name.trim() || !form.email.trim()) { setErr("Please enter your name and email."); return; }
    setSubmitting(true); setErr("");
    try {
      const r = await fetch("/api/public/membership/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tierId: tier.id, ...form }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || "Something went wrong. Please try again.");
      setClientSecret(d.clientSecret); setMemberId(d.memberId); setStep("pay");
    } catch (e: any) { setErr(e.message); } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)" }} />
      <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-md rounded-2xl overflow-hidden max-h-[92vh] overflow-y-auto"
        style={{ background: SIU.surface, border: `1px solid ${SIU.gold}33`, fontFamily: BODY, color: SIU.white }}>
        <style>{FONTS}</style>
        <div className="flex items-center justify-between px-6 py-4" style={{ background: `linear-gradient(135deg, ${SIU.black}, ${SIU.green})`, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em]" style={{ color: SIU.gold }}>{tier.name} Membership</div>
            <div style={{ fontFamily: DISPLAY, fontSize: "1.3rem" }}>{money(tier.priceCents)}<span style={{ fontSize: 13, color: "rgba(255,255,255,0.5)" }}>{per(tier.billingInterval)}</span></div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-6">
          {step === "details" && (
            <div className="space-y-3">
              <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13.5, marginBottom: 6 }}>Enter your details to join as a <strong style={{ color: SIU.gold }}>{tier.name}</strong> member.</p>
              {(["name", "email", "phone"] as const).map((k) => (
                <div key={k}>
                  <label className="block text-[11px] uppercase tracking-wide mb-1" style={{ color: "rgba(255,255,255,0.4)" }}>{k === "phone" ? "Phone (optional)" : k}</label>
                  <input value={(form as any)[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))}
                    type={k === "email" ? "email" : "text"} placeholder={k === "email" ? "you@email.com" : k === "phone" ? "021…" : "Your name"}
                    className="w-full rounded-lg px-3 py-2.5 text-[14px] focus:outline-none"
                    style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.12)", color: SIU.white }} />
                </div>
              ))}
              {err && <div className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}>{err}</div>}
              <button onClick={start} disabled={submitting} className="w-full font-semibold mt-2" style={{ background: SIU.gold, color: SIU.black, padding: "13px", borderRadius: 12, fontSize: 14.5, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? "Preparing checkout…" : "Continue to secure payment"}
              </button>
              <div className="flex items-center justify-center gap-4 text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>
                <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Secure</span>
                <span className="flex items-center gap-1"><Lock className="w-3 h-3" /> Stripe</span>
              </div>
            </div>
          )}

          {step === "pay" && clientSecret && (
            <Elements stripe={stripePromise} options={{ clientSecret, appearance: {
              theme: "night",
              variables: { colorPrimary: SIU.gold, colorBackground: "#141412", colorText: "#ffffff", colorTextSecondary: "rgba(255,255,255,0.6)", fontFamily: "system-ui, sans-serif", borderRadius: "10px", fontSizeBase: "14px" },
              rules: { ".Tab--selected": { borderColor: SIU.gold }, ".Input:focus": { borderColor: SIU.gold, boxShadow: `0 0 0 1px ${SIU.gold}` } },
            } }}>
              <PayForm tier={tier} memberId={memberId} email={form.email} name={form.name} onDone={() => setStep("done")} />
            </Elements>
          )}

          {step === "done" && (
            <div className="text-center py-6">
              <div className="w-16 h-16 rounded-full mx-auto flex items-center justify-center mb-4" style={{ background: `${SIU.gold}18`, border: `1px solid ${SIU.gold}` }}>
                <Check className="w-8 h-8" style={{ color: SIU.gold }} />
              </div>
              <h3 style={{ fontFamily: DISPLAY, fontSize: "1.5rem", textTransform: "uppercase", marginBottom: 8 }}>Welcome to the club</h3>
              <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 14, lineHeight: 1.6 }}>You're now a <strong style={{ color: SIU.gold }}>{tier.name}</strong> member. A welcome email is on its way to <strong style={{ color: SIU.white }}>{form.email}</strong>.</p>
              <button onClick={onClose} className="mt-6 font-semibold" style={{ background: "transparent", color: SIU.gold, border: `1px solid ${SIU.gold}`, padding: "11px 26px", borderRadius: 12, fontSize: 14 }}>Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PayForm({ tier, memberId, email, name, onDone }: { tier: Tier; memberId: number; email: string; name: string; onDone: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setProcessing(true); setErr("");
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/membership?joined=1`, receipt_email: email, payment_method_data: { billing_details: { name, email } } },
      redirect: "if_required",
    });
    if (error) { setErr(error.message || "Payment failed. Please try again."); setProcessing(false); return; }
    if (paymentIntent && (paymentIntent.status === "succeeded" || paymentIntent.status === "processing")) {
      try { await fetch("/api/public/membership/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId, paymentIntentId: paymentIntent.id }) }); } catch {}
      onDone();
    } else { setErr("Payment could not be processed. Please try another method."); setProcessing(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PaymentElement options={{ layout: "tabs", defaultValues: { billingDetails: { name, email } } }} />
      {err && <div className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "rgba(239,68,68,0.12)", color: "#fca5a5" }}>{err}</div>}
      <button type="submit" disabled={!stripe || processing} className="w-full font-semibold flex items-center justify-center gap-2"
        style={{ background: SIU.gold, color: SIU.black, padding: "14px", borderRadius: 12, fontSize: 15, opacity: processing ? 0.6 : 1 }}>
        <Lock className="w-4 h-4" /> {processing ? "Processing…" : `Pay ${money(tier.priceCents)}${per(tier.billingInterval)} · NZD`}
      </button>
      <p className="text-center text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>Secured by Stripe · we never store your card details</p>
    </form>
  );
}

import { useEffect, useState, useRef } from "react";
import { Link } from "wouter";
import {
  MapPin, Calendar, Users, ArrowRight, Clock, ChevronDown, ChevronUp,
  Shield, Sparkles, Heart, Zap, Gamepad2, UserPlus, Star, Mountain,
} from "lucide-react";
import { PublicBlock } from "@/components/page-blocks/public-block";

/**
 * South Island United — public holiday-camp landing page.
 *
 * Rendered by CampPage when the camp's owning org is south-island-united;
 * CampPage owns the data fetch, split-test assignment, and Meta pixel events,
 * this component owns the SIU identity: Unity Black, Ambition Gold, Leader
 * Green, Rough Cut display headings, Arpona body (official Pupila brand kit).
 * Same per-camp override contract as the CUFC page: camp.faqJson +
 * camp.pageContentJson (pc.*) + camp.customBlocksJson.
 */

const SIU = {
  black: "#000000",
  surface: "#0A0A09",
  white: "#FFFFFF",
  gold: "#C59949",
  green: "#1B3D24",
  greenLight: "#255434",
};

const CREST = "/logos/south-island-united.png";
const AORAKI = "/brand-siu/land-aoraki.png";

const DISPLAY_FONT = "'Rough Cut SIU', Georgia, serif";
const BODY_FONT = "'Arpona SIU', 'Inter Tight', system-ui, sans-serif";

const defaultFaq = [
  { q: "Does my child need football experience?", a: "Not at all. Our camps are built for every level — from first kicks to club players. Coaches adapt each activity so every child is challenged, included, and having fun." },
  { q: "What should they bring?", a: "Comfortable sports clothing, shin pads, boots or trainers, a water bottle, and sunscreen. Full-day campers should pack lunch and snacks. We provide all footballs and equipment." },
  { q: "What happens if it rains?", a: "Camps run rain or shine. We have covered and indoor options at the United Sports Centre, so the day goes ahead whatever Christchurch weather does." },
  { q: "Can I book multiple days?", a: "Yes — pick individual days or book the full run. Multi-day bookings receive automatic discounts at checkout." },
  { q: "Does my child need to play for South Island United?", a: "No. Our holiday camps are open to all children in the community, whichever club they play for — or if they don't play at all yet. Everyone is welcome." },
];

const defaultSchedule = [
  { time: "9:00 AM", label: "Drop Off & Welcome Games", highlight: false },
  { time: "9:30 AM", label: "Skill Activities & Ball Mastery", highlight: false },
  { time: "10:15 AM", label: "Fun Challenges & Small Games", highlight: false },
  { time: "11:00 AM", label: "Match Play & Themed Games", highlight: false },
  { time: "11:30 AM", label: "Morning Session Pick Up", highlight: true },
  { time: "12:00 PM", label: "Afternoon Session Begins", highlight: true },
  { time: "12:30 PM", label: "Skill Challenges & Competitions", highlight: false },
  { time: "1:30 PM", label: "Team Games & Mini Tournaments", highlight: false },
  { time: "2:30 PM", label: "Cool Down & Awards", highlight: false },
  { time: "3:00 PM", label: "Full Day Pick Up", highlight: true },
];

// Real club facts only — SIU camps are new, so no invented social proof.
const defaultTrust = [
  { title: "Backed by the Pro Club", desc: "South Island United competes in the OFC Pro League — your child trains under the same club banner as the professionals" },
  { title: "Safe & Supervised", desc: "Proper check-in and pick-up procedures with qualified, vetted coaches" },
  { title: "United Sports Centre", desc: "Purpose-built football facility — full-size artificial pitches, cage courts, and indoor options" },
  { title: "Fun First, Skills Second", desc: "Every child leaves smiling, confident, and wanting to come back" },
];

const defaultExperience = [
  { title: "Fun Skill Games", desc: "Age-appropriate drills that feel like play, not practice" },
  { title: "Make New Friends", desc: "A social environment where kids connect and build friendships" },
  { title: "Build Confidence", desc: "Every child is celebrated and encouraged to grow" },
  { title: "The Pro Pathway", desc: "Coached within the club taking South Island players to the professional game" },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="uppercase font-semibold"
      style={{ color: SIU.gold, fontSize: "0.7rem", letterSpacing: "0.34em", fontFamily: BODY_FONT }}
    >
      {children}
    </p>
  );
}

function GoldRule({ center }: { center?: boolean }) {
  return <div style={{ height: 2, width: 56, background: SIU.gold, margin: center ? "0 auto" : undefined }} />;
}

// Mirrors the CUFC ScheduleTimeline (camp-page.tsx) with the SIU palette —
// gold scroll-lit progress line over a Leader Green surface.
function SiuScheduleTimeline({ items }: { items?: { time: string; label: string; highlight?: boolean }[] }) {
  const scheduleData = items && items.length > 0 ? items : defaultSchedule;
  const timelineRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const windowH = window.innerHeight;
      const start = windowH * 0.85;
      const end = windowH * 0.25;
      if (rect.top > start) { setProgress(0); return; }
      const scrolledInto = start - rect.top;
      const scrollRange = start - end + rect.height;
      setProgress(Math.min(1, Math.max(0, scrolledInto / scrollRange)));
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div ref={timelineRef} className="relative">
      <div className="absolute left-[72px] sm:left-[88px] top-0 bottom-0 w-px" style={{ background: "rgba(255,255,255,0.14)" }} />
      <div
        className="absolute left-[72px] sm:left-[88px] top-0 w-px"
        style={{
          height: `${progress * 100}%`,
          background: SIU.gold,
          boxShadow: `0 0 8px ${SIU.gold}60, 0 0 16px ${SIU.gold}30`,
        }}
      />
      <div>
        {scheduleData.map((item, i) => {
          const itemProgress = progress * scheduleData.length;
          const isLit = i < itemProgress;
          const isGlowing = i < itemProgress && i >= itemProgress - 1.5;
          return (
            <div key={i} className="flex items-center gap-4 sm:gap-6 py-3.5 relative" data-testid={`schedule-item-${i}`}>
              <span
                className="text-[13px] sm:text-[14px] font-semibold w-[60px] sm:w-[76px] text-right flex-shrink-0 transition-colors duration-300"
                style={{ color: item.highlight ? SIU.gold : isLit ? SIU.white : "rgba(255,255,255,0.35)", fontFamily: BODY_FONT }}
              >
                {item.time}
              </span>
              <div
                className="w-3 h-3 rounded-full flex-shrink-0 z-10 transition-all duration-300"
                style={{
                  background: isLit ? SIU.gold : "rgba(255,255,255,0.2)",
                  boxShadow: isGlowing ? `0 0 8px ${SIU.gold}, 0 0 16px ${SIU.gold}60` : "none",
                  transform: isGlowing ? "scale(1.3)" : "scale(1)",
                }}
              />
              <span
                className="text-[13px] sm:text-[14px] transition-colors duration-300"
                style={{
                  color: isLit ? SIU.white : "rgba(255,255,255,0.35)",
                  fontWeight: item.highlight || isLit ? 700 : 400,
                  fontFamily: BODY_FONT,
                }}
              >
                {item.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SiuFaqItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }} className="last:border-0">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between py-4 sm:py-5 text-left cursor-pointer group" data-testid={`faq-toggle-${index}`}>
        <span className="font-semibold text-[14px] sm:text-[15px] pr-4" style={{ color: SIU.white, fontFamily: BODY_FONT }}>{q}</span>
        {open
          ? <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: SIU.gold }} />
          : <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: "rgba(255,255,255,0.4)" }} />}
      </button>
      {open && <p className="text-[13px] sm:text-[14px] pb-4 leading-relaxed" style={{ color: "rgba(255,255,255,0.6)", fontFamily: BODY_FONT }}>{a}</p>}
    </div>
  );
}

export default function SiuCampPage({ data, slug, activeVariants, onBookClick }: {
  data: {
    camp: any;
    organization?: { id: number; name: string; slug: string; logoUrl: string | null };
    pricing: any[];
    dates: any[];
    discounts: any[];
  };
  slug: string;
  activeVariants: Record<string, { id: number; value: string }>;
  onBookClick: () => void;
}) {
  const { camp, pricing, discounts } = data;

  let faq: { q: string; a: string }[] = [];
  try { faq = camp.faqJson ? JSON.parse(camp.faqJson) : []; } catch { faq = []; }
  const faqItems = faq.length > 0 ? faq : defaultFaq;

  let pc: any = {};
  try { pc = camp.pageContentJson ? JSON.parse(camp.pageContentJson) : {}; } catch {}
  const pc_schedule = pc.schedule && pc.schedule.length > 0 ? pc.schedule : defaultSchedule;
  const pc_trust = pc.trust && pc.trust.length > 0 ? pc.trust : defaultTrust;
  const pc_experience = pc.experience && pc.experience.length > 0 ? pc.experience : defaultExperience;
  // No default testimonials — SIU camps are first-edition, so social proof
  // renders only once real reviews are supplied via pageContentJson.
  const pc_reviews: any[] = pc.reviews && pc.reviews.length > 0 ? pc.reviews : [];

  const sessionTypes: Record<string, { label: string; timeLabel: string }> = {
    MORNING: { label: "Morning", timeLabel: "9:00am – 12:00pm" },
    AFTERNOON: { label: "Afternoon", timeLabel: "12:00pm – 3:00pm" },
    FULL_DAY: { label: "Full Day", timeLabel: "9:00am – 3:00pm" },
  };
  const fallbackPrices: Record<string, number> = { MORNING: 3000, AFTERNOON: 3000, FULL_DAY: 5000 };
  const priceFor = (pt: string) => {
    const m = (pricing || []).find((p: any) => p.productType === pt);
    return m ? m.priceCents : (fallbackPrices[pt] || 0);
  };
  const lowestPrice = Math.min(...["MORNING", "AFTERNOON", "FULL_DAY"].map(priceFor));

  // Hero media: explicit image wins, then an explicitly-set Wistia video.
  // No CUFC fallback video here — the Aoraki backdrop carries the hero.
  const heroImage = camp.heroImage || "";
  const heroVideoId = heroImage ? null : (camp.heroVideoId || null);

  const bookHref = `/${slug}/${camp.scheduleType === "term" ? "class-book" : "book"}`;

  const glassCard: React.CSSProperties = {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.09)",
    backdropFilter: "blur(12px)",
  };

  return (
    <div className="min-h-screen" style={{ background: SIU.black, fontFamily: BODY_FONT }}>
      <style>{`
        @font-face {
          font-family: 'Rough Cut SIU';
          src: url('/fonts/siu/RoughCut.otf') format('opentype');
          font-weight: 400;
          font-display: swap;
        }
        @font-face {
          font-family: 'Arpona SIU';
          src: url('/fonts/siu/Arpona-Light.otf') format('opentype');
          font-weight: 300;
          font-display: swap;
        }
        @font-face {
          font-family: 'Arpona SIU';
          src: url('/fonts/siu/Arpona-Regular.otf') format('opentype');
          font-weight: 400;
          font-display: swap;
        }
        @font-face {
          font-family: 'Arpona SIU';
          src: url('/fonts/siu/Arpona-SemiBold.otf') format('opentype');
          font-weight: 600;
          font-display: swap;
        }
        @font-face {
          font-family: 'Arpona SIU';
          src: url('/fonts/siu/Arpona-Bold.otf') format('opentype');
          font-weight: 700;
          font-display: swap;
        }
        @keyframes siuFadeInDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes siuFadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        ::selection { background: ${SIU.gold}; color: #000; }
      `}</style>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — HERO (Unity Black, Aoraki backdrop, gold accents)
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden" style={{ background: SIU.black }}>
        {/* Aoraki backdrop, fading into black */}
        <div className="absolute inset-0 pointer-events-none">
          <img
            src={AORAKI}
            alt=""
            aria-hidden="true"
            className="w-full h-full object-cover object-top"
            style={{ opacity: 0.38 }}
          />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.75) 55%, #000 100%)" }} />
          {/* hairline grid with radial mask */}
          <div
            className="absolute inset-0"
            style={{
              opacity: 0.16,
              background: "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)",
              backgroundSize: "72px 72px",
              maskImage: "radial-gradient(ellipse at 50% 20%, #000 30%, transparent 70%)",
              WebkitMaskImage: "radial-gradient(ellipse at 50% 20%, #000 30%, transparent 70%)",
            }}
          />
          {/* ambient gold aura */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] rounded-full" style={{ background: `radial-gradient(ellipse, ${SIU.gold} 0%, transparent 70%)`, opacity: 0.09 }} />
        </div>

        <div className="relative max-w-3xl mx-auto px-6 pt-10 pb-12 md:pt-14 md:pb-16">
          <div className="flex flex-col items-center text-center">
            <div className="mb-5" style={{ animation: "siuFadeInDown 0.6s ease-out" }}>
              <img
                src={CREST}
                alt="South Island United"
                className="w-16 h-16 md:w-20 md:h-20 object-contain drop-shadow-[0_4px_16px_rgba(0,0,0,0.6)]"
                data-testid="img-club-logo"
              />
            </div>

            <div className="mb-4 flex flex-col items-center gap-3" style={{ animation: "siuFadeInUp 0.6s ease-out" }}>
              <Eyebrow>South Island United · Holiday Camps</Eyebrow>
              <GoldRule center />
            </div>

            <h1
              className="uppercase text-[34px] sm:text-5xl md:text-6xl lg:text-[64px] mb-4"
              style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 0.98, letterSpacing: "0.01em", animation: "siuFadeInUp 0.7s ease-out" }}
              data-testid="text-hero-headline"
            >
              {activeVariants.heroHeadline?.value || camp.heroHeadline || camp.name}
            </h1>

            <p
              className="text-[14px] sm:text-[16px] md:text-[17px] leading-relaxed mb-7 max-w-xl font-light"
              style={{ color: "rgba(255,255,255,0.62)", animation: "siuFadeInUp 0.8s ease-out" }}
              data-testid="text-hero-sub"
            >
              {activeVariants.heroSubheadline?.value || camp.heroSubheadline || camp.descriptionShort || "Train under the banner of the South Island's professional football club. Fun, confidence, and first-class coaching — these school holidays at the United Sports Centre."}
            </p>

            {/* Hero media — explicit image or video only */}
            {heroImage ? (
              <div className="w-full max-w-[680px] mb-7" style={{ animation: "siuFadeInUp 0.9s ease-out" }}>
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/60" style={{ border: `1px solid ${SIU.gold}30` }}>
                  <img src={heroImage} alt={camp.name} className="w-full aspect-video object-cover" />
                </div>
              </div>
            ) : heroVideoId ? (
              <div className="w-full max-w-[680px] mb-7" style={{ animation: "siuFadeInUp 0.9s ease-out" }}>
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/60" style={{ border: `1px solid ${SIU.gold}30` }}>
                  <div className="wistia_responsive_padding" style={{ padding: "56.25% 0 0 0", position: "relative" }}>
                    <div className="wistia_responsive_wrapper" style={{ height: "100%", left: 0, position: "absolute", top: 0, width: "100%" }}>
                      <div className={`wistia_embed wistia_async_${heroVideoId} seo=true videoFoam=true`} style={{ height: "100%", position: "relative", width: "100%" }}>
                        <div className="wistia_swatch" style={{ height: "100%", left: 0, opacity: 0, overflow: "hidden", position: "absolute", top: 0, transition: "opacity 200ms", width: "100%" }}>
                          <img src={`https://fast.wistia.com/embed/medias/${heroVideoId}/swatch`} style={{ filter: "blur(5px)", height: "100%", objectFit: "contain", width: "100%" }} alt="" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div style={{ animation: "siuFadeInUp 1s ease-out" }}>
              <Link href={bookHref}>
                <button
                  onClick={onBookClick}
                  className="group relative inline-flex items-center gap-2 px-10 py-4 text-[14px] font-bold uppercase tracking-[0.12em] rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
                  style={{ background: SIU.gold, color: SIU.black, boxShadow: `0 4px 28px ${SIU.gold}45` }}
                  data-testid="button-book-now"
                >
                  {camp.primaryCta || "Book Now"}
                  <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
                </button>
              </Link>
            </div>

            <div className="mt-7" style={{ animation: "siuFadeInUp 1.1s ease-out" }}>
              <p className="text-[10px] sm:text-[11px] uppercase font-semibold" style={{ color: "rgba(255,255,255,0.34)", letterSpacing: "0.3em" }}>
                {pc.trustBadge || "The South Island's Professional Football Club"}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — KEY INFORMATION (glass cards on black)
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative py-14 md:py-20" style={{ background: SIU.surface }}>
        <div className="relative max-w-5xl mx-auto px-6">
          <div className="flex flex-col items-center gap-3 mb-12 text-center">
            <Eyebrow>{pc.keyInfoEyebrow || "The Essentials"}</Eyebrow>
            <h2 className="uppercase text-2xl sm:text-3xl md:text-4xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-key-info-heading">
              {pc.keyInfoTitle || "Key Information"}
            </h2>
            <GoldRule center />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              {
                icon: Users, label: "Age",
                lines: [pc.infoAge || (camp.ageMin != null && camp.ageMax != null ? `${camp.ageMin}–${camp.ageMax} Years` : "All Ages")],
                testid: "info-card-age",
              },
              {
                icon: Calendar, label: "Dates",
                lines: [pc.infoDatesWeek1, pc.infoDatesWeek2, pc.infoDatesNote].filter(Boolean).length
                  ? [pc.infoDatesWeek1, pc.infoDatesWeek2, pc.infoDatesNote].filter(Boolean)
                  : ["School Holidays", "Mon – Fri"],
                testid: "info-card-dates",
              },
              {
                icon: MapPin, label: "Drop Off + Pick Up",
                lines: [pc.infoLocation || camp.location || "United Sports Centre", pc.infoLocationAddress || "466 Yaldhurst Road"],
                testid: "info-card-location",
              },
              {
                icon: Clock, label: "Session Options",
                lines: [
                  pc.infoSessionMorning || "Morning: 9am – 12pm",
                  pc.infoSessionAfternoon || "Afternoon: 12pm – 3pm",
                  pc.infoSessionFullDay || "Full Day: 9am – 3pm",
                ],
                testid: "info-card-sessions",
              },
              {
                icon: Mountain, label: "Price",
                lines: [
                  pc.infoPriceMorning || `Morning $${(priceFor("MORNING") / 100).toFixed(0)}`,
                  pc.infoPriceAfternoon || `Afternoon $${(priceFor("AFTERNOON") / 100).toFixed(0)}`,
                  pc.infoPriceFullDay || `Full Day $${(priceFor("FULL_DAY") / 100).toFixed(0)}`,
                ],
                testid: "info-card-price",
              },
            ].map((card, ci) => (
              <div key={ci} className="rounded-2xl p-5 text-center transition-all duration-300 hover:-translate-y-1" style={glassCard} data-testid={card.testid}>
                <card.icon className="w-5 h-5 mx-auto mb-2.5" style={{ color: SIU.gold }} />
                <p className="text-[10px] uppercase font-semibold mb-1.5" style={{ color: "rgba(255,255,255,0.45)", letterSpacing: "0.2em" }}>{card.label}</p>
                {card.lines.map((line: string, li: number) => (
                  <p key={li} className="text-[13px] font-bold leading-snug" style={{ color: SIU.white }}>{line}</p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — A DAY AT CAMP (Leader Green, gold timeline)
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: `linear-gradient(180deg, ${SIU.green} 0%, #142E1B 100%)` }}>
        <div className="max-w-2xl mx-auto px-6">
          <div className="flex flex-col items-center gap-3 mb-3 text-center">
            <Eyebrow>{pc.scheduleEyebrow || "9am — 3pm"}</Eyebrow>
            <h2 className="uppercase text-xl sm:text-2xl md:text-3xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-schedule-heading">
              {pc.scheduleTitle || "What a Day Looks Like"}
            </h2>
          </div>
          <p className="text-[14px] mb-10 text-center font-light" style={{ color: "rgba(255,255,255,0.6)" }}>
            {pc.scheduleSub || "Morning, afternoon, and full-day options available"}
          </p>
          <SiuScheduleTimeline items={pc_schedule} />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 4 — WHAT YOUR CHILD WILL EXPERIENCE
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: SIU.black }}>
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="flex flex-col items-center gap-3 mb-3">
            <Eyebrow>{pc.experienceEyebrow || "Every Session"}</Eyebrow>
            <h2 className="uppercase text-xl sm:text-2xl md:text-3xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-experience-heading">
              {pc.experienceTitle || "What Your Child Will Experience"}
            </h2>
            <GoldRule center />
          </div>
          <p className="text-[14px] mb-10 max-w-lg mx-auto font-light" style={{ color: "rgba(255,255,255,0.55)" }}>
            {pc.experienceSub || "A safe, fun environment where every child builds confidence and falls in love with football"}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {pc_experience.map((item: any, i: number) => {
              const icons = [Gamepad2, UserPlus, Sparkles, Zap];
              const Icon = icons[i] || Sparkles;
              return (
                <div key={i} className="rounded-xl p-5 text-center hover:-translate-y-0.5 transition-all duration-300" style={{ ...glassCard, boxShadow: `0 0 12px ${SIU.gold}0F, 0 0 24px ${SIU.gold}08` }} data-testid={`experience-card-${i}`}>
                  <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: `${SIU.gold}14` }}>
                    <Icon className="w-5 h-5" style={{ color: SIU.gold }} />
                  </div>
                  <h3 className="text-[14px] font-bold mb-1" style={{ color: SIU.white }}>{item.title}</h3>
                  <p className="text-[12px] leading-relaxed" style={{ color: "rgba(255,255,255,0.5)" }}>{item.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5 — WHY FAMILIES CHOOSE SIU (Innovation White break)
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: SIU.white }}>
        <div className="max-w-4xl mx-auto px-6">
          <div className="flex flex-col items-center gap-3 mb-3 text-center">
            <p className="uppercase font-semibold" style={{ color: SIU.green, fontSize: "0.7rem", letterSpacing: "0.34em" }}>
              {pc.trustEyebrow || "Uniting the South"}
            </p>
            <h2 className="uppercase text-xl sm:text-2xl md:text-3xl text-center" style={{ color: SIU.black, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-trust-heading">
              {pc.trustTitle || "Why Families Choose South Island United"}
            </h2>
            <div style={{ height: 2, width: 56, background: SIU.gold }} />
          </div>
          <p className="text-[14px] mb-10 text-center" style={{ color: "rgba(0,0,0,0.45)" }}>
            {pc.trustSub || "A professional club with community at its core"}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
            {pc_trust.map((item: any, i: number) => {
              const icons = [Shield, Heart, Zap, Sparkles];
              const Icon = icons[i] || Shield;
              return (
                <div key={i} className="rounded-xl p-5 flex gap-4 items-start transition-all hover:shadow-md" style={{ background: "#FAFAF8", border: "1px solid rgba(0,0,0,0.07)" }} data-testid={`trust-card-${i}`}>
                  <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: `${SIU.green}0F` }}>
                    <Icon className="w-5 h-5" style={{ color: SIU.green }} />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-bold mb-0.5" style={{ color: SIU.black }}>{item.title}</h3>
                    <p className="text-[12px] sm:text-[13px] leading-relaxed" style={{ color: "rgba(0,0,0,0.45)" }}>{item.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
            {[
              { value: pc.statOne || "OFC Pro League", label: pc.statOneLabel || "Professional Football" },
              { value: pc.statTwo || "United Sports Centre", label: pc.statTwoLabel || "Purpose-Built Home" },
              { value: pc.statThree || "All Levels", label: pc.statThreeLabel || "First Kicks Welcome" },
            ].map((stat, i) => (
              <div key={i} className="text-center" data-testid={`stat-${i}`}>
                <p className="uppercase text-[18px] sm:text-[22px]" style={{ color: SIU.green, fontFamily: DISPLAY_FONT }}>{stat.value}</p>
                <p className="text-[12px] font-medium mt-1" style={{ color: "rgba(0,0,0,0.4)" }}>{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 6 — PRICING + BOOKING
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative py-12 md:py-16 overflow-hidden" style={{ background: SIU.black }} id="pricing">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full" style={{ background: `radial-gradient(ellipse, ${SIU.gold} 0%, transparent 70%)`, opacity: 0.07 }} />
        </div>
        <div className="relative max-w-4xl mx-auto px-6">
          <div className="flex flex-col items-center gap-3 mb-3 text-center">
            <Eyebrow>{pc.pricingEyebrow || "Sessions"}</Eyebrow>
            <h2 className="uppercase text-xl sm:text-2xl md:text-3xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-pricing-heading">
              {pc.pricingTitle || "Choose Your Session"}
            </h2>
            <GoldRule center />
          </div>
          <p className="text-[14px] mb-10 text-center font-light" style={{ color: "rgba(255,255,255,0.55)" }}>
            {pc.pricingSub || "Simple online booking. Secure payment. Instant confirmation."}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {["MORNING", "AFTERNOON", "FULL_DAY"].map((type) => {
              const info = sessionTypes[type] || { label: type, timeLabel: "" };
              const isFullDay = type === "FULL_DAY";
              const priceCents = priceFor(type);
              return (
                <div
                  key={type}
                  className={`rounded-2xl p-6 text-center transition-all duration-300 hover:-translate-y-1 relative ${isFullDay ? "shadow-lg" : ""}`}
                  style={{
                    background: isFullDay ? `linear-gradient(180deg, ${SIU.green} 0%, #142E1B 100%)` : "rgba(255,255,255,0.04)",
                    border: isFullDay ? `2px solid ${SIU.gold}` : "1px solid rgba(255,255,255,0.12)",
                    boxShadow: isFullDay ? `0 0 20px ${SIU.gold}26, 0 0 40px ${SIU.gold}0D` : "none",
                  }}
                  data-testid={`price-card-${type}`}
                >
                  {isFullDay && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] px-3 py-1 rounded-full uppercase tracking-wider font-bold" style={{ background: SIU.gold, color: SIU.black }}>
                      Best Value
                    </span>
                  )}
                  <Clock className="w-6 h-6 mx-auto mb-2" style={{ color: isFullDay ? SIU.gold : "rgba(255,255,255,0.5)" }} />
                  <h3 className="text-[16px] font-bold" style={{ color: SIU.white }}>{info.label}</h3>
                  <p className="text-[12px] mt-0.5" style={{ color: "rgba(255,255,255,0.4)" }}>{info.timeLabel}</p>
                  <p className="text-3xl font-bold mt-4" style={{ color: SIU.white }}>
                    ${(priceCents / 100).toFixed(0)}
                  </p>
                  <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>NZD per day</p>
                </div>
              );
            })}
          </div>
          {discounts.length > 0 && (
            <div className="max-w-md mx-auto mb-8 p-4 rounded-xl text-center" style={{ background: `${SIU.gold}12`, border: `1px solid ${SIU.gold}30` }}>
              <p className="text-[13px] font-semibold" style={{ color: SIU.gold }}>
                {discounts.map((d: any) => `Book ${d.minBookings}+ sessions and save ${d.discountPercent}%`).join(" · ")}
              </p>
            </div>
          )}
          <div className="text-center">
            <Link href={bookHref}>
              <button
                onClick={onBookClick}
                className="group inline-flex items-center gap-2 px-10 py-4 text-[14px] font-bold uppercase tracking-[0.12em] rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
                style={{ background: SIU.gold, color: SIU.black, boxShadow: `0 4px 28px ${SIU.gold}40` }}
                data-testid="button-book-pricing"
              >
                Book Now
                <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
              </button>
            </Link>
            <p className="text-[12px] mt-3" style={{ color: "rgba(255,255,255,0.4)" }}>{pc.pricingFootnote || "Places are limited for each day"}</p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 7 — TESTIMONIALS (only when real reviews are supplied)
      ═══════════════════════════════════════════════════════════════ */}
      {pc_reviews.length > 0 && (
        <section className="py-12 md:py-16" style={{ background: SIU.surface }}>
          <div className="max-w-6xl mx-auto px-6">
            <div className="flex flex-col items-center gap-3 mb-8 text-center">
              <Eyebrow>{pc.reviewsEyebrow || "From the Sideline"}</Eyebrow>
              <h2 className="uppercase text-xl sm:text-2xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }}>
                {pc.reviewsSectionTitle || "What Parents Are Saying"}
              </h2>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-2 -mx-6 px-6 snap-x snap-mandatory" data-testid="reviews-carousel">
              {pc_reviews.map((review: any, i: number) => (
                <div key={i} className="snap-start min-w-[300px] sm:min-w-[360px] rounded-2xl p-6 sm:p-7 flex flex-col gap-3.5" style={glassCard} data-testid={`review-card-${i}`}>
                  <div className="flex gap-0.5">
                    {Array.from({ length: review.stars || 5 }).map((_, j) => (
                      <Star key={j} className="w-3.5 h-3.5" style={{ fill: SIU.gold, color: SIU.gold }} />
                    ))}
                  </div>
                  <h4 className="text-[16px] font-bold leading-snug" style={{ color: SIU.white }}>{review.highlight}</h4>
                  <p className="text-[13px] sm:text-[14px] leading-relaxed flex-1" style={{ color: "rgba(255,255,255,0.55)" }}>"{review.text}"</p>
                  <div className="flex items-center gap-3 pt-3" style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold" style={{ background: SIU.green, color: SIU.white }}>
                      {String(review.name || "").split(" ").map((n: string) => n[0]).join("")}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold" style={{ color: SIU.white }}>{review.name}</p>
                      <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.4)" }}>{review.role}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 8 — FAQ
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: SIU.surface }}>
        <div className="max-w-2xl mx-auto px-6">
          <div className="flex flex-col items-center gap-3 mb-6 text-center">
            <Eyebrow>{pc.faqEyebrow || "Good to Know"}</Eyebrow>
            <h2 className="uppercase text-xl sm:text-2xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-faq-heading">
              Frequently Asked Questions
            </h2>
          </div>
          <div className="rounded-2xl px-5 sm:px-6" style={glassCard} data-testid="faq-section">
            {faqItems.slice(0, 5).map((item: any, i: number) => (
              <SiuFaqItem key={i} q={item.q} a={item.a} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 9 — FINAL CTA
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden py-16 md:py-20" style={{ background: `linear-gradient(160deg, ${SIU.black} 30%, ${SIU.green} 130%)` }}>
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full" style={{ background: `radial-gradient(circle, ${SIU.gold} 0%, transparent 70%)`, opacity: 0.08 }} />
        </div>
        <div className="relative max-w-2xl mx-auto px-6 text-center">
          <div className="flex flex-col items-center gap-3 mb-4">
            <Eyebrow>{pc.finalCtaEyebrow || "These School Holidays"}</Eyebrow>
            <h2 className="uppercase text-2xl sm:text-3xl md:text-4xl" style={{ color: SIU.white, fontFamily: DISPLAY_FONT, lineHeight: 1 }} data-testid="text-final-cta">
              {pc.finalCtaTitle || "Give Your Child a Holiday They'll Love"}
            </h2>
          </div>
          <p className="text-[14px] sm:text-[16px] mb-8 font-light" style={{ color: "rgba(255,255,255,0.55)" }}>
            {pc.finalCtaSub || "Limited places. Professional club environment. Easy online booking."}
          </p>
          <Link href={bookHref}>
            <button
              onClick={onBookClick}
              className="group inline-flex items-center gap-2 px-10 py-4 text-[14px] font-bold uppercase tracking-[0.12em] rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
              style={{ background: SIU.gold, color: SIU.black, boxShadow: `0 4px 28px ${SIU.gold}45` }}
              data-testid="button-book-cta-bottom"
            >
              Book Now
              <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
            </button>
          </Link>
          <p className="text-[11px] mt-4" style={{ color: "rgba(255,255,255,0.3)" }}>
            {pc.finalCtaFootnote || "Secure online booking in under 2 minutes"}
          </p>
        </div>
      </section>

      {/* CUSTOM SECTIONS — admin-added blocks */}
      {Array.isArray(camp.customBlocksJson) && camp.customBlocksJson.length > 0 && (
        <>
          {camp.customBlocksJson.map((block: any) => (
            <PublicBlock key={block.id} block={block} primaryButtonHref={bookHref} />
          ))}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          FOOTER
      ═══════════════════════════════════════════════════════════════ */}
      <footer style={{ background: SIU.black, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="max-w-4xl mx-auto px-6 py-8">
          <div className="flex flex-col items-center text-center">
            <img src={CREST} alt="South Island United" className="w-10 h-10 object-contain opacity-60 mb-3" />
            <p className="text-[11px] uppercase font-semibold mb-4" style={{ color: "rgba(255,255,255,0.35)", letterSpacing: "0.3em" }}>
              South Island United · Uniting the South
            </p>
            <div className="flex items-center gap-5 mb-4">
              <a href="/privacy" className="text-[11px] hover:underline" style={{ color: "rgba(255,255,255,0.3)" }} data-testid="link-privacy">Privacy Policy</a>
              <a href="/terms" className="text-[11px] hover:underline" style={{ color: "rgba(255,255,255,0.3)" }} data-testid="link-terms">Terms & Conditions</a>
            </div>
            <div className="w-full max-w-xs h-px mb-4" style={{ background: "rgba(255,255,255,0.06)" }} />
            <p className="text-[9px] leading-relaxed max-w-md mb-3" style={{ color: "rgba(255,255,255,0.15)" }}>
              {pc.footerDisclaimer || "This site is not part of the Facebook website or Facebook Inc. Additionally, this site is NOT endorsed by Facebook in any way. FACEBOOK is a trademark of FACEBOOK, Inc."}
            </p>
            <p className="text-[11px]" style={{ color: "rgba(255,255,255,0.2)" }}>
              &copy; {new Date().getFullYear()} South Island United. All Rights Reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* STICKY MOBILE CTA */}
      <div className="fixed bottom-0 left-0 right-0 md:hidden z-50 p-3" style={{ background: "rgba(0,0,0,0.92)", backdropFilter: "blur(12px)", borderTop: `1px solid ${SIU.gold}30`, boxShadow: "0 -4px 20px rgba(0,0,0,0.5)" }}>
        <Link href={bookHref}>
          <button
            onClick={onBookClick}
            className="w-full py-3.5 text-[13px] font-bold uppercase tracking-[0.1em] rounded-full transition-all duration-300 cursor-pointer"
            style={{ background: SIU.gold, color: SIU.black }}
            data-testid="button-book-sticky"
          >
            {pc.stickyCtaText || `Book Now — From $${(lowestPrice / 100).toFixed(0)}/session`}
          </button>
        </Link>
      </div>
    </div>
  );
}

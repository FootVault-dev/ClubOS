import { useEffect, useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { Tent, MapPin, Calendar, Users, DollarSign, ArrowRight, Clock, ChevronDown, ChevronUp, Star, ChevronRight, ChevronLeft, Shield, Sparkles, Heart, Zap, Gamepad2, UserPlus, Sun, CloudRain, CalendarCheck, HelpCircle } from "lucide-react";
import { initPixel, trackEvent } from "@/lib/meta-pixel";
import cuFcLogoPath from "@assets/CUFC_LOGO_1772823768518.png";
import { PublicBlock } from "@/components/page-blocks/public-block";
import SiuCampPage from "./siu-camp-page";
import { SIU_ORG_SLUG } from "@/lib/camp-brand";

const BRAND = {
  blue: "#22399B",
  white: "#FBFBFC",
  gold: "#D9B10F",
  darkBlue: "#221F7A",
};

const reviews = [
  {
    highlight: "Best Holiday Camp in Canterbury",
    text: "My kids have been going to CUFC holiday camps since they were 4 years old. The coaches are amazing, the activities are fun, and they come home exhausted and happy every single day. Wouldn't send them anywhere else.",
    name: "Sarah Mitchell",
    role: "Parent of 2",
    stars: 5,
  },
  {
    highlight: "My Son's Confidence Has Skyrocketed",
    text: "He used to be so shy on the field, but after just one camp he was running around making friends and loving every minute. The coaches really know how to bring out the best in every child regardless of ability.",
    name: "James Crawford",
    role: "Parent",
    stars: 5,
  },
  {
    highlight: "Worth Every Single Dollar",
    text: "We've tried other holiday programmes and nothing compares. The organisation, the skill development, and the genuine care the coaches show — it's a level above. Our daughter asks to go back every holidays.",
    name: "Michelle Thompson",
    role: "Parent of 3",
    stars: 5,
  },
  {
    highlight: "Safe, Fun and Professional",
    text: "As a parent, safety is my number one priority. CUFC runs an incredibly well-organised camp with proper check-in procedures and qualified coaches. My kids have a blast and I have complete peace of mind.",
    name: "David Chen",
    role: "Parent",
    stars: 5,
  },
  {
    highlight: "They Actually Learn Real Skills",
    text: "It's not just babysitting — my children genuinely improve their football skills every camp. The drills are age-appropriate and the coaches make learning fun. Both my boys can't wait for the next school holidays.",
    name: "Rachel Nguyen",
    role: "Parent of 2",
    stars: 5,
  },
];

const defaultFaq = [
  { q: "Does my child need football experience?", a: "Not at all! Our camps are designed for all skill levels. Whether your child is kicking a ball for the first time or already plays in a team, our coaches adapt activities so everyone has fun and improves." },
  { q: "What should they bring?", a: "Comfortable sports clothing, shin pads, boots or trainers, a water bottle, and sunscreen. For full-day campers, please pack a lunch and snacks. We provide all footballs and equipment." },
  { q: "What happens if it rains?", a: "Our camps run rain or shine! We have access to covered and indoor facilities at the Christchurch Football Centre, so your child will always have a great experience regardless of weather." },
  { q: "Can I book multiple days?", a: "Absolutely! You can pick and choose individual days or book the full week. Multi-day bookings receive automatic discounts at checkout." },
  { q: "Does my child need to be a CUFC player?", a: "No — our holiday camps are open to all children in the community, regardless of which club they play for or whether they play at all. Everyone is welcome." },
];

const schedule = [
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

const trustPoints = [
  { icon: Shield, title: "Trusted Since 2014", desc: "Canterbury families have relied on CUFC for over a decade" },
  { icon: Heart, title: "Safe & Supervised", desc: "Proper check-in procedures with qualified, vetted coaches" },
  { icon: Zap, title: "Professional Facilities", desc: "Christchurch Football Centre — purpose-built for football" },
  { icon: Sparkles, title: "Fun First, Skills Second", desc: "Every child leaves smiling, confident, and wanting to come back" },
];

function ScheduleTimeline({ items }: { items?: { time: string; label: string; highlight?: boolean }[] }) {
  const scheduleData = items && items.length > 0 ? items : schedule;
  const timelineRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const handleScroll = () => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const windowH = window.innerHeight;
      const start = windowH * 0.85;
      const end = windowH * 0.25;
      const totalHeight = rect.height;

      if (rect.top > start) {
        setProgress(0);
        return;
      }

      const scrolledInto = start - rect.top;
      const scrollRange = start - end + totalHeight;
      const pct = Math.min(1, Math.max(0, scrolledInto / scrollRange));
      setProgress(pct);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div ref={timelineRef} className="relative">
      <div className="absolute left-[72px] sm:left-[88px] top-0 bottom-0 w-px" style={{ background: 'rgba(251,251,252,0.12)' }} />
      <div
        className="absolute left-[72px] sm:left-[88px] top-0 w-px transition-none"
        style={{
          height: `${progress * 100}%`,
          background: `linear-gradient(180deg, ${BRAND.gold}, ${BRAND.gold})`,
          boxShadow: `0 0 8px ${BRAND.gold}60, 0 0 16px ${BRAND.gold}30`,
        }}
      />
      <div className="space-y-0">
        {scheduleData.map((item, i) => {
          const itemProgress = progress * scheduleData.length;
          const isLit = i < itemProgress;
          const isGlowing = i < itemProgress && i >= itemProgress - 1.5;
          return (
            <div key={i} className="flex items-center gap-4 sm:gap-6 py-3.5 relative" data-testid={`schedule-item-${i}`}>
              <span
                className="text-[13px] sm:text-[14px] font-semibold w-[60px] sm:w-[76px] text-right flex-shrink-0 transition-colors duration-300"
                style={{ color: item.highlight ? BRAND.gold : isLit ? BRAND.white : 'rgba(251,251,252,0.35)' }}
              >
                {item.time}
              </span>
              <div
                className="w-3 h-3 rounded-full flex-shrink-0 z-10 transition-all duration-300"
                style={{
                  background: isLit ? BRAND.gold : 'rgba(251,251,252,0.2)',
                  boxShadow: isGlowing ? `0 0 8px ${BRAND.gold}, 0 0 16px ${BRAND.gold}60` : 'none',
                  transform: isGlowing ? 'scale(1.3)' : 'scale(1)',
                }}
              />
              <span
                className="text-[13px] sm:text-[14px] transition-colors duration-300"
                style={{
                  color: isLit ? BRAND.white : 'rgba(251,251,252,0.35)',
                  fontWeight: item.highlight || isLit ? 700 : 400,
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

function FAQItem({ q, a, index }: { q: string; a: string; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="last:border-0" style={{ borderBottom: '1px solid rgba(34,57,155,0.3)' }}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between py-4 sm:py-5 text-left cursor-pointer group" data-testid={`faq-toggle-${index}`}>
        <span className="font-semibold text-[14px] sm:text-[15px] pr-4 transition-colors" style={{ color: BRAND.white }}>{q}</span>
        {open ? <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: BRAND.gold }} /> : <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(251,251,252,0.4)' }} />}
      </button>
      {open && <p className="text-[13px] sm:text-[14px] pb-4 leading-relaxed" style={{ color: 'rgba(251,251,252,0.6)' }}>{a}</p>}
    </div>
  );
}

function ReviewCard({ review, index }: { review: typeof reviews[0]; index: number }) {
  return (
    <div
      className="min-w-[300px] sm:min-w-[360px] bg-white rounded-2xl border border-slate-100 p-6 sm:p-7 flex flex-col gap-3.5 shadow-sm hover:shadow-md transition-shadow duration-300"
      data-testid={`review-card-${index}`}
    >
      <div className="flex gap-0.5">
        {Array.from({ length: review.stars }).map((_, i) => (
          <Star key={i} className="w-3.5 h-3.5 fill-[#D9B10F] text-[#D9B10F]" />
        ))}
      </div>
      <h4 className="text-[16px] font-bold text-slate-900 leading-snug">{review.highlight}</h4>
      <p className="text-[13px] sm:text-[14px] text-slate-500 leading-relaxed flex-1">"{review.text}"</p>
      <div className="flex items-center gap-3 pt-3 border-t border-slate-50">
        <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold" style={{ background: BRAND.blue }}>
          {review.name.split(' ').map(n => n[0]).join('')}
        </div>
        <div>
          <p className="text-[13px] font-semibold text-slate-800">{review.name}</p>
          <p className="text-[11px] text-slate-400">{review.role}</p>
        </div>
      </div>
    </div>
  );
}

export default function CampPage() {
  const [, params] = useRoute("/:slug");
  const slug = params?.slug || "";
  const reviewsRef = useRef<HTMLDivElement>(null);

  const [activeVariants, setActiveVariants] = useState<Record<string, { id: number; value: string }>>({});

  const { data, isLoading, error } = useQuery<{
    camp: any;
    organization?: { id: number; name: string; slug: string; logoUrl: string | null };
    pricing: any[];
    dates: any[];
    discounts: any[];
    splitTests?: any[];
  }>({
    queryKey: ["/api/public/camps", slug],
    queryFn: async () => {
      const res = await fetch(`/api/public/camps/${slug}`);
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
  });

  useEffect(() => {
    if (!data?.splitTests || data.splitTests.length === 0) return;
    const variantMap: Record<string, { id: number; value: string }> = {};
    for (const st of data.splitTests) {
      if (st.variant) {
        variantMap[st.field] = { id: st.variant.id, value: st.variant.value };
        fetch("/api/public/split-test/view", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantId: st.variant.id }),
        }).catch(() => {});
      }
    }
    setActiveVariants(variantMap);
    if (typeof window !== "undefined") {
      (window as any)._cufc_split_variants = variantMap;
    }
  }, [data?.splitTests]);

  useEffect(() => {
    if (data?.camp) {
      const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
      if (pixelId) {
        initPixel(pixelId);
        trackEvent("ViewContent", {
          content_name: data.camp.name,
          content_category: "Holiday Camp",
          content_ids: [data.camp.slug],
        });
      }
    }
  }, [data]);

  // Hero media: image wins over video when both are set. Otherwise fall back
  // to the default Wistia id so legacy camps keep their video. SIU camps get
  // no CUFC default — their page only plays an explicitly-set video.
  const heroImage = data?.camp?.heroImage || "";
  const isSiuCamp = data?.organization?.slug === SIU_ORG_SLUG;
  const heroVideoId = heroImage ? null : (data?.camp?.heroVideoId || (isSiuCamp ? null : "0l469en6m5"));
  useEffect(() => {
    if (!heroVideoId) return;
    const wistiaScript = document.createElement("script");
    wistiaScript.src = `https://fast.wistia.com/embed/medias/${heroVideoId}.jsonp`;
    wistiaScript.async = true;
    document.head.appendChild(wistiaScript);

    const wistiaLib = document.createElement("script");
    wistiaLib.src = "https://fast.wistia.com/assets/external/E-v1.js";
    wistiaLib.async = true;
    document.head.appendChild(wistiaLib);

    return () => {
      try { document.head.removeChild(wistiaScript); } catch {}
      try { document.head.removeChild(wistiaLib); } catch {}
    };
  }, [heroVideoId]);

  const scrollReviews = (direction: "left" | "right") => {
    if (reviewsRef.current) {
      reviewsRef.current.scrollBy({
        left: direction === "right" ? 400 : -400,
        behavior: "smooth",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen" style={{ background: BRAND.white, fontFamily: "'Inter Tight', sans-serif" }}>
        <div className="max-w-4xl mx-auto px-6 py-16 space-y-8">
          <Skeleton className="h-16 w-16 rounded-full mx-auto bg-slate-100" />
          <Skeleton className="h-12 w-3/4 mx-auto bg-slate-100" />
          <Skeleton className="h-6 w-1/2 mx-auto bg-slate-100" />
          <Skeleton className="h-[300px] w-full rounded-2xl bg-slate-100" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.white, fontFamily: "'Inter Tight', sans-serif" }}>
        <div className="text-center">
          <Tent className="w-16 h-16 text-slate-200 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-700 mb-2">Camp not found</h2>
          <Link href="/"><button className="text-[#22399B] text-[14px] font-semibold hover:underline cursor-pointer" data-testid="link-back">Back to camps</button></Link>
        </div>
      </div>
    );
  }

  // South Island United camps render their own full-brand page (Unity Black /
  // Ambition Gold / Rough Cut). This component still owns the data fetch,
  // split-test assignment, and Meta pixel events for both clubs.
  if (data.organization?.slug === SIU_ORG_SLUG) {
    return (
      <SiuCampPage
        data={data}
        slug={slug}
        activeVariants={activeVariants}
        onBookClick={() => {
          const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
          if (pixelId) {
            trackEvent("InitiateCheckout", {
              content_name: data.camp.name,
              content_category: "Holiday Camp",
              value: (data.pricing.length > 0 ? Math.min(...data.pricing.map((p: any) => p.priceCents)) : 0) / 100,
              currency: "NZD",
            });
          }
        }}
      />
    );
  }

  const { camp, pricing, dates, discounts } = data;
  let faq: { q: string; a: string }[] = [];
  try { faq = camp.faqJson ? JSON.parse(camp.faqJson) : []; } catch { faq = []; }
  const faqItems = faq.length > 0 ? faq : defaultFaq;
  const lowestPrice = pricing.length > 0 ? Math.min(...pricing.map((p: any) => p.priceCents)) : 0;

  let pc: any = {};
  try { pc = camp.pageContentJson ? JSON.parse(camp.pageContentJson) : {}; } catch {}
  const pc_reviews = pc.reviews && pc.reviews.length > 0 ? pc.reviews : reviews;
  const pc_schedule = pc.schedule && pc.schedule.length > 0 ? pc.schedule : schedule;
  const pc_trust = pc.trust && pc.trust.length > 0 ? pc.trust : trustPoints.map(t => ({ title: t.title, desc: t.desc }));
  const pc_experience = pc.experience && pc.experience.length > 0 ? pc.experience : null;

  const handleBookClick = () => {
    const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
    if (pixelId) {
      trackEvent("InitiateCheckout", {
        content_name: camp.name,
        content_category: "Holiday Camp",
        value: lowestPrice / 100,
        currency: "NZD",
      });
    }
  };

  const sessionTypes: Record<string, { label: string; timeLabel: string; order: number }> = {
    MORNING: { label: "Morning", timeLabel: "9:00am – 12:00pm", order: 1 },
    AFTERNOON: { label: "Afternoon", timeLabel: "12:00pm – 3:00pm", order: 2 },
    FULL_DAY: { label: "Full Day", timeLabel: "9:00am – 3:00pm", order: 3 },
  };

  const hardcodedPrices: Record<string, number> = {
    MORNING: 3000,
    AFTERNOON: 3000,
    FULL_DAY: 5000,
  };

  const dateRange = camp.startDate && camp.endDate
    ? `${new Date(camp.startDate + 'T12:00:00').toLocaleDateString('en-NZ', { day: 'numeric' })}–${new Date(camp.endDate + 'T12:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'long' })}`
    : 'TBD';

  return (
    <div className="min-h-screen" style={{ fontFamily: "'Inter Tight', sans-serif" }}>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 1 — HERO
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden" style={{ background: `linear-gradient(180deg, ${BRAND.darkBlue} 0%, ${BRAND.blue} 100%)` }}>
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] opacity-[0.07] rounded-full" style={{ background: `radial-gradient(ellipse, ${BRAND.gold} 0%, transparent 70%)` }} />
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        </div>

        <div className="relative max-w-3xl mx-auto px-6 pt-8 pb-10 md:pt-10 md:pb-12">
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 animate-[fadeInDown_0.6s_ease-out]">
              <img
                src={data?.organization?.logoUrl || cuFcLogoPath}
                alt={data?.organization?.name || "Christchurch United FC"}
                className="w-14 h-14 md:w-18 md:h-18 object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.4)]"
                data-testid="img-club-logo"
              />
            </div>

            <h1
              className="text-[28px] sm:text-4xl md:text-5xl lg:text-[52px] font-bold tracking-tight leading-[1.08] mb-3 animate-[fadeInUp_0.7s_ease-out]"
              style={{ color: BRAND.white }}
              data-testid="text-hero-headline"
            >
              {activeVariants.heroHeadline?.value || camp.heroHeadline || camp.name}
            </h1>

            <p
              className="text-[14px] sm:text-[16px] md:text-[18px] leading-relaxed mb-6 max-w-xl animate-[fadeInUp_0.8s_ease-out]"
              style={{ color: 'rgba(251,251,252,0.55)' }}
              data-testid="text-hero-sub"
            >
              {activeVariants.heroSubheadline?.value || camp.heroSubheadline || camp.descriptionShort || "Fun, engaging football camps for young players. Build confidence, make friends, and fall in love with football."}
            </p>

            {/* Hero media — image wins over video. */}
            {heroImage ? (
              <div className="w-full max-w-[680px] mb-6 animate-[fadeInUp_0.9s_ease-out]">
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/40" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                  <img src={heroImage} alt={camp.name} className="w-full aspect-video object-cover" />
                </div>
              </div>
            ) : heroVideoId ? (
              <div className="w-full max-w-[680px] mb-6 animate-[fadeInUp_0.9s_ease-out]">
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/40" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="wistia_responsive_padding" style={{ padding: '56.25% 0 0 0', position: 'relative' }}>
                    <div className="wistia_responsive_wrapper" style={{ height: '100%', left: 0, position: 'absolute', top: 0, width: '100%' }}>
                      <div className={`wistia_embed wistia_async_${heroVideoId} seo=true videoFoam=true`} style={{ height: '100%', position: 'relative', width: '100%' }}>
                        <div className="wistia_swatch" style={{ height: '100%', left: 0, opacity: 0, overflow: 'hidden', position: 'absolute', top: 0, transition: 'opacity 200ms', width: '100%' }}>
                          <img src={`https://fast.wistia.com/embed/medias/${heroVideoId}/swatch`} style={{ filter: 'blur(5px)', height: '100%', objectFit: 'contain', width: '100%' }} alt="" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="animate-[fadeInUp_1s_ease-out]">
              <Link href={`/${slug}/${camp.scheduleType === "term" ? "class-book" : "book"}`}>
                <button
                  onClick={handleBookClick}
                  className="group relative inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
                  style={{ background: BRAND.white, color: BRAND.blue, boxShadow: '0 4px 24px rgba(34,57,155,0.3)' }}
                  data-testid="button-book-now"
                >
                  {camp.primaryCta || "Book Now"}
                  <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
                </button>
              </Link>
            </div>

            <div className="mt-6 animate-[fadeInUp_1.1s_ease-out]">
              <p className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-semibold mb-2" style={{ color: 'rgba(251,251,252,0.28)' }}>
                {pc.trustBadge || "Trusted by 1,000+ Parents since 2014"}
              </p>
              <div className="flex items-center justify-center gap-0.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="w-3.5 h-3.5 fill-[#D9B10F] text-[#D9B10F]" />
                ))}
                <span className="ml-1.5 text-[12px] font-semibold" style={{ color: 'rgba(251,251,252,0.4)' }}>5.0</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 2 — TESTIMONIALS
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16 overflow-hidden" style={{ background: BRAND.darkBlue }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
                {pc.reviewsSectionTitle || "What Parents Are Saying"}
              </h2>
              <p className="text-[13px] mt-0.5" style={{ color: 'rgba(251,251,252,0.45)' }}>{pc.reviewsSectionSub || "Real reviews from real families"}</p>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <button onClick={() => scrollReviews("left")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 hover:text-white hover:border-white/40 transition-colors cursor-pointer" data-testid="button-reviews-left">
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button onClick={() => scrollReviews("right")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 hover:text-white hover:border-white/40 transition-colors cursor-pointer" data-testid="button-reviews-right">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div ref={reviewsRef} className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 -mx-6 px-6 snap-x snap-mandatory" data-testid="reviews-carousel">
            {pc_reviews.map((review: any, i: number) => (
              <div key={i} className="snap-start"><ReviewCard review={review} index={i} /></div>
            ))}
          </div>
          <div className="flex sm:hidden items-center justify-center gap-2 mt-4">
            <button onClick={() => scrollReviews("left")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 cursor-pointer" data-testid="button-reviews-left-mobile"><ChevronLeft className="w-4 h-4" /></button>
            <button onClick={() => scrollReviews("right")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 cursor-pointer" data-testid="button-reviews-right-mobile"><ChevronRight className="w-4 h-4" /></button>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 3 — KEY INFORMATION
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative py-14 md:py-20 overflow-hidden" style={{ background: BRAND.white }}>
        <div className="relative max-w-5xl mx-auto px-6">
          <h2
            className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-center mb-12"
            style={{ color: BRAND.darkBlue }}
            data-testid="text-key-info-heading"
          >
            {pc.keyInfoTitle || "Key Information"}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">

            <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }} data-testid="info-card-age">
              <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `linear-gradient(90deg, transparent, ${BRAND.blue}, transparent)`, boxShadow: `0 0 12px ${BRAND.blue}, 0 0 24px ${BRAND.blue}40` }} />
                <div className="relative z-10">
                  <Users className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                  <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Age</p>
                  <p className="text-[15px] font-bold" style={{ color: BRAND.white }}>{pc.infoAge || "3–8 Years"}</p>
                </div>
              </div>
            </div>

            <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }} data-testid="info-card-dates">
              <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `linear-gradient(90deg, transparent, ${BRAND.blue}, transparent)`, boxShadow: `0 0 12px ${BRAND.blue}, 0 0 24px ${BRAND.blue}40` }} />
                <div className="relative z-10">
                  <Calendar className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                  <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Dates</p>
                  <p className="text-[13px] font-bold leading-snug" style={{ color: BRAND.white }}>
                    {pc.infoDatesWeek1 || "Week 1: 6–10 April"}
                  </p>
                  <p className="text-[13px] font-bold leading-snug" style={{ color: BRAND.white }}>
                    {pc.infoDatesWeek2 || "Week 2: 13–17 April"}
                  </p>
                  <p className="text-[10px] mt-1" style={{ color: 'rgba(251,251,252,0.4)' }}>{pc.infoDatesNote || "Mon – Fri"}</p>
                </div>
              </div>
            </div>

            <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }} data-testid="info-card-location">
              <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `linear-gradient(90deg, transparent, ${BRAND.blue}, transparent)`, boxShadow: `0 0 12px ${BRAND.blue}, 0 0 24px ${BRAND.blue}40` }} />
                <div className="relative z-10">
                  <MapPin className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                  <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Drop Off + Pick Up</p>
                  <p className="text-[14px] font-bold" style={{ color: BRAND.white }}>{pc.infoLocation || "United Sports Centre"}</p>
                  <p className="text-[12px] mt-0.5" style={{ color: 'rgba(251,251,252,0.5)' }}>{pc.infoLocationAddress || "466 Yaldhurst Road"}</p>
                </div>
              </div>
            </div>

            <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }} data-testid="info-card-sessions">
              <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `linear-gradient(90deg, transparent, ${BRAND.blue}, transparent)`, boxShadow: `0 0 12px ${BRAND.blue}, 0 0 24px ${BRAND.blue}40` }} />
                <div className="relative z-10">
                  <Clock className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                  <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Session Options</p>
                  <p className="text-[12px] font-semibold" style={{ color: BRAND.white }}>{pc.infoSessionMorning || "Morning: 9am – 12pm"}</p>
                  <p className="text-[12px] font-semibold" style={{ color: BRAND.white }}>{pc.infoSessionAfternoon || "Afternoon: 12pm – 3pm"}</p>
                  <p className="text-[12px] font-semibold" style={{ color: BRAND.white }}>{pc.infoSessionFullDay || "Full Day: 9am – 3pm"}</p>
                </div>
              </div>
            </div>

            <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }} data-testid="info-card-price">
              <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[60%] h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `linear-gradient(90deg, transparent, ${BRAND.blue}, transparent)`, boxShadow: `0 0 12px ${BRAND.blue}, 0 0 24px ${BRAND.blue}40` }} />
                <div className="relative z-10">
                  <DollarSign className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                  <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Price</p>
                  <p className="text-[13px] font-bold" style={{ color: BRAND.white }}>{pc.infoPriceMorning || "Morning $30"}</p>
                  <p className="text-[13px] font-bold" style={{ color: BRAND.white }}>{pc.infoPriceAfternoon || "Afternoon $30"}</p>
                  <p className="text-[13px] font-bold" style={{ color: BRAND.white }}>{pc.infoPriceFullDay || "Full Day $50"}</p>
                </div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 4 — TYPICAL CAMP DAY
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: BRAND.blue }}>
        <div className="max-w-2xl mx-auto px-6">
          <h2 className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2 text-center" style={{ color: BRAND.gold }} data-testid="text-schedule-heading">
            {pc.scheduleTitle || "What a Day Looks Like"}
          </h2>
          <p className="text-[14px] mb-10 text-center" style={{ color: BRAND.white }}>
            {pc.scheduleSub || "Morning, afternoon, and full-day options available"}
          </p>
          <ScheduleTimeline items={pc_schedule} />
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 5 — WHAT YOUR CHILD WILL EXPERIENCE
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: BRAND.darkBlue }}>
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2" style={{ color: BRAND.white }} data-testid="text-experience-heading">
            {pc.experienceTitle || "What Your Child Will Experience"}
          </h2>
          <p className="text-[14px] mb-10 max-w-lg mx-auto" style={{ color: 'rgba(251,251,252,0.55)' }}>
            {pc.experienceSub || "A safe, fun environment where every child builds confidence and falls in love with football"}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(pc_experience || [
              { title: "Fun Skill Games", desc: "Age-appropriate drills that feel like play, not practice" },
              { title: "Make New Friends", desc: "Social environment where kids connect and build friendships" },
              { title: "Build Confidence", desc: "Every child is celebrated and encouraged to grow" },
              { title: "Learn Through Play", desc: "Real football skills developed through engaging activities" },
            ]).map((item: any, i: number) => {
              const icons = [Gamepad2, UserPlus, Sparkles, Zap];
              const Icon = icons[i] || Sparkles;
              return (
              <div key={i} className="rounded-xl p-5 text-center hover:-translate-y-0.5 transition-all duration-300" style={{ background: BRAND.blue, border: `1px solid rgba(217,177,15,0.2)`, boxShadow: `0 0 12px rgba(217,177,15,0.08), 0 0 24px rgba(217,177,15,0.04)` }} data-testid={`experience-card-${i}`}>
                <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: 'rgba(217,177,15,0.1)' }}>
                  <Icon className="w-5 h-5" style={{ color: BRAND.gold }} />
                </div>
                <h3 className="text-[14px] font-bold mb-1" style={{ color: BRAND.white }}>{item.title}</h3>
                <p className="text-[12px] leading-relaxed" style={{ color: 'rgba(251,251,252,0.5)' }}>{item.desc}</p>
              </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 6 — WHY PARENTS TRUST CUFC
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: '#f8f9fb' }}>
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-2 text-center" data-testid="text-trust-heading">
            {pc.trustTitle || "Why Families Choose Christchurch United"}
          </h2>
          <p className="text-[14px] text-slate-400 mb-10 text-center">
            {pc.trustSub || "A club and community you can trust"}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
            {pc_trust.map((item: any, i: number) => {
              const icons = [Shield, Heart, Zap, Sparkles];
              const Icon = icons[i] || Shield;
              return (
              <div key={i} className="bg-white rounded-xl border border-slate-100 p-5 flex gap-4 items-start hover:shadow-sm transition-all" data-testid={`trust-card-${i}`}>
                <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: `${BRAND.blue}0A` }}>
                  <Icon className="w-5 h-5" style={{ color: BRAND.blue }} />
                </div>
                <div>
                  <h3 className="text-[14px] font-bold text-slate-800 mb-0.5">{item.title}</h3>
                  <p className="text-[12px] sm:text-[13px] text-slate-400 leading-relaxed">{item.desc}</p>
                </div>
              </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
            {[
              { value: pc.statFamilies || "1,000+", label: "Families" },
              { value: pc.statEstablished || "Since 2014", label: "Established" },
              { value: pc.statRating || "5.0", label: "Star Rating", showStars: true },
            ].map((stat, i) => (
              <div key={i} className="text-center" data-testid={`stat-${i}`}>
                <p className="text-2xl sm:text-3xl font-bold" style={{ color: BRAND.blue }}>{stat.value}</p>
                <div className="flex items-center justify-center gap-1 mt-1">
                  {stat.showStars && Array.from({ length: 5 }).map((_, j) => (
                    <Star key={j} className="w-3 h-3 fill-[#D9B10F] text-[#D9B10F]" />
                  ))}
                  {!stat.showStars && <p className="text-[12px] text-slate-400 font-medium">{stat.label}</p>}
                </div>
                {stat.showStars && <p className="text-[12px] text-slate-400 font-medium mt-0.5">{stat.label}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 7 — PRICING + BOOKING
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: BRAND.blue }} id="pricing">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2 text-center" style={{ color: BRAND.gold }} data-testid="text-pricing-heading">
            {pc.pricingTitle || "Choose Your Session"}
          </h2>
          <p className="text-[14px] mb-10 text-center" style={{ color: 'rgba(251,251,252,0.6)' }}>
            {pc.pricingSub || "Simple online booking. Secure payment. Instant confirmation."}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {["MORNING", "AFTERNOON", "FULL_DAY"].map((type) => {
              const info = sessionTypes[type] || { label: type, timeLabel: "", order: 0 };
              const isFullDay = type === "FULL_DAY";
              const priceCents = hardcodedPrices[type] || 0;
              return (
                <div
                  key={type}
                  className={`rounded-2xl p-6 text-center transition-all duration-300 hover:-translate-y-1 relative ${isFullDay ? 'shadow-lg' : ''}`}
                  style={{
                    background: isFullDay ? BRAND.darkBlue : 'rgba(251,251,252,0.08)',
                    border: isFullDay ? `2px solid ${BRAND.gold}` : '1px solid rgba(251,251,252,0.15)',
                    boxShadow: isFullDay ? `0 0 20px rgba(217,177,15,0.15), 0 0 40px rgba(217,177,15,0.05)` : 'none',
                  }}
                  data-testid={`price-card-${type}`}
                >
                  {isFullDay && <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] px-3 py-1 rounded-full uppercase tracking-wider font-bold text-white" style={{ background: BRAND.gold }}>Best Value</span>}
                  <Clock className="w-6 h-6 mx-auto mb-2" style={{ color: isFullDay ? BRAND.gold : 'rgba(251,251,252,0.5)' }} />
                  <h3 className="text-[16px] font-bold" style={{ color: BRAND.white }}>{info.label}</h3>
                  <p className="text-[12px] mt-0.5" style={{ color: 'rgba(251,251,252,0.4)' }}>{info.timeLabel}</p>
                  <p className="text-3xl font-bold mt-4" style={{ color: BRAND.white }}>
                    ${(priceCents / 100).toFixed(0)}
                  </p>
                  <p className="text-[11px]" style={{ color: 'rgba(251,251,252,0.35)' }}>NZD per day</p>
                </div>
              );
            })}
          </div>
          {discounts.length > 0 && (
            <div className="max-w-md mx-auto mb-8 p-4 rounded-xl text-center" style={{ background: 'rgba(217,177,15,0.1)', border: '1px solid rgba(217,177,15,0.2)' }}>
              <p className="text-[13px] font-semibold" style={{ color: BRAND.gold }}>
                {discounts.map((d: any) => `Book ${d.minBookings}+ sessions and save ${d.discountPercent}%`).join(' · ')}
              </p>
            </div>
          )}
          <div className="text-center">
            <Link href={`/${slug}/book`}>
              <button
                onClick={handleBookClick}
                className="glow-border-btn group inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
                style={{ background: BRAND.gold, color: BRAND.darkBlue }}
                data-testid="button-book-pricing"
              >
                Book Now
                <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
              </button>
            </Link>
            <p className="text-[12px] mt-3" style={{ color: 'rgba(251,251,252,0.4)' }}>{pc.pricingFootnote || "Places are limited for each day"}</p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 8 — FAQ
      ═══════════════════════════════════════════════════════════════ */}
      <section className="py-12 md:py-16" style={{ background: BRAND.darkBlue }}>
        <div className="max-w-2xl mx-auto px-6">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight mb-6 text-center" style={{ color: BRAND.gold }} data-testid="text-faq-heading">
            Frequently Asked Questions
          </h2>
          <div className="rounded-2xl px-5 sm:px-6" style={{ background: BRAND.blue, border: '1px solid rgba(34,57,155,0.5)' }} data-testid="faq-section">
            {faqItems.slice(0, 5).map((item: any, i: number) => (
              <FAQItem key={i} q={item.q} a={item.a} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 9 — FINAL CTA
      ═══════════════════════════════════════════════════════════════ */}
      <section className="relative overflow-hidden py-16 md:py-20" style={{ background: `linear-gradient(135deg, ${BRAND.darkBlue} 0%, ${BRAND.blue} 100%)` }}>
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] opacity-[0.06] rounded-full" style={{ background: `radial-gradient(circle, ${BRAND.gold} 0%, transparent 70%)` }} />
        </div>
        <div className="relative max-w-2xl mx-auto px-6 text-center">
          <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ color: BRAND.white }} data-testid="text-final-cta">
            {pc.finalCtaTitle || "Give Your Child a Holiday They'll Love"}
          </h2>
          <p className="text-[14px] sm:text-[16px] mb-8" style={{ color: 'rgba(251,251,252,0.55)' }}>
            {pc.finalCtaSub || "Limited places available. Fun, safe environment. Easy online booking."}
          </p>
          <Link href={`/${slug}/book`}>
            <button
              onClick={handleBookClick}
              className="group inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full transition-all duration-300 hover:scale-[1.03] active:scale-[0.98] cursor-pointer"
              style={{ background: BRAND.white, color: BRAND.blue, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}
              data-testid="button-book-cta-bottom"
            >
              Book Now
              <ArrowRight className="w-4 h-4 transition-transform duration-300 group-hover:translate-x-1" />
            </button>
          </Link>
          <p className="text-[11px] mt-4" style={{ color: 'rgba(251,251,252,0.3)' }}>
            {pc.finalCtaFootnote || "Secure online booking in under 2 minutes"}
          </p>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          CUSTOM SECTIONS — admin-added blocks render between FAQ and footer
      ═══════════════════════════════════════════════════════════════ */}
      {Array.isArray(camp.customBlocksJson) && camp.customBlocksJson.length > 0 && (
        <>
          {camp.customBlocksJson.map((block: any) => (
            <PublicBlock key={block.id} block={block} primaryButtonHref={`/${slug}/${camp.scheduleType === "term" ? "class-book" : "book"}`} />
          ))}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          SECTION 10 — FOOTER
      ═══════════════════════════════════════════════════════════════ */}
      <footer style={{ background: BRAND.darkBlue }}>
        <div className="max-w-4xl mx-auto px-6 py-8">
          <div className="flex flex-col items-center text-center">
            <img src={data?.organization?.logoUrl || cuFcLogoPath} alt={data?.organization?.name || "Christchurch United FC"} className="w-10 h-10 object-contain opacity-50 mb-3" />
            <p className="text-[12px] font-semibold mb-4" style={{ color: 'rgba(251,251,252,0.35)' }}>{data?.organization?.name || "Christchurch United Football Club"}</p>
            <div className="flex items-center gap-5 mb-4">
              <a href="/privacy" className="text-[11px] hover:underline transition-colors" style={{ color: 'rgba(251,251,252,0.3)' }} data-testid="link-privacy">Privacy Policy</a>
              <a href="/terms" className="text-[11px] hover:underline transition-colors" style={{ color: 'rgba(251,251,252,0.3)' }} data-testid="link-terms">Terms & Conditions</a>
            </div>
            <div className="w-full max-w-xs h-px mb-4" style={{ background: 'rgba(251,251,252,0.06)' }} />
            <p className="text-[9px] leading-relaxed max-w-md mb-3" style={{ color: 'rgba(251,251,252,0.15)' }}>
              {pc.footerDisclaimer || "This site is not part of the Facebook website or Facebook Inc. Additionally, this site is NOT endorsed by Facebook in any way. FACEBOOK is a trademark of FACEBOOK, Inc."}
            </p>
            <p className="text-[11px]" style={{ color: 'rgba(251,251,252,0.2)' }}>
              &copy; {new Date().getFullYear()} Christchurch United FC. All Rights Reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* STICKY MOBILE CTA */}
      <div className="fixed bottom-0 left-0 right-0 md:hidden z-50 bg-white/95 backdrop-blur-lg border-t border-slate-100 p-3 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]">
        <Link href={`/${slug}/book`}>
          <button
            onClick={handleBookClick}
            className="w-full py-3 text-[14px] font-bold rounded-full transition-all duration-300 cursor-pointer text-white"
            style={{ background: BRAND.blue }}
            data-testid="button-book-sticky"
          >
            {pc.stickyCtaText || "Book Now — From $30/session"}
          </button>
        </Link>
      </div>

      <style>{`
        @keyframes fadeInDown {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

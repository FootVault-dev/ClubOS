import { useState, useEffect, useRef, useCallback } from "react";
import { useRoute, useLocation } from "wouter";
import { useProgramRoute } from "@/lib/program-path";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft, Save, Loader2, Star, ChevronDown, ChevronUp, ArrowRight,
  MapPin, Calendar, Users, DollarSign, Clock, Shield, Sparkles, Heart,
  Zap, Gamepad2, UserPlus, ChevronRight, ChevronLeft,
  Eye, FlaskConical, Plus, X, Trash2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWorkspace } from "@/lib/workspace-context";
import { AiCopyButton } from "@/components/ui/ai-copy-button";
import { AiPageBriefButton, type PageDraft } from "@/components/ui/ai-page-brief-button";
import { BlocksEditor } from "@/components/page-blocks/blocks-editor";
import { ImagePicker } from "@/components/ui/image-picker";
import type { PageBlock } from "@/lib/page-blocks";
import cuFcLogoPath from "@assets/CUFC_LOGO_1772823768518.png";

const BRAND = {
  blue: "#22399B",
  white: "#FBFBFC",
  gold: "#D9B10F",
  darkBlue: "#221F7A",
};

const DEFAULT_REVIEWS = [
  { highlight: "Best Holiday Camp in Canterbury", text: "My kids have been going to CUFC holiday camps since they were 4 years old. The coaches are amazing, the activities are fun, and they come home exhausted and happy every single day. Wouldn't send them anywhere else.", name: "Sarah Mitchell", role: "Parent of 2", stars: 5 },
  { highlight: "My Son's Confidence Has Skyrocketed", text: "He used to be so shy on the field, but after just one camp he was running around making friends and loving every minute. The coaches really know how to bring out the best in every child regardless of ability.", name: "James Crawford", role: "Parent", stars: 5 },
  { highlight: "Worth Every Single Dollar", text: "We've tried other holiday programmes and nothing compares. The organisation, the skill development, and the genuine care the coaches show — it's a level above. Our daughter asks to go back every holidays.", name: "Michelle Thompson", role: "Parent of 3", stars: 5 },
  { highlight: "Safe, Fun and Professional", text: "As a parent, safety is my number one priority. CUFC runs an incredibly well-organised camp with proper check-in procedures and qualified coaches. My kids have a blast and I have complete peace of mind.", name: "David Chen", role: "Parent", stars: 5 },
  { highlight: "They Actually Learn Real Skills", text: "It's not just babysitting — my children genuinely improve their football skills every camp. The drills are age-appropriate and the coaches make learning fun. Both my boys can't wait for the next school holidays.", name: "Rachel Nguyen", role: "Parent of 2", stars: 5 },
];

const DEFAULT_FAQ = [
  { q: "Does my child need football experience?", a: "Not at all! Our camps are designed for all skill levels. Whether your child is kicking a ball for the first time or already plays in a team, our coaches adapt activities so everyone has fun and improves." },
  { q: "What should they bring?", a: "Comfortable sports clothing, shin pads, boots or trainers, a water bottle, and sunscreen. For full-day campers, please pack a lunch and snacks. We provide all footballs and equipment." },
  { q: "What happens if it rains?", a: "Our camps run rain or shine! We have access to covered and indoor facilities at the Christchurch Football Centre, so your child will always have a great experience regardless of weather." },
  { q: "Can I book multiple days?", a: "Absolutely! You can pick and choose individual days or book the full week. Multi-day bookings receive automatic discounts at checkout." },
  { q: "Does my child need to be a CUFC player?", a: "No — our holiday camps are open to all children in the community, regardless of which club they play for or whether they play at all. Everyone is welcome." },
];

const DEFAULT_SCHEDULE = [
  { time: "9:00 AM", label: "Drop Off & Welcome Games" },
  { time: "9:30 AM", label: "Skill Activities & Ball Mastery" },
  { time: "10:15 AM", label: "Fun Challenges & Small Games" },
  { time: "11:00 AM", label: "Match Play & Themed Games" },
  { time: "11:30 AM", label: "Morning Session Pick Up" },
  { time: "12:00 PM", label: "Afternoon Session Begins" },
  { time: "12:30 PM", label: "Skill Challenges & Competitions" },
  { time: "1:30 PM", label: "Team Games & Mini Tournaments" },
  { time: "2:30 PM", label: "Cool Down & Awards" },
  { time: "3:00 PM", label: "Full Day Pick Up" },
];

const DEFAULT_TRUST = [
  { title: "Trusted Since 2014", desc: "Canterbury families have relied on CUFC for over a decade" },
  { title: "Safe & Supervised", desc: "Proper check-in procedures with qualified, vetted coaches" },
  { title: "Professional Facilities", desc: "Christchurch Football Centre — purpose-built for football" },
  { title: "Fun First, Skills Second", desc: "Every child leaves smiling, confident, and wanting to come back" },
];

const DEFAULT_EXPERIENCE = [
  { title: "Fun Skill Games", desc: "Age-appropriate drills that feel like play, not practice" },
  { title: "Make New Friends", desc: "Social environment where kids connect and build friendships" },
  { title: "Build Confidence", desc: "Every child is celebrated and encouraged to grow" },
  { title: "Learn Through Play", desc: "Real football skills developed through engaging activities" },
];

interface PageContent {
  reviewsSectionTitle: string;
  reviewsSectionSub: string;
  reviews: { highlight: string; text: string; name: string; role: string; stars: number }[];
  keyInfoTitle: string;
  infoAge: string;
  infoDates: string;
  infoDatesWeek1: string;
  infoDatesWeek2: string;
  infoDatesNote: string;
  infoLocation: string;
  infoLocationAddress: string;
  infoSessionMorning: string;
  infoSessionAfternoon: string;
  infoSessionFullDay: string;
  infoPriceMorning: string;
  infoPriceAfternoon: string;
  infoPriceFullDay: string;
  scheduleTitle: string;
  scheduleSub: string;
  schedule: { time: string; label: string }[];
  experienceTitle: string;
  experienceSub: string;
  experience: { title: string; desc: string }[];
  trustTitle: string;
  trustSub: string;
  trust: { title: string; desc: string }[];
  statFamilies: string;
  statEstablished: string;
  statRating: string;
  pricingTitle: string;
  pricingSub: string;
  pricingFootnote: string;
  finalCtaTitle: string;
  finalCtaSub: string;
  finalCtaFootnote: string;
  trustBadge: string;
  stickyCtaText: string;
  footerDisclaimer: string;
}

function getDefaultContent(): PageContent {
  return {
    reviewsSectionTitle: "What Parents Are Saying",
    reviewsSectionSub: "Real reviews from real families",
    reviews: DEFAULT_REVIEWS,
    keyInfoTitle: "Key Information",
    infoAge: "3–8 Years",
    infoDates: "",
    infoDatesWeek1: "Week 1: 6–10 April",
    infoDatesWeek2: "Week 2: 13–17 April",
    infoDatesNote: "Mon – Fri",
    infoLocation: "United Sports Centre",
    infoLocationAddress: "466 Yaldhurst Road",
    infoSessionMorning: "Morning: 9am – 12pm",
    infoSessionAfternoon: "Afternoon: 12pm – 3pm",
    infoSessionFullDay: "Full Day: 9am – 3pm",
    infoPriceMorning: "Morning $30",
    infoPriceAfternoon: "Afternoon $30",
    infoPriceFullDay: "Full Day $50",
    scheduleTitle: "What a Day Looks Like",
    scheduleSub: "Morning, afternoon, and full-day options available",
    schedule: DEFAULT_SCHEDULE,
    experienceTitle: "What Your Child Will Experience",
    experienceSub: "A safe, fun environment where every child builds confidence and falls in love with football",
    experience: DEFAULT_EXPERIENCE,
    trustTitle: "Why Families Choose Christchurch United",
    trustSub: "A club and community you can trust",
    trust: DEFAULT_TRUST,
    statFamilies: "1,000+",
    statEstablished: "Since 2014",
    statRating: "5.0",
    pricingTitle: "Choose Your Session",
    pricingSub: "Simple online booking. Secure payment. Instant confirmation.",
    pricingFootnote: "Places are limited for each day",
    finalCtaTitle: "Give Your Child a Holiday They'll Love",
    finalCtaSub: "Limited places available. Fun, safe environment. Easy online booking.",
    finalCtaFootnote: "Secure online booking in under 2 minutes",
    trustBadge: "Trusted by 1,000+ Parents since 2014",
    stickyCtaText: "Book Now — From $30/session",
    footerDisclaimer: "This site is not part of the Facebook website or Facebook Inc. Additionally, this site is NOT endorsed by Facebook in any way. FACEBOOK is a trademark of FACEBOOK, Inc.",
  };
}

interface EProps {
  value: string;
  onChange: (v: string) => void;
  tag?: "h1" | "h2" | "h3" | "p" | "span";
  className?: string;
  style?: Record<string, any>;
  multiline?: boolean;
  "data-testid"?: string;
}

function E({ value, onChange, tag = "p", className = "", style = {}, multiline = false, ...props }: EProps) {
  const ref = useRef<HTMLElement>(null);
  const lastValue = useRef(value);
  const isEditing = useRef(false);

  useEffect(() => {
    lastValue.current = value;
    if (ref.current && !isEditing.current) {
      ref.current.textContent = value || "";
    }
  }, [value]);

  useEffect(() => {
    if (ref.current) {
      ref.current.textContent = value || "";
    }
  }, []);

  const handleInput = useCallback(() => {
    const text = ref.current?.textContent || "";
    if (text !== lastValue.current) {
      lastValue.current = text;
      onChange(text);
    }
  }, [onChange]);

  const handleFocus = useCallback(() => { isEditing.current = true; }, []);

  const handleBlur = useCallback(() => {
    isEditing.current = false;
    const text = (ref.current?.textContent || "").trim();
    if (ref.current) ref.current.textContent = text;
    if (text !== lastValue.current) {
      lastValue.current = text;
      onChange(text);
    }
  }, [onChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!multiline && e.key === "Enter") {
      e.preventDefault();
      ref.current?.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (ref.current) ref.current.textContent = value;
      lastValue.current = value;
      isEditing.current = false;
      ref.current?.blur();
    }
  }, [multiline, value]);

  const Tag = tag;
  return (
    <Tag
      ref={ref as any}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      // Always-on subtle dashed underline so editable fields look editable.
      // Hover bumps it to a clear blue ring; focus = solid blue ring.
      className={`${className} cursor-text outline-none rounded-md transition-all ring-1 ring-blue-400/15 hover:ring-2 hover:ring-blue-400/50 focus:ring-2 focus:ring-blue-400 px-1 -mx-1`}
      style={{ ...style, caretColor: BRAND.gold, minWidth: 20 }}
      data-testid={props["data-testid"]}
      title="Click to edit"
    />
  );
}

function ScheduleTimeline({ items, onUpdate }: { items: { time: string; label: string }[]; onUpdate: (items: { time: string; label: string }[]) => void }) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const handleScroll = () => {
      const rect = el.getBoundingClientRect();
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

  const updateItem = (i: number, field: "time" | "label", val: string) => {
    const updated = [...items];
    updated[i] = { ...updated[i], [field]: val };
    onUpdate(updated);
  };

  const highlightIndices = [5, 9];

  return (
    <div ref={timelineRef} className="relative">
      <div className="absolute left-[72px] sm:left-[88px] top-0 bottom-0 w-px" style={{ background: 'rgba(251,251,252,0.12)' }} />
      <div className="absolute left-[72px] sm:left-[88px] top-0 w-px transition-none" style={{ height: `${progress * 100}%`, background: `linear-gradient(180deg, ${BRAND.gold}, ${BRAND.gold})`, boxShadow: `0 0 8px ${BRAND.gold}60, 0 0 16px ${BRAND.gold}30` }} />
      <div className="space-y-0">
        {items.map((item, i) => {
          const itemProgress = progress * items.length;
          const isLit = i < itemProgress;
          const isGlowing = i < itemProgress && i >= itemProgress - 1.5;
          const isHighlight = highlightIndices.includes(i);
          return (
            <div key={i} className="flex items-center gap-4 sm:gap-6 py-3.5 relative">
              <div className="w-[60px] sm:w-[76px] text-right flex-shrink-0">
                <E value={item.time} onChange={v => updateItem(i, "time", v)} tag="span" className="text-[13px] sm:text-[14px] font-semibold transition-colors duration-300 inline-block" style={{ color: isHighlight ? BRAND.gold : isLit ? BRAND.white : 'rgba(251,251,252,0.35)' }} data-testid={`edit-schedule-time-${i}`} />
              </div>
              <div className="w-3 h-3 rounded-full flex-shrink-0 z-10 transition-all duration-300" style={{ background: isLit ? BRAND.gold : 'rgba(251,251,252,0.2)', boxShadow: isGlowing ? `0 0 8px ${BRAND.gold}, 0 0 16px ${BRAND.gold}60` : 'none', transform: isGlowing ? 'scale(1.3)' : 'scale(1)' }} />
              <E value={item.label} onChange={v => updateItem(i, "label", v)} tag="span" className="text-[13px] sm:text-[14px] transition-colors duration-300" style={{ color: isLit ? BRAND.white : 'rgba(251,251,252,0.35)', fontWeight: isHighlight || isLit ? 700 : 400 }} data-testid={`edit-schedule-label-${i}`} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EditableFAQ({ items, onUpdate }: { items: { q: string; a: string }[]; onUpdate: (items: { q: string; a: string }[]) => void }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const update = (i: number, field: "q" | "a", val: string) => {
    const updated = [...items];
    updated[i] = { ...updated[i], [field]: val };
    onUpdate(updated);
  };
  return (
    <div className="rounded-2xl px-5 sm:px-6" style={{ background: BRAND.blue, border: '1px solid rgba(34,57,155,0.5)' }}>
      {items.map((item, i) => (
        <div key={i} className="last:border-0 group/faq" style={{ borderBottom: '1px solid rgba(34,57,155,0.3)' }}>
          <div className="w-full flex items-center justify-between py-4 sm:py-5 text-left gap-2">
            <div className="flex-1 pr-2 flex items-center gap-2">
              <div className="opacity-0 group-hover/faq:opacity-100 transition-opacity">
                <AiCopyButton
                  fieldName={`faq-q-${i}`}
                  fieldHint={`FAQ question ${i + 1} (parent voice — short, direct, what they actually ask)`}
                  currentValue={item.q}
                  examplePrompt="Write a parent-realistic question they'd actually ask before signing their kid up."
                  maxTokens={150}
                  onGenerated={(text) => update(i, "q", text)}
                  size="xs"
                />
              </div>
              <div className="flex-1">
                <E value={item.q} onChange={v => update(i, "q", v)} tag="span" className="font-semibold text-[14px] sm:text-[15px]" style={{ color: BRAND.white }} data-testid={`edit-faq-q-${i}`} />
              </div>
            </div>
            <button onClick={() => setOpenIndex(openIndex === i ? null : i)} className="cursor-pointer flex-shrink-0">
              {openIndex === i ? <ChevronUp className="w-4 h-4" style={{ color: BRAND.gold }} /> : <ChevronDown className="w-4 h-4" style={{ color: 'rgba(251,251,252,0.4)' }} />}
            </button>
          </div>
          {openIndex === i && (
            <div className="pb-4 flex gap-2 items-start">
              <div className="opacity-0 group-hover/faq:opacity-100 transition-opacity pt-1">
                <AiCopyButton
                  fieldName={`faq-a-${i}`}
                  fieldHint={`FAQ answer ${i + 1} (short — 1-3 sentences, direct, no hype)`}
                  currentValue={item.a}
                  examplePrompt="Write a short direct answer — no hype, just the facts a parent needs."
                  maxTokens={300}
                  onGenerated={(text) => update(i, "a", text)}
                  size="xs"
                />
              </div>
              <div className="flex-1">
                <E value={item.a} onChange={v => update(i, "a", v)} tag="p" className="text-[13px] sm:text-[14px] leading-relaxed" style={{ color: 'rgba(251,251,252,0.6)' }} multiline data-testid={`edit-faq-a-${i}`} />
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AdminEditPage() {
  // Matched under whichever section the programme lives in (camps / academy /
  // programs) so "back" returns to the detail page the user opened this from.
  const route = useProgramRoute("/edit-page");
  const campId = route?.id ?? 0;
  const detailPath = `${route?.base ?? "/admin/camps"}/${campId}`;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const reviewsRef = useRef<HTMLDivElement>(null);
  const { currentOrg } = useWorkspace();
  // Use the active workspace's logo in the preview so the admin sees the
  // brand crest that'll show on the public landing page (gymnastics workspace
  // → CUGC crest, etc.). Falls back to the CUFC default if the org somehow
  // has no logo set.
  const previewLogo = currentOrg?.logoUrl || cuFcLogoPath;
  const previewBrandName = currentOrg?.name || "Christchurch United Football Club";

  const { data: camp, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/camps", campId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
    enabled: campId > 0,
  });

  const [heroHeadline, setHeroHeadline] = useState("");
  const [heroSubheadline, setHeroSubheadline] = useState("");
  const [primaryCta, setPrimaryCta] = useState("Book Now");
  const [heroVideoId, setHeroVideoId] = useState("");
  const [heroImage, setHeroImage] = useState("");
  const [faqItems, setFaqItems] = useState<{ q: string; a: string }[]>([]);
  const [content, setContent] = useState<PageContent>(getDefaultContent());
  const [customBlocks, setCustomBlocks] = useState<PageBlock[]>([]);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (!camp) return;
    setHeroHeadline(camp.heroHeadline || camp.name || "");
    setHeroSubheadline(camp.heroSubheadline || camp.descriptionShort || "Fun, engaging football camps for young players. Build confidence, make friends, and fall in love with football.");
    setPrimaryCta(camp.primaryCta || "Book Now");
    setHeroVideoId(camp.heroVideoId || "");
    setHeroImage(camp.heroImage || "");
    setCustomBlocks(Array.isArray(camp.customBlocksJson) ? camp.customBlocksJson : []);
    let faq: { q: string; a: string }[] = [];
    try { faq = camp.faqJson ? JSON.parse(camp.faqJson) : []; } catch {}
    setFaqItems(faq.length > 0 ? faq : DEFAULT_FAQ);
    let pc: PageContent;
    try { pc = camp.pageContentJson ? { ...getDefaultContent(), ...JSON.parse(camp.pageContentJson) } : getDefaultContent(); } catch { pc = getDefaultContent(); }
    setContent(pc);
    setHasChanges(false);
  }, [camp]);

  const markChanged = useCallback(() => setHasChanges(true), []);
  const updateContent = useCallback(<K extends keyof PageContent>(key: K, val: PageContent[K]) => {
    setContent(prev => ({ ...prev, [key]: val }));
    setHasChanges(true);
  }, []);

  // Re-load Wistia jsonp whenever the program's hero video id changes so
  // the editor preview matches what'll ship live.
  const previewVideoId = heroVideoId || "0l469en6m5";
  useEffect(() => {
    const wistiaScript = document.createElement("script");
    wistiaScript.src = `https://fast.wistia.com/embed/medias/${previewVideoId}.jsonp`;
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
  }, [previewVideoId]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/camps/${campId}`, {
      heroHeadline,
      heroSubheadline,
      primaryCta,
      heroVideoId: heroVideoId || null,
      heroImage: heroImage || null,
      faqJson: JSON.stringify(faqItems),
      pageContentJson: JSON.stringify(content),
      customBlocksJson: customBlocks,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps"] });
      setHasChanges(false);
      toast({ title: "Page updated", description: "Your changes have been saved." });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const scrollReviews = (dir: "left" | "right") => {
    reviewsRef.current?.scrollBy({ left: dir === "right" ? 400 : -400, behavior: "smooth" });
  };

  const [showAbModal, setShowAbModal] = useState(false);
  const [abField, setAbField] = useState("heroHeadline");
  const [abVariants, setAbVariants] = useState<{ label: string; value: string }[]>([]);
  const [abEndCondition, setAbEndCondition] = useState("days");
  const [abEndValue, setAbEndValue] = useState("7");
  const { toast: abToast } = useToast();

  const openAbTest = (field: string, currentValue: string) => {
    setAbField(field);
    setAbVariants([
      { label: "Variant A (Control)", value: currentValue },
      { label: "Variant B", value: "" },
    ]);
    setAbEndCondition("days");
    setAbEndValue("7");
    setShowAbModal(true);
  };

  const createAbMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/split-tests", {
      programId: campId,
      field: abField,
      endCondition: abEndCondition,
      endValue: parseInt(abEndValue),
      variants: abVariants.filter(v => v.value.trim()),
    }),
    onSuccess: () => {
      setShowAbModal(false);
      abToast({ title: "Split test created", description: "Test is now live and serving variants to visitors." });
    },
    onError: (e: Error) => abToast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const fieldLabels: Record<string, string> = {
    heroHeadline: "Hero Headline",
    heroSubheadline: "Hero Subheadline",
    primaryCta: "CTA Button",
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.white }}>
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!camp) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.white }}>
        <p className="text-slate-500">Camp not found</p>
      </div>
    );
  }

  const trustIcons = [Shield, Heart, Zap, Sparkles];
  const expIcons = [Gamepad2, UserPlus, Sparkles, Zap];

  return (
    <div className="min-h-screen relative" style={{ fontFamily: "'Inter Tight', sans-serif" }}>
      <div className="fixed top-0 left-0 right-0 z-[60] bg-slate-900/95 backdrop-blur-lg border-b border-white/10 shadow-lg">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <button onClick={() => navigate(detailPath)} className="flex items-center gap-2 text-white/70 hover:text-white text-[13px] font-medium transition-colors cursor-pointer" data-testid="button-back-admin">
            <ArrowLeft className="w-4 h-4" /> Back to Camp
          </button>
          <div className="flex items-center gap-3">
            <AiPageBriefButton
              programName={camp?.name}
              programType={camp?.type}
              onApply={(draft) => {
                if (draft.heroHeadline) { setHeroHeadline(draft.heroHeadline); }
                if (draft.heroSubheadline) { setHeroSubheadline(draft.heroSubheadline); }
                if (draft.primaryCta) { setPrimaryCta(draft.primaryCta); }
                setContent(prev => ({
                  ...prev,
                  ...(draft.trustBadge ? { trustBadge: draft.trustBadge } : {}),
                  ...(draft.reviewsSectionTitle ? { reviewsSectionTitle: draft.reviewsSectionTitle } : {}),
                  ...(draft.reviewsSectionSub ? { reviewsSectionSub: draft.reviewsSectionSub } : {}),
                  ...(draft.keyInfoTitle ? { keyInfoTitle: draft.keyInfoTitle } : {}),
                  ...(draft.scheduleTitle ? { scheduleTitle: draft.scheduleTitle } : {}),
                  ...(draft.scheduleSub ? { scheduleSub: draft.scheduleSub } : {}),
                  ...(draft.experienceTitle ? { experienceTitle: draft.experienceTitle } : {}),
                  ...(draft.faqs && draft.faqs.length > 0 ? { faqs: draft.faqs } : {}),
                }));
                markChanged();
              }}
            />
            {camp.slug && (
              <button
                onClick={async () => {
                  // If there are unsaved changes, save first so the preview reflects them.
                  if (hasChanges) {
                    try {
                      await saveMutation.mutateAsync();
                    } catch {
                      // Mutation surfaces its own toast; bail.
                      return;
                    }
                  }
                  window.open(`/${camp.slug}`, "_blank", "noopener,noreferrer");
                }}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] border border-white/10 text-[12px] font-semibold text-white/80 hover:text-white transition"
                data-testid="link-preview-page"
                title={hasChanges ? "Save & open the published page in a new tab" : "Open the published page in a new tab"}
              >
                <Eye className="w-3.5 h-3.5" /> Preview
                {hasChanges && <span className="text-[10px] text-blue-300/80 ml-0.5">(saves first)</span>}
              </button>
            )}
            <span className="text-[11px] text-white/30">{hasChanges ? "Unsaved changes" : "All changes saved"}</span>
            <Button onClick={() => saveMutation.mutate()} disabled={!hasChanges || saveMutation.isPending}
              className={`h-8 px-4 rounded-lg text-[12px] font-semibold transition-all ${hasChanges ? "bg-blue-600 hover:bg-blue-700 text-white" : "bg-white/5 text-white/30 cursor-default"}`}
              data-testid="button-save-page">
              {saveMutation.isPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Saving</> : <><Save className="w-3.5 h-3.5 mr-1.5" /> Save Changes</>}
            </Button>
          </div>
        </div>
      </div>

      <div className="pt-14">

        {/* How-to-edit help banner */}
        <div className="bg-blue-500/[0.06] border-y border-blue-500/[0.15] py-2.5">
          <div className="max-w-5xl mx-auto px-4 text-[11px] text-blue-200/80 flex items-center gap-3 flex-wrap justify-center">
            <span className="flex items-center gap-1.5"><kbd className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-mono">click</kbd> any text to edit</span>
            <span className="text-blue-300/30">·</span>
            <span className="flex items-center gap-1.5"><Sparkles className="w-3 h-3" /> hover to reveal AI buttons</span>
            <span className="text-blue-300/30">·</span>
            <span>scroll to bottom to add custom sections</span>
            <span className="text-blue-300/30">·</span>
            <span><kbd className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] font-mono">Save Changes</kbd> when done</span>
          </div>
        </div>

        {/* HERO */}
        <section className="relative overflow-hidden" style={{ background: `linear-gradient(180deg, ${BRAND.darkBlue} 0%, ${BRAND.blue} 100%)` }}>
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] opacity-[0.07] rounded-full" style={{ background: `radial-gradient(ellipse, ${BRAND.gold} 0%, transparent 70%)` }} />
            <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          </div>
          <div className="relative max-w-3xl mx-auto px-6 pt-8 pb-10 md:pt-10 md:pb-12">
            <div className="flex flex-col items-center text-center">
              <div className="mb-4">
                <img src={previewLogo} alt={previewBrandName} className="w-14 h-14 md:w-18 md:h-18 object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.4)]" />
              </div>
              <div className="w-full max-w-2xl mb-3 relative group/ab">
                <E value={heroHeadline} onChange={v => { setHeroHeadline(v); markChanged(); }} tag="h1" className="text-[28px] sm:text-4xl md:text-5xl lg:text-[52px] font-bold tracking-tight leading-[1.08]" style={{ color: BRAND.white }} data-testid="edit-hero-headline" />
                <div className="absolute -left-12 top-1/2 -translate-y-1/2 opacity-0 group-hover/ab:opacity-100 transition-opacity pointer-events-none group-hover/ab:pointer-events-auto">
                  <AiCopyButton
                    fieldName="heroHeadline"
                    fieldHint="Hero headline (1 short sentence — under 12 words)"
                    currentValue={heroHeadline}
                    examplePrompt="Write a hero headline for the Recreational gymnastics class — speak to a parent who wants their kid moving and making friends."
                    maxTokens={200}
                    onGenerated={(text) => { setHeroHeadline(text); markChanged(); }}
                  />
                </div>
                <button
                  onClick={() => openAbTest("heroHeadline", heroHeadline)}
                  className="absolute -right-12 top-1/2 -translate-y-1/2 opacity-0 group-hover/ab:opacity-100 transition-opacity bg-purple-600 hover:bg-purple-500 text-white rounded-full w-8 h-8 flex items-center justify-center shadow-lg"
                  title="Create A/B Test for headline"
                  data-testid="btn-ab-headline"
                >
                  <FlaskConical className="w-4 h-4" />
                </button>
              </div>
              <div className="w-full max-w-xl mb-6 relative group/ab2">
                <E value={heroSubheadline} onChange={v => { setHeroSubheadline(v); markChanged(); }} tag="p" className="text-[14px] sm:text-[16px] md:text-[18px] leading-relaxed" style={{ color: 'rgba(251,251,252,0.55)' }} multiline data-testid="edit-hero-sub" />
                <div className="absolute -left-12 top-1/2 -translate-y-1/2 opacity-0 group-hover/ab2:opacity-100 transition-opacity pointer-events-none group-hover/ab2:pointer-events-auto">
                  <AiCopyButton
                    fieldName="heroSubheadline"
                    fieldHint="Hero subheadline (1-2 sentences — supports the headline, names a benefit)"
                    currentValue={heroSubheadline}
                    examplePrompt="Write a hero subheadline that builds on the headline — call out who it's for + the outcome."
                    maxTokens={300}
                    onGenerated={(text) => { setHeroSubheadline(text); markChanged(); }}
                  />
                </div>
                <button
                  onClick={() => openAbTest("heroSubheadline", heroSubheadline)}
                  className="absolute -right-12 top-1/2 -translate-y-1/2 opacity-0 group-hover/ab2:opacity-100 transition-opacity bg-purple-600 hover:bg-purple-500 text-white rounded-full w-8 h-8 flex items-center justify-center shadow-lg"
                  title="Create A/B Test for subheadline"
                  data-testid="btn-ab-subheadline"
                >
                  <FlaskConical className="w-4 h-4" />
                </button>
              </div>
              <div className="w-full max-w-[680px] mb-3 group/video relative">
                <div className="relative rounded-2xl overflow-hidden shadow-2xl shadow-black/40" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
                  {heroImage ? (
                    <img src={heroImage} alt={heroHeadline || "Hero"} className="w-full aspect-video object-cover" />
                  ) : (
                    <div className="wistia_responsive_padding" style={{ padding: '56.25% 0 0 0', position: 'relative' }}>
                      <div className="wistia_responsive_wrapper" style={{ height: '100%', left: 0, position: 'absolute', top: 0, width: '100%' }}>
                        <div className={`wistia_embed wistia_async_${previewVideoId} seo=true videoFoam=true`} style={{ height: '100%', position: 'relative', width: '100%' }}>
                          <div className="wistia_swatch" style={{ height: '100%', left: 0, opacity: 0, overflow: 'hidden', position: 'absolute', top: 0, transition: 'opacity 200ms', width: '100%' }}>
                            <img src={`https://fast.wistia.com/embed/medias/${previewVideoId}/swatch`} style={{ filter: 'blur(5px)', height: '100%', objectFit: 'contain', width: '100%' }} alt="" />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {/* Hero media editor — appears on hover. Image always wins over video when set. */}
                <div className="opacity-0 group-hover/video:opacity-100 transition-opacity absolute -bottom-3 left-1/2 -translate-x-1/2 translate-y-full bg-slate-900 border border-white/10 rounded-xl p-3 shadow-xl flex flex-col gap-2 z-10 w-[480px] max-w-[92vw]">
                  <div className="text-[10px] uppercase tracking-wider text-white/50 font-semibold">Hero media <span className="normal-case text-white/30">— image overrides video if both are set</span></div>
                  <div className="grid grid-cols-1 gap-2">
                    <div className="rounded-md bg-white/[0.02] border border-white/[0.06] p-2">
                      <ImagePicker label="Hero image" value={heroImage} onChange={(url) => { setHeroImage(url); markChanged(); }} />
                    </div>
                    <div className="rounded-md bg-white/[0.02] border border-white/[0.06] p-2 flex items-center gap-2">
                      <label className="text-[10px] uppercase tracking-wider text-white/50 whitespace-nowrap">Wistia ID</label>
                      <input
                        type="text"
                        value={heroVideoId}
                        onChange={e => { setHeroVideoId(e.target.value.trim()); markChanged(); }}
                        placeholder={heroVideoId ? "" : "0l469en6m5 (default)"}
                        className="flex-1 bg-white/[0.05] border border-white/10 rounded px-2 py-1 text-[12px] text-white/80 font-mono focus:outline-none focus:border-blue-500/50"
                        disabled={!!heroImage}
                      />
                      <a href="https://fast.wistia.com/projects" target="_blank" rel="noreferrer" className="text-[10px] text-blue-400/70 hover:text-blue-400 whitespace-nowrap">Find IDs ↗</a>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <span className="group relative inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full" style={{ background: BRAND.white, color: BRAND.blue, boxShadow: '0 4px 24px rgba(34,57,155,0.3)' }}>
                  <E value={primaryCta} onChange={v => { setPrimaryCta(v); markChanged(); }} tag="span" className="text-[15px] font-bold" style={{ color: BRAND.blue }} data-testid="edit-primary-cta" />
                  <ArrowRight className="w-4 h-4" />
                </span>
              </div>
              <div className="mt-6">
                <E value={content.trustBadge} onChange={v => updateContent("trustBadge", v)} tag="p" className="text-[10px] sm:text-[11px] uppercase tracking-[0.2em] font-semibold mb-2" style={{ color: 'rgba(251,251,252,0.28)' }} data-testid="edit-trust-badge" />
                <div className="flex items-center justify-center gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="w-3.5 h-3.5 fill-[#D9B10F] text-[#D9B10F]" />)}
                  <span className="ml-1.5 text-[12px] font-semibold" style={{ color: 'rgba(251,251,252,0.4)' }}>5.0</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* TESTIMONIALS */}
        <section className="py-12 md:py-16 overflow-hidden" style={{ background: BRAND.darkBlue }}>
          <div className="max-w-6xl mx-auto px-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <E value={content.reviewsSectionTitle} onChange={v => updateContent("reviewsSectionTitle", v)} tag="h2" className="text-xl sm:text-2xl font-bold tracking-tight text-white" style={{}} data-testid="edit-reviews-title" />
                <E value={content.reviewsSectionSub} onChange={v => updateContent("reviewsSectionSub", v)} tag="p" className="text-[13px] mt-0.5" style={{ color: 'rgba(251,251,252,0.45)' }} data-testid="edit-reviews-sub" />
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <button onClick={() => scrollReviews("left")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 hover:text-white hover:border-white/40 transition-colors cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
                <button onClick={() => scrollReviews("right")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 hover:text-white hover:border-white/40 transition-colors cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
              </div>
            </div>
            <div ref={reviewsRef} className="flex gap-4 overflow-x-auto scrollbar-hide pb-2 -mx-6 px-6 snap-x snap-mandatory">
              {content.reviews.map((review, i) => (
                <div key={i} className="min-w-[300px] sm:min-w-[360px] bg-white rounded-2xl border border-slate-100 p-6 sm:p-7 flex flex-col gap-3.5 shadow-sm snap-start">
                  <div className="flex gap-0.5">
                    {Array.from({ length: review.stars }).map((_, j) => <Star key={j} className="w-3.5 h-3.5 fill-[#D9B10F] text-[#D9B10F]" />)}
                  </div>
                  <E value={review.highlight} onChange={v => { const r = [...content.reviews]; r[i] = { ...r[i], highlight: v }; updateContent("reviews", r); }} tag="h3" className="text-[16px] font-bold text-slate-900 leading-snug" style={{}} data-testid={`edit-review-highlight-${i}`} />
                  <E value={review.text} onChange={v => { const r = [...content.reviews]; r[i] = { ...r[i], text: v }; updateContent("reviews", r); }} tag="p" className="text-[13px] sm:text-[14px] text-slate-500 leading-relaxed flex-1" style={{}} multiline data-testid={`edit-review-text-${i}`} />
                  <div className="flex items-center gap-3 pt-3 border-t border-slate-50">
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold" style={{ background: BRAND.blue }}>
                      {review.name.split(' ').map(n => n[0]).join('')}
                    </div>
                    <div>
                      <E value={review.name} onChange={v => { const r = [...content.reviews]; r[i] = { ...r[i], name: v }; updateContent("reviews", r); }} tag="p" className="text-[13px] font-semibold text-slate-800" style={{}} data-testid={`edit-review-name-${i}`} />
                      <E value={review.role} onChange={v => { const r = [...content.reviews]; r[i] = { ...r[i], role: v }; updateContent("reviews", r); }} tag="p" className="text-[11px] text-slate-400" style={{}} data-testid={`edit-review-role-${i}`} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex sm:hidden items-center justify-center gap-2 mt-4">
              <button onClick={() => scrollReviews("left")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 cursor-pointer"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => scrollReviews("right")} className="w-9 h-9 rounded-full border border-white/20 flex items-center justify-center text-white/50 cursor-pointer"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        </section>

        {/* KEY INFORMATION */}
        <section className="relative py-14 md:py-20 overflow-hidden" style={{ background: BRAND.white }}>
          <div className="relative max-w-5xl mx-auto px-6">
            <E value={content.keyInfoTitle} onChange={v => updateContent("keyInfoTitle", v)} tag="h2" className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-center mb-12" style={{ color: BRAND.darkBlue }} data-testid="edit-key-info-title" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">

              <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }}>
                <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                  <div className="relative z-10">
                    <Users className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                    <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Age</p>
                    <E value={content.infoAge} onChange={v => updateContent("infoAge", v)} tag="p" className="text-[15px] font-bold" style={{ color: BRAND.white }} data-testid="edit-info-age" />
                  </div>
                </div>
              </div>

              <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }}>
                <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                  <div className="relative z-10">
                    <Calendar className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                    <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Dates</p>
                    <E value={content.infoDatesWeek1} onChange={v => updateContent("infoDatesWeek1", v)} tag="p" className="text-[13px] font-bold leading-snug" style={{ color: BRAND.white }} data-testid="edit-info-dates-w1" />
                    <E value={content.infoDatesWeek2} onChange={v => updateContent("infoDatesWeek2", v)} tag="p" className="text-[13px] font-bold leading-snug" style={{ color: BRAND.white }} data-testid="edit-info-dates-w2" />
                    <E value={content.infoDatesNote} onChange={v => updateContent("infoDatesNote", v)} tag="p" className="text-[10px] mt-1" style={{ color: 'rgba(251,251,252,0.4)' }} data-testid="edit-info-dates-note" />
                  </div>
                </div>
              </div>

              <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }}>
                <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                  <div className="relative z-10">
                    <MapPin className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                    <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Drop Off + Pick Up</p>
                    <E value={content.infoLocation} onChange={v => updateContent("infoLocation", v)} tag="p" className="text-[14px] font-bold" style={{ color: BRAND.white }} data-testid="edit-info-location" />
                    <E value={content.infoLocationAddress} onChange={v => updateContent("infoLocationAddress", v)} tag="p" className="text-[12px] mt-0.5" style={{ color: 'rgba(251,251,252,0.5)' }} data-testid="edit-info-address" />
                  </div>
                </div>
              </div>

              <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }}>
                <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                  <div className="relative z-10">
                    <Clock className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                    <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Session Options</p>
                    <E value={content.infoSessionMorning} onChange={v => updateContent("infoSessionMorning", v)} tag="p" className="text-[12px] font-semibold" style={{ color: BRAND.white }} data-testid="edit-info-sess-m" />
                    <E value={content.infoSessionAfternoon} onChange={v => updateContent("infoSessionAfternoon", v)} tag="p" className="text-[12px] font-semibold" style={{ color: BRAND.white }} data-testid="edit-info-sess-a" />
                    <E value={content.infoSessionFullDay} onChange={v => updateContent("infoSessionFullDay", v)} tag="p" className="text-[12px] font-semibold" style={{ color: BRAND.white }} data-testid="edit-info-sess-fd" />
                  </div>
                </div>
              </div>

              <div className="group relative rounded-2xl p-[1px] transition-all duration-500 hover:scale-[1.02]" style={{ background: `linear-gradient(135deg, rgba(34,57,155,0.4) 0%, rgba(34,31,122,0.6) 50%, rgba(34,57,155,0.4) 100%)` }}>
                <div className="relative rounded-2xl p-5 text-center h-full overflow-hidden" style={{ background: BRAND.darkBlue }}>
                  <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" style={{ background: `radial-gradient(ellipse at 50% 100%, rgba(34,57,155,0.2) 0%, transparent 70%)` }} />
                  <div className="relative z-10">
                    <DollarSign className="w-5 h-5 mx-auto mb-2.5" style={{ color: BRAND.white }} />
                    <p className="text-[10px] uppercase tracking-[0.15em] font-semibold mb-1.5" style={{ color: 'rgba(251,251,252,0.5)' }}>Price</p>
                    <E value={content.infoPriceMorning} onChange={v => updateContent("infoPriceMorning", v)} tag="p" className="text-[13px] font-bold" style={{ color: BRAND.white }} data-testid="edit-info-price-m" />
                    <E value={content.infoPriceAfternoon} onChange={v => updateContent("infoPriceAfternoon", v)} tag="p" className="text-[13px] font-bold" style={{ color: BRAND.white }} data-testid="edit-info-price-a" />
                    <E value={content.infoPriceFullDay} onChange={v => updateContent("infoPriceFullDay", v)} tag="p" className="text-[13px] font-bold" style={{ color: BRAND.white }} data-testid="edit-info-price-fd" />
                  </div>
                </div>
              </div>

            </div>
          </div>
        </section>

        {/* SCHEDULE */}
        <section className="py-12 md:py-16" style={{ background: BRAND.blue }}>
          <div className="max-w-2xl mx-auto px-6">
            <E value={content.scheduleTitle} onChange={v => updateContent("scheduleTitle", v)} tag="h2" className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2 text-center" style={{ color: BRAND.gold }} data-testid="edit-schedule-title" />
            <E value={content.scheduleSub} onChange={v => updateContent("scheduleSub", v)} tag="p" className="text-[14px] mb-10 text-center" style={{ color: BRAND.white }} data-testid="edit-schedule-sub" />
            <ScheduleTimeline items={content.schedule} onUpdate={v => updateContent("schedule", v)} />
          </div>
        </section>

        {/* EXPERIENCE */}
        <section className="py-12 md:py-16" style={{ background: BRAND.darkBlue }}>
          <div className="max-w-4xl mx-auto px-6 text-center">
            <E value={content.experienceTitle} onChange={v => updateContent("experienceTitle", v)} tag="h2" className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2" style={{ color: BRAND.white }} data-testid="edit-exp-title" />
            <E value={content.experienceSub} onChange={v => updateContent("experienceSub", v)} tag="p" className="text-[14px] mb-10 max-w-lg mx-auto" style={{ color: 'rgba(251,251,252,0.55)' }} multiline data-testid="edit-exp-sub" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {content.experience.map((item, i) => {
                const Icon = expIcons[i] || Sparkles;
                return (
                  <div key={i} className="rounded-xl p-5 text-center hover:-translate-y-0.5 transition-all duration-300" style={{ background: BRAND.blue, border: '1px solid rgba(217,177,15,0.2)', boxShadow: '0 0 12px rgba(217,177,15,0.08), 0 0 24px rgba(217,177,15,0.04)' }}>
                    <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: 'rgba(217,177,15,0.1)' }}>
                      <Icon className="w-5 h-5" style={{ color: BRAND.gold }} />
                    </div>
                    <E value={item.title} onChange={v => { const e = [...content.experience]; e[i] = { ...e[i], title: v }; updateContent("experience", e); }} tag="h3" className="text-[14px] font-bold mb-1" style={{ color: BRAND.white }} data-testid={`edit-exp-title-${i}`} />
                    <E value={item.desc} onChange={v => { const e = [...content.experience]; e[i] = { ...e[i], desc: v }; updateContent("experience", e); }} tag="p" className="text-[12px] leading-relaxed" style={{ color: 'rgba(251,251,252,0.5)' }} data-testid={`edit-exp-desc-${i}`} />
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* TRUST */}
        <section className="py-12 md:py-16" style={{ background: '#f8f9fb' }}>
          <div className="max-w-4xl mx-auto px-6">
            <E value={content.trustTitle} onChange={v => updateContent("trustTitle", v)} tag="h2" className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-2 text-center" style={{}} data-testid="edit-trust-title" />
            <E value={content.trustSub} onChange={v => updateContent("trustSub", v)} tag="p" className="text-[14px] text-slate-400 mb-10 text-center" style={{}} data-testid="edit-trust-sub" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
              {content.trust.map((item, i) => {
                const Icon = trustIcons[i] || Shield;
                return (
                  <div key={i} className="bg-white rounded-xl border border-slate-100 p-5 flex gap-4 items-start hover:shadow-sm transition-all">
                    <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: `${BRAND.blue}0A` }}>
                      <Icon className="w-5 h-5" style={{ color: BRAND.blue }} />
                    </div>
                    <div>
                      <E value={item.title} onChange={v => { const t = [...content.trust]; t[i] = { ...t[i], title: v }; updateContent("trust", t); }} tag="h3" className="text-[14px] font-bold text-slate-800 mb-0.5" style={{}} data-testid={`edit-trust-title-${i}`} />
                      <E value={item.desc} onChange={v => { const t = [...content.trust]; t[i] = { ...t[i], desc: v }; updateContent("trust", t); }} tag="p" className="text-[12px] sm:text-[13px] text-slate-400 leading-relaxed" style={{}} data-testid={`edit-trust-desc-${i}`} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-8 sm:gap-12">
              <div className="text-center">
                <E value={content.statFamilies} onChange={v => updateContent("statFamilies", v)} tag="p" className="text-2xl sm:text-3xl font-bold" style={{ color: BRAND.blue }} data-testid="edit-stat-families" />
                <p className="text-[12px] text-slate-400 font-medium mt-1">Families</p>
              </div>
              <div className="text-center">
                <E value={content.statEstablished} onChange={v => updateContent("statEstablished", v)} tag="p" className="text-2xl sm:text-3xl font-bold" style={{ color: BRAND.blue }} data-testid="edit-stat-est" />
                <p className="text-[12px] text-slate-400 font-medium mt-1">Established</p>
              </div>
              <div className="text-center">
                <E value={content.statRating} onChange={v => updateContent("statRating", v)} tag="p" className="text-2xl sm:text-3xl font-bold" style={{ color: BRAND.blue }} data-testid="edit-stat-rating" />
                <div className="flex items-center justify-center gap-1 mt-1">
                  {Array.from({ length: 5 }).map((_, j) => <Star key={j} className="w-3 h-3 fill-[#D9B10F] text-[#D9B10F]" />)}
                </div>
                <p className="text-[12px] text-slate-400 font-medium mt-0.5">Star Rating</p>
              </div>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section className="py-12 md:py-16" style={{ background: BRAND.blue }} id="pricing">
          <div className="max-w-4xl mx-auto px-6">
            <E value={content.pricingTitle} onChange={v => updateContent("pricingTitle", v)} tag="h2" className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight mb-2 text-center" style={{ color: BRAND.gold }} data-testid="edit-pricing-title" />
            <E value={content.pricingSub} onChange={v => updateContent("pricingSub", v)} tag="p" className="text-[14px] mb-10 text-center" style={{ color: 'rgba(251,251,252,0.6)' }} data-testid="edit-pricing-sub" />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
              {[
                { type: "MORNING", label: "Morning", time: "9:00am – 12:00pm", price: 30, featured: false },
                { type: "AFTERNOON", label: "Afternoon", time: "12:00pm – 3:00pm", price: 30, featured: false },
                { type: "FULL_DAY", label: "Full Day", time: "9:00am – 3:00pm", price: 50, featured: true },
              ].map((s) => (
                <div key={s.type} className={`rounded-2xl p-6 text-center transition-all duration-300 hover:-translate-y-1 relative ${s.featured ? 'shadow-lg' : ''}`} style={{ background: s.featured ? BRAND.darkBlue : 'rgba(251,251,252,0.08)', border: s.featured ? `2px solid ${BRAND.gold}` : '1px solid rgba(251,251,252,0.15)', boxShadow: s.featured ? `0 0 20px rgba(217,177,15,0.15), 0 0 40px rgba(217,177,15,0.05)` : 'none' }}>
                  {s.featured && <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-[10px] px-3 py-1 rounded-full uppercase tracking-wider font-bold text-white" style={{ background: BRAND.gold }}>Best Value</span>}
                  <Clock className="w-6 h-6 mx-auto mb-2" style={{ color: s.featured ? BRAND.gold : 'rgba(251,251,252,0.5)' }} />
                  <h3 className="text-[16px] font-bold" style={{ color: BRAND.white }}>{s.label}</h3>
                  <p className="text-[12px] mt-0.5" style={{ color: 'rgba(251,251,252,0.4)' }}>{s.time}</p>
                  <p className="text-3xl font-bold mt-4" style={{ color: BRAND.white }}>${s.price}</p>
                  <p className="text-[11px]" style={{ color: 'rgba(251,251,252,0.35)' }}>NZD per day</p>
                </div>
              ))}
            </div>
            <div className="text-center">
              <span className="glow-border-btn group inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full" style={{ background: BRAND.gold, color: BRAND.darkBlue }}>
                {primaryCta || "Book Now"}
                <ArrowRight className="w-4 h-4" />
              </span>
              <E value={content.pricingFootnote} onChange={v => updateContent("pricingFootnote", v)} tag="p" className="text-[12px] mt-3" style={{ color: 'rgba(251,251,252,0.4)' }} data-testid="edit-pricing-note" />
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="py-12 md:py-16" style={{ background: BRAND.darkBlue }}>
          <div className="max-w-2xl mx-auto px-6">
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight mb-6 text-center" style={{ color: BRAND.gold }}>Frequently Asked Questions</h2>
            <EditableFAQ items={faqItems} onUpdate={v => { setFaqItems(v); markChanged(); }} />
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="relative overflow-hidden py-16 md:py-20" style={{ background: `linear-gradient(135deg, ${BRAND.darkBlue} 0%, ${BRAND.blue} 100%)` }}>
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] opacity-[0.06] rounded-full" style={{ background: `radial-gradient(circle, ${BRAND.gold} 0%, transparent 70%)` }} />
          </div>
          <div className="relative max-w-2xl mx-auto px-6 text-center">
            <E value={content.finalCtaTitle} onChange={v => updateContent("finalCtaTitle", v)} tag="h2" className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight mb-3" style={{ color: BRAND.white }} data-testid="edit-final-cta-title" />
            <E value={content.finalCtaSub} onChange={v => updateContent("finalCtaSub", v)} tag="p" className="text-[14px] sm:text-[16px] mb-8" style={{ color: 'rgba(251,251,252,0.55)' }} data-testid="edit-final-cta-sub" />
            <span className="group inline-flex items-center gap-2 px-10 py-3.5 text-[15px] font-bold rounded-full" style={{ background: BRAND.white, color: BRAND.blue, boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>
              {primaryCta || "Book Now"}
              <ArrowRight className="w-4 h-4" />
            </span>
            <E value={content.finalCtaFootnote} onChange={v => updateContent("finalCtaFootnote", v)} tag="p" className="text-[11px] mt-4" style={{ color: 'rgba(251,251,252,0.3)' }} data-testid="edit-final-footnote" />
          </div>
        </section>

        {/* CUSTOM SECTIONS — admin can add stats / feature grid / CTA blocks */}
        <BlocksEditor blocks={customBlocks} onChange={(b) => { setCustomBlocks(b); markChanged(); }} />

        {/* FOOTER */}
        <footer style={{ background: BRAND.darkBlue }}>
          <div className="max-w-4xl mx-auto px-6 py-8">
            <div className="flex flex-col items-center text-center">
              <img src={previewLogo} alt={previewBrandName} className="w-10 h-10 object-contain opacity-50 mb-3" />
              <p className="text-[12px] font-semibold mb-4" style={{ color: 'rgba(251,251,252,0.35)' }}>{previewBrandName}</p>
              <div className="flex items-center gap-5 mb-4">
                <span className="text-[11px] transition-colors" style={{ color: 'rgba(251,251,252,0.3)' }}>Privacy Policy</span>
                <span className="text-[11px] transition-colors" style={{ color: 'rgba(251,251,252,0.3)' }}>Terms & Conditions</span>
              </div>
              <div className="w-full max-w-xs h-px mb-4" style={{ background: 'rgba(251,251,252,0.06)' }} />
              <E value={content.footerDisclaimer} onChange={v => updateContent("footerDisclaimer", v)} tag="p" className="text-[9px] leading-relaxed max-w-md mb-3" style={{ color: 'rgba(251,251,252,0.15)' }} multiline data-testid="edit-footer-disclaimer" />
              <p className="text-[11px]" style={{ color: 'rgba(251,251,252,0.2)' }}>
                &copy; {new Date().getFullYear()} Christchurch United FC. All Rights Reserved.
              </p>
            </div>
          </div>
        </footer>

        {/* STICKY MOBILE CTA */}
        <div className="fixed bottom-0 left-0 right-0 md:hidden z-50 bg-white/95 backdrop-blur-lg border-t border-slate-100 p-3 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]">
          <div className="w-full py-3 text-[14px] font-bold rounded-full text-white text-center" style={{ background: BRAND.blue }}>
            <E value={content.stickyCtaText} onChange={v => updateContent("stickyCtaText", v)} tag="span" className="text-[14px] font-bold text-white" style={{}} data-testid="edit-sticky-cta" />
          </div>
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

      {showAbModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowAbModal(false)} />
          <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-purple-500/20 overflow-hidden" style={{ background: "hsl(var(--card))" }} data-testid="modal-ab-test">
            <div className="flex items-center justify-between px-6 py-4 border-b border-purple-500/10">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-purple-500/15 border border-purple-500/20 flex items-center justify-center">
                  <FlaskConical className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Create A/B Test</h3>
                  <p className="text-xs text-white/40">{fieldLabels[abField] || abField}</p>
                </div>
              </div>
              <button onClick={() => setShowAbModal(false)} className="text-white/40 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="text-xs font-medium text-white/60 mb-2 block">Variants</label>
                {abVariants.map((v, i) => (
                  <div key={i} className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-purple-400 w-6 font-bold">{String.fromCharCode(65 + i)}</span>
                    <Input
                      value={v.value}
                      onChange={e => {
                        const updated = [...abVariants];
                        updated[i] = { ...updated[i], value: e.target.value };
                        setAbVariants(updated);
                      }}
                      placeholder={i === 0 ? "Control (current value)" : `Variant ${String.fromCharCode(65 + i)} text`}
                      className="flex-1 bg-white/5 border-white/10 text-white text-sm placeholder:text-white/30"
                      data-testid={`input-variant-${i}`}
                    />
                    {i > 1 && (
                      <button onClick={() => setAbVariants(abVariants.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-300">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                {abVariants.length < 4 && (
                  <button
                    onClick={() => setAbVariants([...abVariants, { label: `Variant ${String.fromCharCode(65 + abVariants.length)}`, value: "" }])}
                    className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 mt-1"
                    data-testid="btn-add-variant"
                  >
                    <Plus className="w-3 h-3" /> Add variant
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-white/60 mb-2 block">End Condition</label>
                  <Select value={abEndCondition} onValueChange={setAbEndCondition}>
                    <SelectTrigger className="bg-white/5 border-white/10 text-white text-sm" data-testid="select-end-condition">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="days">After X days</SelectItem>
                      <SelectItem value="views">After X page views</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-xs font-medium text-white/60 mb-2 block">
                    {abEndCondition === "days" ? "Number of Days" : "Page View Target"}
                  </label>
                  <Input
                    type="number"
                    value={abEndValue}
                    onChange={e => setAbEndValue(e.target.value)}
                    min="1"
                    className="bg-white/5 border-white/10 text-white text-sm"
                    data-testid="input-end-value"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-purple-500/5 border border-purple-500/10 p-3">
                <p className="text-xs text-purple-300/70">
                  {abEndCondition === "days"
                    ? `Test will run for ${abEndValue} day${abEndValue !== "1" ? "s" : ""}. The winning variant (by revenue/registrations) will be automatically applied.`
                    : `Test will run until ${abEndValue} total page views. The winning variant (by revenue/registrations) will be automatically applied.`
                  }
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-6 py-4 border-t border-purple-500/10">
              <Button variant="ghost" onClick={() => setShowAbModal(false)} className="text-white/60 hover:text-white hover:bg-white/5" data-testid="btn-cancel-ab">Cancel</Button>
              <Button
                onClick={() => createAbMutation.mutate()}
                disabled={createAbMutation.isPending || abVariants.filter(v => v.value.trim()).length < 2}
                className="bg-purple-600 hover:bg-purple-500 text-white"
                data-testid="btn-create-ab"
              >
                {createAbMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <FlaskConical className="w-3.5 h-3.5 mr-1.5" />}
                Launch Split Test
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

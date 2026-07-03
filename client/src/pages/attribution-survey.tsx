import { useState, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle, Sparkles } from "lucide-react";
import { SiInstagram, SiFacebook, SiYoutube, SiTiktok, SiGoogle } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { brandForOrg } from "@/lib/camp-brand";

// clubTint entries take the owning club's colour at render time.
const SOURCES = [
  { id: "instagram", label: "Instagram", icon: SiInstagram, color: "#E4405F", bg: "#E4405F12" },
  { id: "facebook", label: "Facebook", icon: SiFacebook, color: "#1877F2", bg: "#1877F212" },
  { id: "youtube", label: "YouTube", icon: SiYoutube, color: "#FF0000", bg: "#FF000012" },
  { id: "tiktok", label: "TikTok", icon: SiTiktok, color: "#000000", bg: "#00000008" },
  { id: "google", label: "Google Search", icon: SiGoogle, color: "#4285F4", bg: "#4285F412" },
  { id: "facebook_ad", label: "Facebook / Instagram Ad", icon: SiFacebook, color: "#1877F2", bg: "#1877F212" },
  { id: "word_of_mouth", label: "Word of Mouth", icon: null, emoji: "🗣️", clubTint: true, color: "#22399B", bg: "#22399B08" },
  { id: "friend_family", label: "Friend or Family", icon: null, emoji: "👋", clubTint: true, color: "#22399B", bg: "#22399B08" },
  { id: "school_club", label: "School or Club", icon: null, emoji: "🏫", color: "#059669", bg: "#05966912" },
  { id: "billboard_sign", label: "Billboard or Sign", icon: null, emoji: "📋", color: "#D97706", bg: "#D9770612" },
  { id: "email_newsletter", label: "Email / Newsletter", icon: null, emoji: "📧", color: "#7C3AED", bg: "#7C3AED12" },
  { id: "other", label: "Other", icon: null, emoji: "💬", color: "#6B7280", bg: "#6B728012" },
];

export default function AttributionSurvey() {
  const [, params] = useRoute("/:slug/feedback");
  const [, setLocation] = useLocation();
  const slug = params?.slug || "";

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
  const sources = SOURCES.map(s => (s as any).clubTint ? { ...s, color: clubBrand.primary, bg: `${clubBrand.primary}08` } : s);
  const urlParams = new URLSearchParams(window.location.search);
  const registrationId = urlParams.get("registrationId");
  const [selected, setSelected] = useState<string | null>(null);
  const [otherText, setOtherText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (registrationId) {
      fetch("/api/public/confirm-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registrationId: parseInt(registrationId) }),
      }).catch(() => {});
    }
  }, [registrationId]);

  const submitMut = useMutation({
    mutationFn: (source: string) =>
      apiRequest("PATCH", `/api/public/registrations/${registrationId}/attribution`, { referralSource: source }),
    onSuccess: () => setSubmitted(true),
    onError: () => {
      setSubmitted(true);
    },
  });

  const handleSubmit = () => {
    if (!selected) return;
    const source = selected === "other" && otherText.trim() ? `Other: ${otherText.trim()}` : selected;
    submitMut.mutate(source);
  };

  const handleSkip = () => {
    setLocation(`/${slug}/success?registrationId=${registrationId}`);
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.white, fontFamily: "'Inter Tight', system-ui, -apple-system, sans-serif" }}>
        <div className="max-w-md mx-auto px-6 py-16 text-center space-y-6">
          <div className="relative inline-block">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto" style={{ background: '#ecfdf5' }}>
              <CheckCircle className="w-10 h-10 text-emerald-500" />
            </div>
            <div className="absolute -top-1 right-0 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: BRAND.gold }}>
              <Sparkles className="w-3 h-3 text-white" />
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }}>Thank You!</h1>
            <p className="text-[15px] text-slate-500 mt-2">Your feedback helps us reach more families like yours.</p>
          </div>
          <Button
            onClick={() => setLocation(`/${slug}/success?registrationId=${registrationId}`)}
            className="rounded-xl h-12 text-[15px] font-bold text-white border-0 cursor-pointer"
            style={{ background: BRAND.blue, boxShadow: `0 6px 20px ${BRAND.blue}25` }}
            data-testid="button-continue-to-confirmation"
          >
            Continue to Confirmation
          </Button>
        </div>
      </div>
    );
  }

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
          <button
            onClick={handleSkip}
            className="text-[12px] text-slate-400 hover:text-slate-600 transition-colors font-medium cursor-pointer"
            data-testid="button-skip-survey"
          >
            Skip
          </button>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-6 py-10 sm:py-14">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-[0.1em] mb-4"
            style={{ background: `${BRAND.gold}15`, color: BRAND.gold }}>
            <Sparkles className="w-3 h-3" />
            Quick Question
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: BRAND.darkBlue }} data-testid="text-survey-title">
            How did you hear about us?
          </h1>
          <p className="text-[15px] text-slate-500 mt-2 max-w-sm mx-auto">
            Help us understand how families find our camps so we can reach even more players.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3" data-testid="attribution-options">
          {sources.map(src => {
            const isSelected = selected === src.id;
            return (
              <button
                key={src.id}
                onClick={() => setSelected(src.id)}
                className="relative flex items-center gap-3 px-4 py-3.5 rounded-2xl border-2 text-left transition-all duration-200 cursor-pointer"
                style={{
                  background: isSelected ? `${src.color}08` : "white",
                  borderColor: isSelected ? src.color : "#e2e8f0",
                  boxShadow: isSelected ? `0 0 0 1px ${src.color}20, 0 4px 12px ${src.color}10` : "0 1px 3px rgba(0,0,0,0.04)",
                }}
                data-testid={`option-${src.id}`}
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: src.bg }}>
                  {src.icon ? (
                    <src.icon className="w-4.5 h-4.5" style={{ color: src.color, width: 18, height: 18 }} />
                  ) : (
                    <span className="text-lg">{src.emoji}</span>
                  )}
                </div>
                <span className="text-[13px] font-semibold text-slate-700 leading-tight">{src.label}</span>
                {isSelected && (
                  <div className="absolute top-2 right-2 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: src.color }}>
                    <CheckCircle className="w-3.5 h-3.5 text-white" />
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {selected === "other" && (
          <div className="mt-4">
            <Input
              placeholder="Please tell us where you heard about us..."
              value={otherText}
              onChange={e => setOtherText(e.target.value)}
              className="rounded-xl h-12 border-slate-200 text-[14px] focus:border-blue-400 focus:ring-blue-400/20"
              data-testid="input-other-source"
            />
          </div>
        )}

        <div className="mt-8 space-y-3">
          <Button
            onClick={handleSubmit}
            disabled={!selected || submitMut.isPending}
            className="w-full rounded-xl h-12 text-[15px] font-bold text-white border-0 cursor-pointer disabled:opacity-40"
            style={{ background: BRAND.blue, boxShadow: selected ? `0 6px 20px ${BRAND.blue}25` : "none" }}
            data-testid="button-submit-attribution"
          >
            {submitMut.isPending ? "Submitting..." : "Submit"}
          </Button>
          <p className="text-center text-[11px] text-slate-400">
            Your response is anonymous and helps us improve our outreach.
          </p>
        </div>
      </main>
    </div>
  );
}

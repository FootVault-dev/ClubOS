import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRoute, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Mail, Calendar, Trophy, Loader2, CreditCard } from "lucide-react";
import { trackEvent } from "@/lib/meta-pixel";
import { purchaseEventId } from "@shared/meta-events";
import { formatCurrency } from "@/lib/format";

const BRAND = {
  black: "#000000", bg: "#0a0a0a", card: "#141414", cardSoft: "#1c1c1c", border: "#2a2a2a",
  gold: "#d1b96e", goldDeep: "#a8915a", white: "#ffffff",
  muted: "rgba(255,255,255,0.62)", dim: "rgba(255,255,255,0.38)",
};
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";
const PIXEL_CONTENT = "MFL Term 3 Team Registration";

export default function MflSuccessPage() {
  const [, params] = useRoute("/league/:slug/success");
  const slug = params?.slug || "";
  const registrationId = new URLSearchParams(window.location.search).get("registrationId");
  const [confirmed, setConfirmed] = useState(false);
  const [tracked, setTracked] = useState(false);

  const { data: reg, isLoading } = useQuery<any>({
    queryKey: ["/api/public/league/registration", registrationId],
    queryFn: async () => {
      const res = await fetch(`/api/public/league/registration/${registrationId}`);
      if (!res.ok) throw new Error("not found");
      return res.json();
    },
    enabled: !!registrationId,
    refetchInterval: (q) => (q.state.data?.status === "confirmed" || confirmed ? false : 2000),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/public/confirm-payment", { registrationId: parseInt(registrationId || "0") });
      return res.json();
    },
    onSuccess: () => setConfirmed(true),
  });

  useEffect(() => { if (registrationId && !confirmed) confirmMutation.mutate(); }, [registrationId]);

  useEffect(() => {
    if (reg && (reg.status === "confirmed" || confirmed) && !tracked) {
      const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
      if (pixelId) {
        trackEvent("Purchase", {
          content_name: PIXEL_CONTENT,
          content_category: "League Team Registration",
          value: (reg.depositCents ?? reg.totalCents ?? 0) / 100,
          currency: reg.currency || "NZD",
          content_ids: [reg.slug || slug],
        }, purchaseEventId(reg.id));
      }
      setTracked(true);
    }
  }, [reg, confirmed, tracked, slug]);

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.black }}><Skeleton className="h-64 w-96 rounded-2xl" style={{ background: BRAND.card }} /></div>;
  }

  const isConfirmed = reg?.status === "confirmed" || confirmed;

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: BRAND.black, color: BRAND.white, fontFamily: FONT }}>
      <main className="max-w-md mx-auto px-6 py-12 text-center">
        {isConfirmed ? (
          <div className="space-y-6">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mx-auto" style={{ background: `${BRAND.gold}1f` }}>
              <Trophy className="w-10 h-10" style={{ color: BRAND.gold }} />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">You're in! 🎉</h1>
              <p className="mt-2" style={{ color: BRAND.muted }}>{(reg?.teamCount ?? 1) > 1 ? `Your ${reg.teamCount} teams are locked into Term 3.` : (reg?.teamName ? `${reg.teamName} is locked into Term 3.` : "Your team is locked into Term 3.")}</p>
            </div>

            {reg && (
              <div className="rounded-2xl p-6 text-left space-y-3" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
                <h3 className="text-[11px] uppercase tracking-[0.12em] font-bold" style={{ color: BRAND.gold }}>Registration summary</h3>
                {(reg.teamCount ?? 1) > 1 && Array.isArray(reg.teams) ? (
                  reg.teams.map((t: any) => <Row key={t.id} label={t.teamName || `Team #${t.id}`} value={t.divisionName || "—"} />)
                ) : (
                  <>
                    <Row label="Team" value={reg.teamName || "—"} />
                    {reg.divisionName && <Row label="Night" value={reg.divisionName} />}
                  </>
                )}
                <Row label="Booking no." value={(reg.teamCount ?? 1) > 1 ? `${reg.teamCount} teams` : `#${reg.id}`} />
                {reg.paymentMode === "deposit_weekly" && reg.balanceStatus !== "paid" ? (
                  <>
                    <Row label="Deposit paid" value={`${formatCurrency(reg.depositCents || 0, { fromCents: true })} NZD`} gold />
                    <div className="rounded-xl px-4 py-3 mt-1 text-[13px] flex items-start gap-2" style={{ background: `${BRAND.gold}14`, color: BRAND.gold }}>
                      <CreditCard className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>Then {formatCurrency(reg.weeklyAmountCents || 0, { fromCents: true })}/week, auto-charged for {reg.weeksTotal} weeks once the season starts{(reg.weeksPaid ?? 0) > 0 ? ` (${reg.weeksPaid}/${reg.weeksTotal} paid)` : ""}. Your deposit covers the final weeks.</span>
                    </div>
                  </>
                ) : reg.isInstalment && reg.balanceStatus !== "paid" ? (
                  <>
                    <Row label="Deposit paid" value={`${formatCurrency(reg.depositCents || 0, { fromCents: true })} NZD`} gold />
                    <div className="rounded-xl px-4 py-3 mt-1 text-[13px] flex items-start gap-2" style={{ background: `${BRAND.gold}14`, color: BRAND.gold }}>
                      <CreditCard className="w-4 h-4 mt-0.5 flex-shrink-0" />
                      <span>{formatCurrency(reg.balanceCents || 0, { fromCents: true })} balance auto-charged{reg.balanceDueDate ? ` on ${new Date(reg.balanceDueDate + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long" })}` : " ~3 weeks in"}.</span>
                    </div>
                  </>
                ) : (
                  <Row label="Paid in full" value={`${formatCurrency(reg.totalCents || 0, { fromCents: true })} NZD`} gold />
                )}
              </div>
            )}

            <div className="rounded-2xl p-5 text-left flex items-start gap-3" style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}` }}>
              <Mail className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: BRAND.gold }} />
              <div>
                <p className="font-semibold">Confirmation email sent</p>
                <p className="text-sm mt-0.5" style={{ color: BRAND.muted }}>Check {reg?.captainEmail || "your inbox"} for the details. We'll be in touch with your fixtures before kick-off.</p>
              </div>
            </div>

            <Link href={`/league/${slug}`}>
              <a className="inline-block w-full py-3.5 rounded-full font-bold" style={{ background: BRAND.gold, color: BRAND.black }}>Back to the league</a>
            </Link>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto" style={{ background: `${BRAND.gold}14` }}>
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.gold }} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Confirming your registration…</h1>
              <p className="mt-2" style={{ color: BRAND.muted }}>This usually takes a few seconds.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Row({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="flex justify-between text-[14px]">
      <span style={{ color: BRAND.muted }}>{label}</span>
      <span className="font-semibold" style={{ color: gold ? BRAND.gold : BRAND.white }}>{value}</span>
    </div>
  );
}

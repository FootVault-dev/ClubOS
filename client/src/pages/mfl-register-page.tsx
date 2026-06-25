import { useEffect, useState, useMemo, useRef } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/format";
import { initPixel, trackEvent, getFbp, getFbc, generateEventId } from "@/lib/meta-pixel";
import { ArrowLeft, ArrowRight, Loader2, Flame, Plus, X, Tag } from "lucide-react";

const BRAND = {
  black: "#000000", bg: "#0a0a0a", card: "#141414", cardSoft: "#1c1c1c", border: "#2a2a2a",
  gold: "#d1b96e", goldDeep: "#a8915a", white: "#ffffff",
  muted: "rgba(255,255,255,0.62)", dim: "rgba(255,255,255,0.38)",
};
const FONT = "'Inter Tight', Inter, system-ui, -apple-system, sans-serif";
const PIXEL_CONTENT = "MFL Term 3 Team Registration";

const inputCls = "w-full rounded-xl px-4 py-3 text-[15px] outline-none transition-colors";
const inputStyle: React.CSSProperties = { background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white };

interface TeamRow { teamName: string; divisionId: number | null }
interface Pricing {
  subtotalCents: number;
  discountLines: { code: string; label: string; amountCents: number }[];
  multiTeamApplied: boolean;
  discountTotalCents: number;
  totalCents: number;
  depositDueCents: number;
  weeklyAmountCents: number;
  weeksTotal: number | null;
  paymentMode: string;
  payInFull?: boolean;
  rejectedCodes: string[];
  teamCount: number;
}

export default function MflRegisterPage() {
  const [, params] = useRoute("/league/:slug/register");
  const slug = params?.slug || "";
  const [, setLocation] = useLocation();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [teams, setTeams] = useState<TeamRow[]>([{ teamName: "", divisionId: null }]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  const [codes, setCodes] = useState<string[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [paymentChoice, setPaymentChoice] = useState<"weekly" | "full">("weekly");

  useEffect(() => {
    const pixelId = (import.meta as any).env?.VITE_META_PIXEL_ID;
    if (pixelId) {
      initPixel(pixelId);
      trackEvent("InitiateCheckout", { content_name: PIXEL_CONTENT, currency: "NZD" });
    }
  }, []);

  useEffect(() => {
    fetch(`/api/public/league/register/${slug}`)
      .then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then((d) => {
        setData(d);
        const wantedId = parseInt(new URLSearchParams(window.location.search).get("division") || "");
        const preselect = (d.divisions || []).find((x: any) => x.id === wantedId);
        const firstOpen = (d.divisions || []).find((x: any) => x.spotsLeft == null || x.spotsLeft > 0);
        const pick = preselect || firstOpen;
        if (pick) setTeams([{ teamName: "", divisionId: pick.id }]);
      })
      .catch(() => setError("This league isn't available right now."))
      .finally(() => setLoading(false));
  }, [slug]);

  const divisions: any[] = data?.divisions || [];
  const divById = useMemo(() => Object.fromEntries(divisions.map((d) => [d.id, d])), [divisions]);

  // Local gross subtotal for instant feedback (server is authoritative on stacks).
  const localSubtotalCents = useMemo(
    () => teams.reduce((s, t) => s + (t.divisionId ? (divById[t.divisionId]?.teamCostCents || 0) : 0), 0),
    [teams, divById],
  );

  const lateFeeCents = data?.earlyBird && !data.earlyBird.active ? (data.earlyBird.lateFeeCents || 0) : 0;
  const allTeamsHaveNight = teams.length > 0 && teams.every((t) => t.divisionId != null);

  // Debounced server pricing: recomputes the stacked discount + combined deposit
  // whenever the teams or applied codes change.
  const priceReq = useRef(0);
  useEffect(() => {
    if (!data || !allTeamsHaveNight) { setPricing(null); return; }
    const reqId = ++priceReq.current;
    const t = setTimeout(() => {
      fetch("/api/public/league/validate-discounts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, teams: teams.map((tm) => ({ divisionId: tm.divisionId, upsells: [] })), codes, paymentChoice }),
      })
        .then((r) => r.json())
        .then((p) => { if (reqId === priceReq.current && !p.message) setPricing(p); })
        .catch(() => { /* keep last good pricing */ });
    }, 280);
    return () => clearTimeout(t);
  }, [data, slug, teams, codes, paymentChoice, allTeamsHaveNight]);

  const updateTeam = (i: number, patch: Partial<TeamRow>) =>
    setTeams((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTeam = () => setTeams((prev) => [...prev, { teamName: "", divisionId: prev[prev.length - 1]?.divisionId ?? null }]);
  const removeTeam = (i: number) => setTeams((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  const applyCode = () => {
    const c = codeInput.trim().toUpperCase();
    if (!c) return;
    if (c === "MULTITEAM") { setCodeInput(""); return; } // auto-applied, not typed
    if (!codes.includes(c)) setCodes((prev) => [...prev, c]);
    setCodeInput("");
  };
  const removeCode = (c: string) => setCodes((prev) => prev.filter((x) => x !== c));

  const rejected = pricing?.rejectedCodes || [];
  const validDiscountLines = (pricing?.discountLines || []).filter((l) => l.amountCents > 0);
  // Club-applied automatic discounts (early bird until deadline, multi-team for
  // 2+ teams) — shown as "auto" badges; the rest are the customer's typed codes.
  const AUTO = ["EARLYBIRD", "MULTITEAM"];
  const autoDiscountLines = validDiscountLines.filter((l) => AUTO.includes(l.code.toUpperCase()));

  // Display figures: prefer server pricing, fall back to local gross.
  const subtotalCents = pricing?.subtotalCents ?? (localSubtotalCents + lateFeeCents);
  const totalCents = pricing?.totalCents ?? subtotalCents;
  const payInFull = paymentChoice === "full";
  const offersWeekly = data?.paymentPlan === "deposit_weekly";
  const isWeekly = !payInFull && (pricing?.paymentMode || data?.paymentPlan) === "deposit_weekly";
  const depositCents = pricing?.depositDueCents ?? 0;
  const weeklyAmountCents = pricing?.weeklyAmountCents ?? 0;
  const weeksTotal = pricing?.weeksTotal ?? (data?.numWeeklyPayments || 8);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (teams.some((t) => !t.teamName || t.divisionId == null) || !firstName || !email) {
      setError("Please give every team a name and night, and fill in your contact details.");
      return;
    }
    setSubmitting(true);
    setError(null);

    const url = new URL(window.location.href);
    const leadEventId = generateEventId();
    trackEvent("Lead", { content_name: PIXEL_CONTENT, value: totalCents / 100, currency: "NZD" }, leadEventId);

    try {
      const res = await fetch("/api/public/league/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          teams: teams.map((t) => ({ teamName: t.teamName, divisionId: t.divisionId, upsells: [] })),
          discountCodes: codes,
          paymentChoice,
          captain: { firstName, lastName, email, phone },
          utmSource: url.searchParams.get("utm_source"),
          utmMedium: url.searchParams.get("utm_medium"),
          utmCampaign: url.searchParams.get("utm_campaign"),
          fbclid: url.searchParams.get("fbclid"),
          fbp: getFbp(),
          fbc: getFbc(),
          userAgent: navigator.userAgent,
          leadEventId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || "Registration failed");
      setLocation(`/league/${slug}/checkout?registrationId=${body.registrationId}`);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
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

  const NightPicker = ({ value, onPick }: { value: number | null; onPick: (id: number) => void }) => (
    <div className="grid sm:grid-cols-2 gap-3">
      {divisions.map((d: any) => {
        const full = d.spotsLeft != null && d.spotsLeft <= 0;
        const active = value === d.id;
        return (
          <button type="button" key={d.id} disabled={full} onClick={() => onPick(d.id)}
            className="rounded-xl px-4 py-3 text-left transition-all"
            style={{ background: active ? `${BRAND.gold}1f` : BRAND.cardSoft, border: `1px solid ${active ? BRAND.gold : BRAND.border}`, opacity: full ? 0.45 : 1 }}
            data-testid={`division-${d.id}`}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">{d.name}</span>
              <span className="text-sm font-bold" style={{ color: BRAND.gold }}>{formatCurrency(d.teamCostCents, { fromCents: true })}</span>
            </div>
            <span className="text-[12px]" style={{ color: BRAND.muted }}>{d.dayOfWeek || "Weeknights"}{full ? " · full" : d.spotsLeft != null ? ` · ${d.spotsLeft} left` : ""}</span>
          </button>
        );
      })}
    </div>
  );

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

      <main className="max-w-2xl mx-auto px-6 py-10">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Register your team{teams.length > 1 ? "s" : ""}</h1>
        <p className="mt-1.5" style={{ color: BRAND.muted }}>Enter more than one team and the <strong style={{ color: BRAND.gold }}>multi-team 10%</strong> stacks automatically.</p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          {/* Teams */}
          {teams.map((t, i) => (
            <div key={i} className="rounded-2xl p-5 space-y-4" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold" style={{ color: BRAND.gold }}>Team {i + 1}</span>
                {teams.length > 1 && (
                  <button type="button" onClick={() => removeTeam(i)} className="flex items-center gap-1 text-[12px]" style={{ color: BRAND.dim }} data-testid={`remove-team-${i}`}>
                    <X className="w-3.5 h-3.5" /> Remove
                  </button>
                )}
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Team name</label>
                <input className={inputCls} style={inputStyle} value={t.teamName} onChange={(e) => updateTeam(i, { teamName: e.target.value })} placeholder="e.g. The Untouchaballs" data-testid={`input-team-name-${i}`} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-2">Pick your night</label>
                <NightPicker value={t.divisionId} onPick={(id) => updateTeam(i, { divisionId: id })} />
              </div>
            </div>
          ))}

          {teams.length < 12 && (
            <button type="button" onClick={addTeam}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-[15px]"
              style={{ background: BRAND.cardSoft, border: `1px dashed ${BRAND.gold}`, color: BRAND.gold }} data-testid="button-add-team">
              <Plus className="w-4 h-4" /> Add another team {teams.length === 1 ? "(unlock 10% multi-team)" : ""}
            </button>
          )}

          {/* Captain details */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-2">First name</label>
              <input className={inputCls} style={inputStyle} value={firstName} onChange={(e) => setFirstName(e.target.value)} data-testid="input-first-name" />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-2">Last name</label>
              <input className={inputCls} style={inputStyle} value={lastName} onChange={(e) => setLastName(e.target.value)} data-testid="input-last-name" />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-2">Email</label>
              <input type="email" className={inputCls} style={inputStyle} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-email" />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-2">Mobile</label>
              <input className={inputCls} style={inputStyle} value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="input-phone" />
            </div>
          </div>

          {/* Promo code — discount codes are handed out privately; never list or
              hint the actual codes here, so only people who qualify can use them. */}
          <div>
            <label className="block text-sm font-semibold mb-2">Promo code</label>
            <div className="flex gap-2">
              <input className={inputCls} style={inputStyle} value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyCode(); } }}
                placeholder="Enter a code" data-testid="input-promo-code" />
              <button type="button" onClick={applyCode}
                className="px-5 rounded-xl font-semibold whitespace-nowrap"
                style={{ background: BRAND.cardSoft, border: `1px solid ${BRAND.border}`, color: BRAND.white }} data-testid="button-apply-code">
                Apply
              </button>
            </div>
            <p className="mt-1.5 text-[12px]" style={{ color: BRAND.dim }}>Got a code? Enter it to apply your discount.</p>
            {(codes.length > 0 || autoDiscountLines.length > 0) && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {autoDiscountLines.map((l) => (
                  <span key={l.code} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold" style={{ background: `${BRAND.gold}1f`, color: BRAND.gold }}>
                    <Tag className="w-3 h-3" /> {l.label} · auto
                  </span>
                ))}
                {codes.map((c) => {
                  const bad = rejected.includes(c);
                  return (
                    <span key={c} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold"
                      style={{ background: bad ? "rgba(220,38,38,0.12)" : `${BRAND.gold}1f`, color: bad ? "#fca5a5" : BRAND.gold }}>
                      <Tag className="w-3 h-3" /> {c}{bad ? " · invalid" : ""}
                      <button type="button" onClick={() => removeCode(c)} data-testid={`remove-code-${c}`}><X className="w-3 h-3" /></button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Payment method — pay in full, or deposit + weekly */}
          {offersWeekly && (
            <div>
              <label className="block text-sm font-semibold mb-2">How would you like to pay?</label>
              <div className="grid sm:grid-cols-2 gap-3">
                <button type="button" onClick={() => setPaymentChoice("full")}
                  className="rounded-xl px-4 py-3 text-left transition-all"
                  style={{ background: payInFull ? `${BRAND.gold}1f` : BRAND.cardSoft, border: `1px solid ${payInFull ? BRAND.gold : BRAND.border}` }}
                  data-testid="pay-full">
                  <div className="font-semibold">Pay in full</div>
                  <div className="text-[12px] mt-0.5" style={{ color: BRAND.muted }}>One payment of {formatCurrency(totalCents, { fromCents: true })} today.</div>
                </button>
                <button type="button" onClick={() => setPaymentChoice("weekly")}
                  className="rounded-xl px-4 py-3 text-left transition-all"
                  style={{ background: !payInFull ? `${BRAND.gold}1f` : BRAND.cardSoft, border: `1px solid ${!payInFull ? BRAND.gold : BRAND.border}` }}
                  data-testid="pay-weekly">
                  <div className="font-semibold">Deposit + weekly</div>
                  <div className="text-[12px] mt-0.5" style={{ color: BRAND.muted }}>A deposit now, then spread the rest weekly.</div>
                </button>
              </div>
            </div>
          )}

          {/* Summary */}
          <div className="rounded-2xl p-5 space-y-2.5" style={{ background: BRAND.card, border: `1px solid ${BRAND.border}` }}>
            {teams.map((t, i) => {
              const d = t.divisionId ? divById[t.divisionId] : null;
              return (
                <div key={i} className="flex justify-between text-sm">
                  <span style={{ color: BRAND.muted }}>{t.teamName?.trim() || `Team ${i + 1}`}{d ? ` · ${d.name}` : ""}</span>
                  <span>{formatCurrency(d?.teamCostCents || 0, { fromCents: true })}</span>
                </div>
              );
            })}
            {lateFeeCents > 0 && (
              <div className="flex justify-between text-sm" style={{ color: BRAND.gold }}>
                <span className="flex items-center gap-1"><Flame className="w-3.5 h-3.5" /> Late registration fee</span><span>{formatCurrency(lateFeeCents, { fromCents: true })}</span>
              </div>
            )}
            <div className="flex justify-between text-sm pt-1 border-t" style={{ borderColor: BRAND.border }}>
              <span style={{ color: BRAND.muted }}>Subtotal</span><span>{formatCurrency(subtotalCents, { fromCents: true })}</span>
            </div>
            {validDiscountLines.map((l) => (
              <div key={l.code} className="flex justify-between text-sm" style={{ color: BRAND.gold }}>
                <span>{l.label}</span><span>−{formatCurrency(l.amountCents, { fromCents: true })}</span>
              </div>
            ))}
            <div className="flex justify-between font-bold pt-2.5 border-t" style={{ borderColor: BRAND.border }}>
              <span>Total (incl. GST)</span><span>{formatCurrency(totalCents, { fromCents: true })} NZD</span>
            </div>
            {payInFull ? (
              <div className="rounded-xl px-4 py-3 mt-1 text-[13px]" style={{ background: `${BRAND.gold}14`, color: BRAND.gold }}>
                Pay <strong>{formatCurrency(totalCents, { fromCents: true })}</strong> today — paid in full, no weekly charges.
              </div>
            ) : isWeekly && depositCents > 0 ? (
              <div className="rounded-xl px-4 py-3 mt-1 text-[13px]" style={{ background: `${BRAND.gold}14`, color: BRAND.gold }}>
                Pay <strong>{formatCurrency(depositCents, { fromCents: true })}</strong> deposit now to lock {teams.length > 1 ? "your spots" : "your spot"} · then <strong>{formatCurrency(weeklyAmountCents, { fromCents: true })}/week</strong> for {weeksTotal} weeks once the season starts. Your deposit covers the final weeks.
              </div>
            ) : null}
          </div>

          {error && <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "rgba(220,38,38,0.12)", color: "#fca5a5", border: "1px solid rgba(220,38,38,0.3)" }}>{error}</div>}

          <button type="submit" disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-4 rounded-full font-bold text-[16px] disabled:opacity-60"
            style={{ background: BRAND.gold, color: BRAND.black }} data-testid="button-continue-to-payment">
            {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Securing your spot…</> : <>Continue to payment <ArrowRight className="w-4 h-4" /></>}
          </button>
          <p className="text-center text-[12px]" style={{ color: BRAND.dim }}>Secure payment by Stripe · You'll confirm on the next step</p>
        </form>
      </main>
    </div>
  );
}

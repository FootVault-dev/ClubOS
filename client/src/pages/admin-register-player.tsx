import { useState, useMemo, useEffect, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency, centsToDollarInput, dollarInputToCents } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Badge } from "@/components/ui/badge";
import { OFFICE_PAYMENT_METHODS } from "@shared/payments";
import { NZF_ETHNICITIES, GENDERS } from "@shared/academy";
import {
  X, ChevronRight, ChevronLeft, User, Baby, Calendar, CheckCircle,
  Plus, Trash2, Loader2, Building2, CreditCard, Banknote, AlertTriangle, Lock,
} from "lucide-react";

interface ChildData {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  allergies: string;
  epiPen: boolean;
  medicalNotes: string;
}

interface BookingItem {
  childIndex: number;
  campDateId: number;
  productType: string;
}

interface StaffMember { id: number; firstName: string; lastName: string }

interface ProgrammeRow {
  id: number;
  name: string;
  slug: string;
  type: string;
  isActive?: boolean;
  registrationOpen?: boolean;
}

interface AcademyQuote {
  programme: {
    id: number; name: string; section: string; registrationOpen: boolean;
    seasonYear: number; ageMin: number | null; ageMax: number | null;
  };
  term: { name: string; termNumber: number | null; startDate: string; endDate: string } | null;
  allowFullYear: boolean;
  options: { id: number; name: string; fullPriceCents: number; scheduleText?: string | null }[];
  quote: {
    plan: string; subtotalCents: number; discountCents: number; totalCents: number;
    reason?: string; sessionsRemaining?: number | null; totalSessions?: number | null;
  } | null;
}

function formatDate(dateStr: string) {
  return new Date(dateStr + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" });
}

function formatProductType(pt: string) {
  if (pt === "FULL_DAY") return "Full Day";
  if (pt === "MORNING") return "Morning";
  if (pt === "AFTERNOON") return "Afternoon";
  return pt;
}

const FIELD = "bg-white/[0.03] border-white/[0.08] text-white/90 placeholder:text-white/25";
const LABEL = "text-[11px] uppercase tracking-wide text-white/40 mb-1.5 block";

// NZ calendar day, not toISOString() — that reports UTC and reads a day behind
// here from midday on, which would let staff pick "tomorrow" as a birthday.
function nzTodayIso() {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const nzToday = nzTodayIso();
const thisYear = Number(nzToday.slice(0, 4));

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: any; hint?: string }) {
  return (
    <div className="min-w-0">
      <label className={LABEL}>
        {label}{required && <span className="text-blue-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[10.5px] text-white/30 mt-1 leading-snug">{hint}</p>}
    </div>
  );
}

export function RegisterPlayerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState(0);

  const [selectedProgramId, setSelectedProgramId] = useState<number | null>(null);

  // ── Camp shape ────────────────────────────────────────────────────────────
  const [parentFirst, setParentFirst] = useState("");
  const [parentLast, setParentLast] = useState("");
  const [parentEmail, setParentEmail] = useState("");
  const [parentPhone, setParentPhone] = useState("");
  const [emergencyContact, setEmergencyContact] = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [children, setChildren] = useState<ChildData[]>([
    { firstName: "", lastName: "", dateOfBirth: "", allergies: "", epiPen: false, medicalNotes: "" },
  ]);
  const [items, setItems] = useState<BookingItem[]>([]);

  // ── Academy shape ─────────────────────────────────────────────────────────
  const [optionId, setOptionId] = useState<number | null>(null);
  const [plan, setPlan] = useState<"term" | "year">("term");
  const [playerFirst, setPlayerFirst] = useState("");
  const [playerLast, setPlayerLast] = useState("");
  const [playerDob, setPlayerDob] = useState("");
  const [playerGender, setPlayerGender] = useState("");
  const [playerSchool, setPlayerSchool] = useState("");
  const [countryOfBirth, setCountryOfBirth] = useState("");
  const [nationality, setNationality] = useState("");
  const [ethnicity, setEthnicity] = useState("");
  const [allergies, setAllergies] = useState("");
  const [medicalNotes, setMedicalNotes] = useState("");
  const [relationship, setRelationship] = useState("parent");
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [ackAgeWarning, setAckAgeWarning] = useState(false);

  // ── Payment (both shapes) ─────────────────────────────────────────────────
  const [isPaid, setIsPaid] = useState(true);
  const [method, setMethod] = useState<string>("eftpos");
  const [amountDollars, setAmountDollars] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [reference, setReference] = useState("");
  const [servedById, setServedById] = useState<number | null>(null);
  const [notes, setNotes] = useState("");

  const { data: me } = useQuery<{ id: number; firstName: string; lastName: string }>({ queryKey: ["/api/auth/me"] });
  const { data: staff } = useQuery<StaffMember[]>({ queryKey: ["/api/admin/staff-directory"] });
  const { data: camps } = useQuery<ProgrammeRow[]>({ queryKey: ["/api/admin/camps"] });
  const { data: academy } = useQuery<ProgrammeRow[]>({ queryKey: ["/api/admin/academy"] });

  // Default "served by" to whoever is logged in — usually the person at the
  // counter — but leave it changeable, because Olga may be typing up what
  // Travis took an hour ago.
  useEffect(() => {
    if (me?.id && servedById === null) setServedById(me.id);
  }, [me?.id, servedById]);

  const programmes: ProgrammeRow[] = useMemo(() => {
    const a = (academy || []).map((p) => ({ ...p, type: "academy" }));
    const c = (camps || []).map((p) => ({ ...p, type: "holiday_camp" }));
    return [...a, ...c];
  }, [academy, camps]);

  const programme = programmes.find((p) => p.id === selectedProgramId) || null;
  const shape: "academy" | "camp" | null =
    programme ? (programme.type === "academy" ? "academy" : "camp") : null;

  const STEPS = shape === "academy"
    ? ["Programme", "Family", "Payment", "Confirm"]
    : ["Programme", "Parent", "Children", "Sessions", "Payment", "Confirm"];

  // ── Academy pricing: quoted by the server, never computed here ────────────
  const { data: academyData, isFetching: quoting } = useQuery<AcademyQuote>({
    queryKey: ["/api/admin/registrations/manual/quote", selectedProgramId, optionId, plan],
    queryFn: async () => {
      const qs = new URLSearchParams({ programId: String(selectedProgramId), plan });
      if (optionId) qs.set("programOptionId", String(optionId));
      const res = await fetch(`/api/admin/registrations/manual/quote?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not price this programme");
      return res.json();
    },
    enabled: shape === "academy" && !!selectedProgramId,
  });

  // One sellable option → choose it automatically, same as the public checkout.
  useEffect(() => {
    if (shape !== "academy") return;
    const opts = academyData?.options || [];
    if (opts.length === 1 && optionId !== opts[0].id) setOptionId(opts[0].id);
  }, [academyData, shape, optionId]);

  // ── Camp pricing (unchanged) ──────────────────────────────────────────────
  const { data: campData } = useQuery<{ camp: any; pricing: any[]; dates: any[]; discounts: any[] }>({
    queryKey: ["/api/public/camps", selectedProgramId],
    queryFn: async () => {
      if (!programme?.slug) return null;
      const res = await fetch(`/api/public/camps/${programme.slug}`);
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
    enabled: shape === "camp" && !!selectedProgramId,
  });

  const pricing = campData?.pricing || [];
  const dates = campData?.dates || [];
  const validChildren = children.filter((c) => c.firstName.trim());

  const campTotals = useMemo(() => {
    let subtotal = 0;
    for (const item of items) {
      const price = pricing.find((p: any) => p.productType === item.productType);
      if (price) subtotal += price.priceCents * validChildren.length;
    }
    const totalItems = validChildren.length * items.length;
    const discounts = campData?.discounts || [];
    const applicable = discounts
      .filter((d: any) => totalItems >= d.minBookings)
      .sort((a: any, b: any) => Number(b.discountPercent) - Number(a.discountPercent))[0];
    const discount = applicable ? Math.round(subtotal * Number(applicable.discountPercent) / 100) : 0;
    return { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount };
  }, [items, pricing, validChildren.length, campData]);

  const totalCents = shape === "academy"
    ? academyData?.quote?.totalCents ?? 0
    : campTotals.totalCents;

  // Keep the amount box in step with the price until the user edits it — a
  // part-payment is deliberate, never a stale number left behind by a change
  // of option.
  useEffect(() => {
    if (!amountTouched) setAmountDollars(totalCents > 0 ? centsToDollarInput(totalCents) : "");
  }, [totalCents, amountTouched]);

  const paidCents = isPaid ? dollarInputToCents(amountDollars) : 0;
  const isShortPayment = isPaid && paidCents > 0 && paidCents < totalCents;

  const registerMutation = useMutation({
    mutationFn: async () => {
      const payment = {
        isPaid,
        method: isPaid ? method : null,
        reference: reference.trim() || null,
        amountPaidCents: isPaid ? paidCents : 0,
      };

      if (shape === "academy") {
        const res = await apiRequest("POST", "/api/admin/registrations/manual", {
          programId: selectedProgramId,
          programOptionId: optionId,
          paymentPlan: plan,
          guardian: {
            firstName: parentFirst, lastName: parentLast,
            email: parentEmail, phone: parentPhone, relationship,
          },
          player: {
            firstName: playerFirst, lastName: playerLast, dateOfBirth: playerDob,
            gender: playerGender, school: playerSchool,
            countryOfBirth, nationality, ethnicity,
            allergies, medicalNotes,
          },
          emergency: { name: emergencyContact, phone: emergencyPhone },
          policyAccepted,
          acknowledgeAgeWarning: ackAgeWarning,
          notes: notes.trim() || null,
          payment,
          servedByUserId: servedById,
        });
        return res.json();
      }

      const expandedItems: BookingItem[] = [];
      for (let ci = 0; ci < validChildren.length; ci++) {
        for (const item of items) {
          expandedItems.push({ childIndex: ci, campDateId: item.campDateId, productType: item.productType });
        }
      }
      const res = await apiRequest("POST", "/api/admin/registrations/manual", {
        programId: selectedProgramId,
        parent: {
          firstName: parentFirst, lastName: parentLast, email: parentEmail,
          phone: parentPhone, emergencyContact, emergencyPhone,
        },
        children: validChildren,
        items: expandedItems,
        payment,
        servedByUserId: servedById,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/registrations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/academy"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/contacts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps/registration-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/academy/registration-counts"] });

      const paidLabel = isPaid
        ? `${OFFICE_PAYMENT_METHODS.find((m) => m.value === method)?.label ?? "Paid"} ${formatCurrency(paidCents, { fromCents: true })}`
        : "Not paid";
      toast({
        title: `Registration #${data.registrationId} created`,
        description: `${formatCurrency(data.totalCents, { fromCents: true })} — ${paidLabel} — ${data.status}`,
      });
      if (data.nzfMissing?.length) {
        toast({
          title: "NZ Football details still needed",
          description: `Missing: ${data.nzfMissing.join(", ")}. Add them on the player's contact record before the audit.`,
        });
      }
      resetForm();
      onClose();
    },
    onError: (e: any) => {
      // The server refuses an out-of-band age unless it's explicitly accepted.
      if (typeof e?.message === "string" && e.message.toLowerCase().includes("age")) {
        setAckAgeWarning(true);
      }
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    },
  });

  const resetForm = () => {
    setStep(0);
    setSelectedProgramId(null);
    setParentFirst(""); setParentLast(""); setParentEmail(""); setParentPhone("");
    setEmergencyContact(""); setEmergencyPhone("");
    setChildren([{ firstName: "", lastName: "", dateOfBirth: "", allergies: "", epiPen: false, medicalNotes: "" }]);
    setItems([]);
    setOptionId(null); setPlan("term");
    setPlayerFirst(""); setPlayerLast(""); setPlayerDob(""); setPlayerGender(""); setPlayerSchool("");
    setCountryOfBirth(""); setNationality(""); setEthnicity("");
    setAllergies(""); setMedicalNotes(""); setRelationship("parent");
    setPolicyAccepted(false); setAckAgeWarning(false);
    setIsPaid(true); setMethod("eftpos"); setAmountDollars(""); setAmountTouched(false);
    setReference(""); setNotes("");
    setServedById(me?.id ?? null);
  };

  const close = () => { resetForm(); onClose(); };

  const addChild = () => setChildren([...children, { firstName: "", lastName: "", dateOfBirth: "", allergies: "", epiPen: false, medicalNotes: "" }]);
  const removeChild = (idx: number) => { if (children.length > 1) setChildren(children.filter((_, i) => i !== idx)); };
  const updateChild = (idx: number, field: keyof ChildData, value: string | boolean) =>
    setChildren(children.map((c, i) => (i === idx ? { ...c, [field]: value } : c)));

  const toggleItem = (campDateId: number, productType: string) => {
    const exists = items.find((i) => i.campDateId === campDateId && i.productType === productType);
    if (exists) {
      setItems(items.filter((i) => !(i.campDateId === campDateId && i.productType === productType)));
    } else {
      const filtered = items.filter((i) => i.campDateId !== campDateId);
      filtered.push({ childIndex: 0, campDateId, productType });
      setItems(filtered);
    }
  };

  const stepName = STEPS[step];

  const canNextStep = () => {
    if (stepName === "Programme") {
      if (!selectedProgramId) return false;
      if (shape === "academy") return !!optionId && !!academyData?.quote;
      return true;
    }
    if (stepName === "Family") {
      return !!(parentFirst.trim() && parentLast.trim() && parentEmail.trim().includes("@") &&
        parentPhone.trim() && playerFirst.trim() && playerLast.trim() && /^\d{4}-\d{2}-\d{2}$/.test(playerDob));
    }
    if (stepName === "Parent") return !!(parentFirst.trim() && parentLast.trim() && parentPhone.trim());
    if (stepName === "Children") return validChildren.length > 0;
    if (stepName === "Sessions") return items.length > 0;
    if (stepName === "Payment") {
      if (!isPaid) return true;
      return !!method && paidCents > 0;
    }
    return true;
  };

  if (!open) return null;

  const staffName = (id: number | null) => {
    const s = (staff || []).find((x) => x.id === id);
    return s ? `${s.firstName} ${s.lastName}` : "—";
  };

  return (
    // Overlay scrolls and the card is m-auto: centred when it fits, top-anchored
    // when it doesn't. `items-center` would clip the top of a tall form off a
    // 1366×768 laptop, unreachably — which is exactly how the UP Management
    // modal broke on Dima's Windows machine.
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex p-3 sm:p-4 overflow-y-auto"
      onClick={close}
      data-testid="modal-register-player"
    >
      {/* NO overflow-hidden on this card. It would become the containing block
          for the sticky footer below, which then sticks to the bottom of the
          CARD instead of the scrollport — putting the primary action off-screen
          on any viewport shorter than the form. Corners are rounded on the
          header and footer instead, exactly as ModalShell does it. */}
      <div
        className="relative w-full max-w-2xl m-auto flex flex-col rounded-2xl border border-blue-500/[0.15]"
        style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.06) 0%, #02060E 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08] sticky top-0 z-10 rounded-t-2xl" style={{ background: "#02060E" }}>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-white/80">Register at the office</h3>
            <p className="text-[11px] text-white/35 mt-0.5">Walk-up registration — records how they paid and who served them</p>
          </div>
          <button onClick={close} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors shrink-0" data-testid="button-close-register">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-5 py-3 border-b border-blue-500/[0.06] overflow-x-auto">
          {STEPS.map((label, i) => (
            <Fragment key={label}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-white/15 shrink-0" />}
              <span className={`text-[11px] whitespace-nowrap px-2 py-1 rounded-md transition-colors ${
                i === step ? "text-white bg-blue-500/15 border border-blue-500/25"
                : i < step ? "text-white/45" : "text-white/20"
              }`}>{label}</span>
            </Fragment>
          ))}
        </div>

        <div className="px-5 py-5 space-y-4 min-w-0">
          {/* ── Programme ────────────────────────────────────────────────── */}
          {stepName === "Programme" && (
            <div className="space-y-4">
              <div className="space-y-2">
                {programmes.length === 0 && (
                  <p className="text-[12px] text-white/40">No programmes in this workspace yet.</p>
                )}
                {programmes.map((p) => (
                  <button
                    key={`${p.type}-${p.id}`}
                    onClick={() => { setSelectedProgramId(p.id); setOptionId(null); setItems([]); setAmountTouched(false); }}
                    className={`w-full text-left px-4 py-3 rounded-xl border transition-colors min-w-0 ${
                      selectedProgramId === p.id
                        ? "bg-blue-500/10 border-blue-500/30"
                        : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]"
                    }`}
                    data-testid={`option-programme-${p.id}`}
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <span className="text-[13px] text-white/85 break-words min-w-0">{p.name}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="outline" className="text-[10px] border-white/10 text-white/40">
                          {p.type === "academy" ? "Academy" : "Camp"}
                        </Badge>
                        {p.type === "academy" && p.registrationOpen === false && (
                          <Badge variant="outline" className="text-[10px] border-amber-500/25 text-amber-300/70 gap-1">
                            <Lock className="w-2.5 h-2.5" />Invite only
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {shape === "academy" && (
                <div className="space-y-3 pt-1">
                  {quoting && <p className="text-[12px] text-white/40 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Pricing…</p>}

                  {academyData?.programme.registrationOpen === false && (
                    <div className="flex gap-2 px-3 py-2.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/20">
                      <Lock className="w-3.5 h-3.5 text-amber-400/80 shrink-0 mt-0.5" />
                      <p className="text-[11.5px] text-amber-200/70 leading-snug min-w-0">
                        This programme is invite-only — it isn't sold on the website. Registering here is deliberate.
                      </p>
                    </div>
                  )}

                  {(academyData?.options.length ?? 0) > 0 && (
                    <Field label="Age group / option" required>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {academyData!.options.map((o) => (
                          <button
                            key={o.id}
                            onClick={() => { setOptionId(o.id); setAmountTouched(false); }}
                            className={`px-3 py-2.5 rounded-lg border text-left transition-colors min-w-0 ${
                              optionId === o.id ? "bg-blue-500/10 border-blue-500/30" : "bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]"
                            }`}
                            data-testid={`option-academy-${o.id}`}
                          >
                            <div className="text-[12.5px] text-white/85 break-words">{o.name}</div>
                            <div className="text-[11px] text-white/40 mt-0.5">{formatCurrency(o.fullPriceCents, { fromCents: true })} / term</div>
                          </button>
                        ))}
                      </div>
                    </Field>
                  )}

                  {academyData?.allowFullYear && (
                    <Field label="Payment plan">
                      <div className="flex gap-2">
                        {(["term", "year"] as const).map((p) => (
                          <button
                            key={p}
                            onClick={() => { setPlan(p); setAmountTouched(false); }}
                            className={`px-3 py-2 rounded-lg border text-[12px] transition-colors ${
                              plan === p ? "bg-blue-500/10 border-blue-500/30 text-white/85" : "bg-white/[0.02] border-white/[0.06] text-white/50"
                            }`}
                          >
                            {p === "term" ? "This term" : "Full year (5% off)"}
                          </button>
                        ))}
                      </div>
                    </Field>
                  )}

                  {academyData?.quote && (
                    <div className="px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-1.5">
                      {academyData.quote.discountCents > 0 && (
                        <>
                          <div className="flex justify-between text-[12px] text-white/45">
                            <span>Full {plan === "year" ? "year" : "term"}</span>
                            <span>{formatCurrency(academyData.quote.subtotalCents, { fromCents: true })}</span>
                          </div>
                          <div className="flex justify-between text-[12px] text-emerald-300/70">
                            <span className="min-w-0 break-words pr-2">{academyData.quote.reason || "Discount"}</span>
                            <span className="shrink-0">−{formatCurrency(academyData.quote.discountCents, { fromCents: true })}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-between text-[14px] font-semibold text-white/90 pt-1 border-t border-white/[0.06]">
                        <span>Owing today</span>
                        <span>{formatCurrency(academyData.quote.totalCents, { fromCents: true })}</span>
                      </div>
                      {academyData.term && (
                        <p className="text-[10.5px] text-white/30 pt-0.5">
                          {academyData.term.name} · {formatDate(academyData.term.startDate)} – {formatDate(academyData.term.endDate)}
                          {academyData.quote.sessionsRemaining != null && academyData.quote.totalSessions != null &&
                            ` · ${academyData.quote.sessionsRemaining} of ${academyData.quote.totalSessions} sessions left`}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Academy: family ──────────────────────────────────────────── */}
          {stepName === "Family" && (
            <div className="space-y-5">
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <User className="w-3.5 h-3.5 text-blue-400/70" />
                  <span className="text-[12px] font-medium text-white/70">Parent / guardian</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="First name" required>
                    <Input value={parentFirst} onChange={(e) => setParentFirst(e.target.value)} className={FIELD} data-testid="input-parent-first" />
                  </Field>
                  <Field label="Last name" required>
                    <Input value={parentLast} onChange={(e) => setParentLast(e.target.value)} className={FIELD} data-testid="input-parent-last" />
                  </Field>
                  <Field label="Email" required hint="How we match them to a family already on file — without it we create a duplicate parent.">
                    <Input type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} className={FIELD} data-testid="input-parent-email" />
                  </Field>
                  <Field label="Phone" required>
                    <Input type="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} className={FIELD} data-testid="input-parent-phone" />
                  </Field>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Baby className="w-3.5 h-3.5 text-blue-400/70" />
                  <span className="text-[12px] font-medium text-white/70">Player</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="First name" required>
                    <Input value={playerFirst} onChange={(e) => setPlayerFirst(e.target.value)} className={FIELD} data-testid="input-player-first" />
                  </Field>
                  <Field label="Last name" required>
                    <Input value={playerLast} onChange={(e) => setPlayerLast(e.target.value)} className={FIELD} data-testid="input-player-last" />
                  </Field>
                  <Field label="Date of birth" required hint="Sets their age grade (season year minus birth year).">
                    {/* fromYear/toYear switch the calendar caption to year +
                        month dropdowns. Without them the picker only has
                        month arrows, so entering a six-year-old's birthday
                        means ~70 clicks — hopeless with a parent waiting. */}
                    <DatePickerInput
                      value={playerDob}
                      onChange={(e) => setPlayerDob(e.target.value)}
                      max={nzToday}
                      fromYear={thisYear - 25}
                      toYear={thisYear}
                      placeholder="Pick the player's date of birth"
                      className={FIELD}
                      data-testid="input-player-dob"
                    />
                  </Field>
                  <Field label="Gender">
                    <select value={playerGender} onChange={(e) => setPlayerGender(e.target.value)} className={`w-full h-10 rounded-md px-3 text-sm ${FIELD} border`} data-testid="select-player-gender">
                      <option value="">—</option>
                      {GENDERS.map((g) => <option key={g} value={g} className="bg-[#02060E]">{g[0].toUpperCase() + g.slice(1)}</option>)}
                    </select>
                  </Field>
                  <Field label="School">
                    <Input value={playerSchool} onChange={(e) => setPlayerSchool(e.target.value)} className={FIELD} />
                  </Field>
                  <Field label="Emergency contact">
                    <Input value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} className={FIELD} />
                  </Field>
                  <Field label="Emergency phone">
                    <Input type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} className={FIELD} />
                  </Field>
                  <Field label="Allergies">
                    <Input value={allergies} onChange={(e) => setAllergies(e.target.value)} className={FIELD} />
                  </Field>
                </div>
                <div className="mt-3">
                  <Field label="Medical notes">
                    <Input value={medicalNotes} onChange={(e) => setMedicalNotes(e.target.value)} className={FIELD} />
                  </Field>
                </div>
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12px] font-medium text-white/70">New Zealand Football details</span>
                </div>
                <p className="text-[10.5px] text-white/30 mb-3 leading-snug">
                  Required for the annual NZF audit. You can save without them and add them later on the player's record —
                  they'll be flagged as missing rather than guessed.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Country of birth">
                    <Input value={countryOfBirth} onChange={(e) => setCountryOfBirth(e.target.value)} placeholder="New Zealand" className={FIELD} />
                  </Field>
                  <Field label="Nationality">
                    <Input value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="New Zealand" className={FIELD} />
                  </Field>
                  <Field label="Ethnic group">
                    <select value={ethnicity} onChange={(e) => setEthnicity(e.target.value)} className={`w-full h-10 rounded-md px-3 text-sm ${FIELD} border`}>
                      <option value="">—</option>
                      {NZF_ETHNICITIES.map((e2: string) => <option key={e2} value={e2} className="bg-[#02060E]">{e2}</option>)}
                    </select>
                  </Field>
                </div>
              </div>
            </div>
          )}

          {/* ── Camp: parent ─────────────────────────────────────────────── */}
          {stepName === "Parent" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="First name" required><Input value={parentFirst} onChange={(e) => setParentFirst(e.target.value)} className={FIELD} data-testid="input-parent-first" /></Field>
              <Field label="Last name" required><Input value={parentLast} onChange={(e) => setParentLast(e.target.value)} className={FIELD} data-testid="input-parent-last" /></Field>
              <Field label="Email"><Input type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} className={FIELD} data-testid="input-parent-email" /></Field>
              <Field label="Phone" required><Input type="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} className={FIELD} data-testid="input-parent-phone" /></Field>
              <Field label="Emergency contact"><Input value={emergencyContact} onChange={(e) => setEmergencyContact(e.target.value)} className={FIELD} /></Field>
              <Field label="Emergency phone"><Input type="tel" value={emergencyPhone} onChange={(e) => setEmergencyPhone(e.target.value)} className={FIELD} /></Field>
            </div>
          )}

          {/* ── Camp: children ───────────────────────────────────────────── */}
          {stepName === "Children" && (
            <div className="space-y-3">
              {children.map((c, idx) => (
                <div key={idx} className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-3 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-white/40">Child {idx + 1}</span>
                    {children.length > 1 && (
                      <button onClick={() => removeChild(idx)} className="text-white/30 hover:text-red-300"><Trash2 className="w-3.5 h-3.5" /></button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="First name" required><Input value={c.firstName} onChange={(e) => updateChild(idx, "firstName", e.target.value)} className={FIELD} /></Field>
                    <Field label="Last name"><Input value={c.lastName} onChange={(e) => updateChild(idx, "lastName", e.target.value)} className={FIELD} /></Field>
                    <Field label="Date of birth">
                      <DatePickerInput
                        value={c.dateOfBirth}
                        onChange={(e) => updateChild(idx, "dateOfBirth", e.target.value)}
                        max={nzToday}
                        fromYear={thisYear - 25}
                        toYear={thisYear}
                        className={FIELD}
                        data-testid={`input-child-dob-${idx}`}
                      />
                    </Field>
                    <Field label="Allergies"><Input value={c.allergies} onChange={(e) => updateChild(idx, "allergies", e.target.value)} className={FIELD} /></Field>
                  </div>
                  <label className="flex items-center gap-2 text-[12px] text-white/60">
                    <input type="checkbox" checked={c.epiPen} onChange={(e) => updateChild(idx, "epiPen", e.target.checked)} className="accent-blue-500" />
                    Carries an EpiPen
                  </label>
                  <Field label="Medical notes"><Input value={c.medicalNotes} onChange={(e) => updateChild(idx, "medicalNotes", e.target.value)} className={FIELD} /></Field>
                </div>
              ))}
              <Button size="sm" variant="ghost" onClick={addChild} className="text-white/60"><Plus className="w-3.5 h-3.5 mr-1" />Add another child</Button>
            </div>
          )}

          {/* ── Camp: sessions ───────────────────────────────────────────── */}
          {stepName === "Sessions" && (
            <div className="space-y-2">
              {dates.length === 0 && <p className="text-[12px] text-white/40">This camp has no dates set up yet.</p>}
              {dates.map((d: any) => (
                <div key={d.id} className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] min-w-0">
                  <div className="text-[12px] text-white/70 mb-2">{formatDate(d.date)}</div>
                  <div className="flex flex-wrap gap-2">
                    {pricing.map((p: any) => {
                      const active = items.some((i) => i.campDateId === d.id && i.productType === p.productType);
                      return (
                        <button
                          key={p.productType}
                          onClick={() => toggleItem(d.id, p.productType)}
                          className={`px-3 py-1.5 rounded-lg border text-[11.5px] transition-colors ${
                            active ? "bg-blue-500/15 border-blue-500/30 text-white/85" : "bg-white/[0.02] border-white/[0.06] text-white/45"
                          }`}
                        >
                          {formatProductType(p.productType)} · {formatCurrency(p.priceCents, { fromCents: true })}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── Payment ──────────────────────────────────────────────────── */}
          {stepName === "Payment" && (
            <div className="space-y-4">
              <div className="px-4 py-3 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-center justify-between gap-2">
                <span className="text-[12px] text-white/50">Total owing</span>
                <span className="text-[16px] font-semibold text-white/90">{formatCurrency(totalCents, { fromCents: true })}</span>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setIsPaid(true)}
                  className={`flex-1 px-3 py-2.5 rounded-lg border text-[12px] transition-colors ${isPaid ? "bg-emerald-500/10 border-emerald-500/30 text-white/85" : "bg-white/[0.02] border-white/[0.06] text-white/45"}`}
                  data-testid="button-paid-yes"
                >Paid now</button>
                <button
                  onClick={() => setIsPaid(false)}
                  className={`flex-1 px-3 py-2.5 rounded-lg border text-[12px] transition-colors ${!isPaid ? "bg-amber-500/10 border-amber-500/30 text-white/85" : "bg-white/[0.02] border-white/[0.06] text-white/45"}`}
                  data-testid="button-paid-no"
                >Not paid yet</button>
              </div>

              {isPaid ? (
                <>
                  <Field label="How did they pay?" required>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {OFFICE_PAYMENT_METHODS.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => setMethod(m.value)}
                          className={`px-2 py-2.5 rounded-lg border text-[12px] transition-colors min-w-0 break-words ${
                            method === m.value ? "bg-blue-500/10 border-blue-500/30 text-white/85" : "bg-white/[0.02] border-white/[0.06] text-white/45"
                          }`}
                          data-testid={`button-method-${m.value}`}
                        >{m.label}</button>
                      ))}
                    </div>
                  </Field>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Amount taken" required>
                      <MoneyInput
                        value={amountDollars}
                        onChange={(v) => { setAmountDollars(v); setAmountTouched(true); }}
                        className={FIELD}
                        data-testid="input-amount-paid"
                      />
                    </Field>
                    <Field label="Reference" hint="EFTPOS terminal ref, receipt number, bank particulars — whatever you'll match this against.">
                      <Input value={reference} onChange={(e) => setReference(e.target.value)} className={FIELD} data-testid="input-payment-reference" />
                    </Field>
                  </div>

                  {isShortPayment && (
                    <div className="flex gap-2 px-3 py-2.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/20">
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400/80 shrink-0 mt-0.5" />
                      <p className="text-[11.5px] text-amber-200/70 leading-snug min-w-0">
                        That's {formatCurrency(totalCents - paidCents, { fromCents: true })} short of the total. The registration
                        will be saved as <strong>pending</strong> until the balance is paid.
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[11.5px] text-white/40 leading-snug">
                  Saved as pending — no money recorded. Come back and mark it paid when they settle up.
                </p>
              )}

              <Field label="Served by" hint="Who took this registration at the counter.">
                <select
                  value={servedById ?? ""}
                  onChange={(e) => setServedById(e.target.value ? Number(e.target.value) : null)}
                  className={`w-full h-10 rounded-md px-3 text-sm ${FIELD} border`}
                  data-testid="select-served-by"
                >
                  <option value="">— not recorded —</option>
                  {(staff || []).map((s) => (
                    <option key={s.id} value={s.id} className="bg-[#02060E]">{s.firstName} {s.lastName}</option>
                  ))}
                </select>
              </Field>

              <Field label="Notes">
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering about this one" className={FIELD} />
              </Field>

              {shape === "academy" && (
                <label className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06] cursor-pointer">
                  <input type="checkbox" checked={policyAccepted} onChange={(e) => setPolicyAccepted(e.target.checked)} className="accent-blue-500 mt-0.5" data-testid="checkbox-policy" />
                  <span className="text-[11.5px] text-white/55 leading-snug min-w-0">
                    The parent confirmed they accept the academy policy and NZF registration terms.
                    Leave unticked if they haven't — it's recorded as evidence, so it must be true.
                  </span>
                </label>
              )}
            </div>
          )}

          {/* ── Confirm ──────────────────────────────────────────────────── */}
          {stepName === "Confirm" && (
            <div className="space-y-3">
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.02] border border-white/[0.06] space-y-2.5 min-w-0">
                <Row label="Programme" value={programme?.name ?? "—"} />
                {shape === "academy" && (
                  <>
                    <Row label="Option" value={academyData?.options.find((o) => o.id === optionId)?.name ?? "—"} />
                    <Row label="Player" value={`${playerFirst} ${playerLast}`.trim() || "—"} />
                    <Row label="Parent" value={`${parentFirst} ${parentLast}`.trim() || "—"} />
                  </>
                )}
                {shape === "camp" && (
                  <>
                    <Row label="Parent" value={`${parentFirst} ${parentLast}`.trim() || "—"} />
                    <Row label="Children" value={validChildren.map((c) => c.firstName).join(", ") || "—"} />
                    <Row label="Sessions" value={`${items.length} per child`} />
                  </>
                )}
                <div className="pt-2 border-t border-white/[0.06] space-y-2.5">
                  <Row label="Total" value={formatCurrency(totalCents, { fromCents: true })} strong />
                  <Row
                    label="Payment"
                    value={isPaid
                      ? `${OFFICE_PAYMENT_METHODS.find((m) => m.value === method)?.label} — ${formatCurrency(paidCents, { fromCents: true })}`
                      : "Not paid yet"}
                  />
                  {reference && <Row label="Reference" value={reference} />}
                  <Row label="Served by" value={staffName(servedById)} />
                  <Row
                    label="Status"
                    value={isPaid && paidCents >= totalCents && totalCents > 0 ? "Confirmed" : "Pending"}
                  />
                </div>
              </div>

              {ackAgeWarning && (
                <div className="flex gap-2 px-3 py-2.5 rounded-lg bg-amber-500/[0.07] border border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400/80 shrink-0 mt-0.5" />
                  <p className="text-[11.5px] text-amber-200/70 leading-snug min-w-0">
                    This player's age sits outside the programme's advertised band. Saving again will register them anyway.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Sticky so Save is always reachable on a short laptop screen. */}
        <div className="px-5 py-4 border-t border-blue-500/[0.08] flex items-center justify-between gap-2 sticky bottom-0 z-10 rounded-b-2xl" style={{ background: "#02060E" }}>
          <Button
            size="sm" variant="ghost"
            onClick={() => (step === 0 ? close() : setStep(step - 1))}
            className="text-white/50"
            data-testid="button-back"
          >
            {step === 0 ? "Cancel" : <><ChevronLeft className="w-3.5 h-3.5 mr-1" />Back</>}
          </Button>

          {step < STEPS.length - 1 ? (
            <Button size="sm" onClick={() => setStep(step + 1)} disabled={!canNextStep()} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-next">
              Next<ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => registerMutation.mutate()}
              disabled={registerMutation.isPending || totalCents <= 0}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="button-submit-registration"
            >
              {registerMutation.isPending
                ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Saving…</>
                : <><CheckCircle className="w-3.5 h-3.5 mr-1" />Create registration</>}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 min-w-0">
      <span className="text-[11.5px] text-white/40 shrink-0">{label}</span>
      <span className={`text-[12.5px] text-right break-words min-w-0 ${strong ? "font-semibold text-white/90" : "text-white/75"}`}>{value}</span>
    </div>
  );
}

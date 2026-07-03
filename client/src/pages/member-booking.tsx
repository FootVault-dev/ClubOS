// Member booking requests — book.unitedsportscentre.com/members
//
// Club-members-only landing page. Same facility/date/time selection UX as the
// public paid flow (venue-book.tsx) but with NO payment, NO add-ons (no
// lights / changing rooms) and a mandatory Facility Use Terms & Liability
// Waiver tick. Submitting creates a booking REQUEST that an admin approves or
// declines in the USC workspace "Booking Requests" tab — confirmation arrives
// by email once approved.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Label } from "@/components/ui/label";
import {
  Calendar as CalendarIcon, MapPin, CheckCircle2, Loader2,
  ChevronLeft, ChevronRight, Shield, ScrollText, Send, Clock,
} from "lucide-react";
import { FacilityCarousel } from "@/components/FacilityCarousel";
import HdyhauCard from "@/components/hdyhau-card";
import { cellsOverlap, QUARTER_POSITIONS, type FieldSize } from "@shared/field-cells";
import { USC_WAIVER_SECTIONS, USC_WAIVER_VERSION } from "@shared/usc-waiver";

type FacilityType = "field" | "mini_pitch" | "meeting_room" | "changing_room" | "futsal" | "court" | "other";

interface PublicFacility {
  id: number;
  organizationId: number;
  name: string;
  type: FacilityType;
  description: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  halfFull: boolean | null;
  quarterField: boolean | null;
}

interface VenueSettings {
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  minDurationMinutes: number;
  advanceBookingDays: number;
  brandColor: string | null;
  siteTitle: string;
  contactPhone: string | null;
}

interface ResolveResp {
  organization: { id: number; name: string; slug: string; logoUrl: string | null };
  settings: VenueSettings;
}

interface AvailabilitySlot {
  date: string;
  startTime: string;
  endTime: string;
  halfFull: string | null;
  halfPosition: string | null;
  status: string;
}

const FACILITY_TYPE_LABELS: Record<FacilityType, string> = {
  field: "Field", mini_pitch: "Mini Pitch", meeting_room: "Meeting Room",
  changing_room: "Changing Room", futsal: "Futsal", court: "Court", other: "Other",
};

function facilityImages(f: { imageUrls: string[] | null; imageUrl: string | null }): string[] {
  const arr = (f.imageUrls || []).filter(Boolean);
  if (arr.length > 0) return arr;
  return f.imageUrl ? [f.imageUrl] : [];
}

function getOrgSlug(): string | undefined {
  const url = new URL(window.location.href);
  const slug = url.searchParams.get("slug");
  if (slug) return slug;
  const host = window.location.hostname;
  if (host === "localhost" || host.endsWith(".replit.dev") || host.endsWith(".repl.co") || host.endsWith(".replit.app")) {
    return "united-sports-centre";
  }
  return undefined;
}

function fmtDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function fmtTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// NZ wall-clock "now" — same logic as venue-book.tsx so "today" can't drift
// for visitors in other timezones.
function nzNow(): { today: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour");
  return { today: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${hh}:${get("minute")}` };
}

function todayISO() {
  return nzNow().today;
}

function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function genTimeSlots(opening: string, closing: string, slotMin: number): string[] {
  const [oh, om] = opening.split(":").map(Number);
  const [ch, cm] = closing.split(":").map(Number);
  const start = oh * 60 + om;
  const end = ch * 60 + cm;
  const out: string[] = [];
  for (let t = start; t <= end; t += slotMin) {
    const h = Math.floor(t / 60), m = t % 60;
    out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return out;
}

function fieldSizeLabel(halfFull: string | null | undefined, halfPosition: string | null | undefined): string {
  if (halfFull === "half") return halfPosition ? `${halfPosition} half` : "half";
  if (halfFull === "quarter") return halfPosition ? `quarter ${halfPosition.toUpperCase()}` : "quarter";
  return "full field";
}

// ============ PAGE SHELL ============
export default function MemberBookingPage() {
  const slug = getOrgSlug();
  const [resolved, setResolved] = useState<ResolveResp | null>(null);
  const [loadingResolve, setLoadingResolve] = useState(true);
  const [errResolve, setErrResolve] = useState<string | null>(null);

  // Hardcoded dark, same as the public booking flow (see venue-book.tsx).
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    const prevColorScheme = root.style.colorScheme;
    const prevDataTheme = root.getAttribute("data-theme");
    root.classList.add("dark");
    root.style.colorScheme = "dark";
    root.setAttribute("data-theme", "dark");
    return () => {
      if (!hadDark) root.classList.remove("dark");
      root.style.colorScheme = prevColorScheme;
      if (prevDataTheme) root.setAttribute("data-theme", prevDataTheme);
      else root.removeAttribute("data-theme");
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const url = slug ? `/api/public/venue/resolve?slug=${encodeURIComponent(slug)}` : `/api/public/venue/resolve`;
        const r = await fetch(url);
        if (!r.ok) throw new Error((await r.json()).message || "Venue not found");
        setResolved(await r.json());
      } catch (e: any) {
        setErrResolve(e.message);
      } finally {
        setLoadingResolve(false);
      }
    })();
  }, [slug]);

  if (loadingResolve) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-white/60" />
          <p className="text-white/60 text-sm">Loading member booking…</p>
        </div>
      </div>
    );
  }
  if (errResolve || !resolved) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] text-white flex items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-semibold mb-2">Venue not found</h1>
          <p className="text-white/60 text-sm">{errResolve || "We couldn't find this booking site."}</p>
        </div>
      </div>
    );
  }
  return <MemberRequestFlow resolved={resolved} />;
}

// ============ REQUEST FLOW ============
function MemberRequestFlow({ resolved }: { resolved: ResolveResp }) {
  const { organization, settings } = resolved;
  const brand = settings.brandColor || "#6366f1";

  const [facilities, setFacilities] = useState<PublicFacility[] | null>(null);
  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/public/venue/${organization.id}/facilities`);
      if (r.ok) {
        const all: PublicFacility[] = await r.json();
        // Member requests are for playing spaces only — no changing rooms or
        // meeting rooms, and no add-ons (lights etc.) anywhere in this flow.
        setFacilities(all.filter(f => f.type !== "changing_room" && f.type !== "meeting_room"));
      }
    })();
  }, [organization.id]);

  // Member details
  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  // Selection
  const [facility, setFacility] = useState<PublicFacility | null>(null);
  const [date, setDate] = useState(todayISO());
  const [startTime, setStartTime] = useState<string | null>(null);
  const [endTime, setEndTime] = useState<string | null>(null);
  const [halfFull, setHalfFull] = useState<FieldSize>("full");
  const [halfPosition, setHalfPosition] = useState<"front" | "back">("front");
  const [quarterPos, setQuarterPos] = useState<"q1" | "q2" | "q3" | "q4">("q1");
  const [busy, setBusy] = useState<AvailabilitySlot[]>([]);

  // Waiver + submission
  const [waiverAgreed, setWaiverAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<number | null>(null);

  const slots = useMemo(
    () => genTimeSlots(settings.openingTime, settings.closingTime, settings.slotMinutes),
    [settings.openingTime, settings.closingTime, settings.slotMinutes],
  );

  // Availability for the chosen facility + date
  useEffect(() => {
    if (!facility) { setBusy([]); return; }
    (async () => {
      const r = await fetch(`/api/public/venue/${organization.id}/availability?facilityId=${facility.id}&dates=${date}`);
      if (r.ok) setBusy(await r.json());
    })();
  }, [facility?.id, organization.id, date]);

  const supportsSizes = !!(facility && (facility.halfFull || facility.quarterField));
  const effectiveSize: FieldSize = supportsSizes ? halfFull : "full";
  const wantPos = effectiveSize === "half" ? halfPosition : effectiveSize === "quarter" ? quarterPos : null;

  const isSlotConflicted = (s: string, e: string) =>
    busy.some(b =>
      b.date === date &&
      b.startTime < e &&
      b.endTime > s &&
      cellsOverlap(b.halfFull, b.halfPosition, effectiveSize, wantPos)
    );

  const { today: nzToday, hhmm: nzHHMM } = nzNow();
  const isPastSlot = (slot: string) => date === nzToday && slot <= nzHHMM;

  const handleSlotClick = (slot: string) => {
    if (slot === startTime && !endTime) { setStartTime(null); return; }
    if (!startTime) { setStartTime(slot); setEndTime(null); return; }
    if (!endTime) {
      if (slot > startTime) setEndTime(slot);
      else setStartTime(slot);
      return;
    }
    setStartTime(slot);
    setEndTime(null);
  };

  const durationMinutes = useMemo(() => {
    if (!startTime || !endTime) return 0;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    return (eh * 60 + em) - (sh * 60 + sm);
  }, [startTime, endTime]);

  const slotConflicted = !!(startTime && endTime && isSlotConflicted(startTime, endTime));

  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const detailsValid = fullName.trim().length >= 2 && !!dateOfBirth && dateOfBirth < todayISO() && emailValid && phone.trim().length >= 5;
  const selectionValid = !!facility && !!startTime && !!endTime
    && durationMinutes >= settings.minDurationMinutes && !slotConflicted;
  const canSubmit = detailsValid && selectionValid && waiverAgreed && !submitting;

  const submit = async () => {
    if (!facility || !startTime || !endTime) return;
    setSubmitting(true);
    setSubmitErr(null);
    try {
      const r = await fetch(`/api/public/venue/${organization.id}/booking-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          dateOfBirth,
          email: email.trim(),
          phone: phone.trim(),
          facilityId: facility.id,
          date,
          startTime,
          endTime,
          halfFull: supportsSizes ? effectiveSize : null,
          halfPosition: effectiveSize === "half" ? halfPosition : effectiveSize === "quarter" ? quarterPos : null,
          waiverAccepted: true,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message || "Request failed");
      setSubmittedId(data.id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setSubmitErr(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (submittedId != null && facility && startTime && endTime) {
    return (
      <Shell organization={organization} settings={settings} brand={brand}>
        <div className="max-w-xl mx-auto text-center py-12 animate-in fade-in duration-300" data-testid="request-success">
          <div className="w-16 h-16 rounded-full mx-auto mb-5 flex items-center justify-center" style={{ background: `${brand}25`, color: brand }}>
            <CheckCircle2 className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-semibold mb-2">Request received</h2>
          <p className="text-white/60 text-sm leading-relaxed mb-6">
            Thanks {fullName.split(" ")[0]} — your booking request is with our team for approval.
            You'll get a confirmation email at <span className="text-white">{email}</span> once it's approved.
          </p>
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5 text-left text-sm space-y-2 mb-8">
            <SummaryRow label="Reference" value={`MBR-${submittedId}`} brand={brand} />
            <SummaryRow label="Facility" value={`${facility.name}${supportsSizes && effectiveSize !== "full" ? ` (${fieldSizeLabel(effectiveSize, wantPos)})` : ""}`} brand={brand} />
            <SummaryRow label="Date" value={fmtDateLong(date)} brand={brand} />
            <SummaryRow label="Time" value={`${fmtTime(startTime)} – ${fmtTime(endTime)}`} brand={brand} />
          </div>
          <div className="mb-8 text-left">
            <HdyhauCard type="booking_request" id={submittedId} variant="dark" accent={brand} />
          </div>
          <Button
            onClick={() => window.location.reload()}
            variant="outline"
            className="border-white/15 text-white/80"
            data-testid="button-new-request"
          >
            Make another request
          </Button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell organization={organization} settings={settings} brand={brand}>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-6">
          {/* Intro */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <p className="text-sm text-white/70 leading-relaxed">
              This page is for <span className="text-white font-medium">current club members</span> to
              request a facility booking at the United Sports Centre. Submit your details and preferred
              slot — our team will review your request and email you a confirmation once it's approved.
            </p>
          </div>

          {/* 1 — Your details */}
          <section>
            <SectionHeading n={1} brand={brand}>Your details</SectionHeading>
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-white/60 mb-1.5 block">Full name *</Label>
                  <Input value={fullName} onChange={e => setFullName(e.target.value)} data-testid="input-member-name" className="bg-white/[0.04] border-white/10 text-white" />
                </div>
                <div>
                  <Label className="text-xs text-white/60 mb-1.5 block">Date of birth *</Label>
                  <DatePickerInput
                    value={dateOfBirth}
                    onChange={e => setDateOfBirth(e.target.value)}
                    max={todayISO()}
                    fromYear={1930}
                    toYear={new Date().getFullYear()}
                    placeholder="Select your date of birth"
                    data-testid="input-member-dob"
                    className="bg-white/[0.04] border-white/10 text-white"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-white/60 mb-1.5 block">Email *</Label>
                  <Input type="email" value={email} onChange={e => setEmail(e.target.value)} data-testid="input-member-email" className="bg-white/[0.04] border-white/10 text-white" />
                </div>
                <div>
                  <Label className="text-xs text-white/60 mb-1.5 block">Phone *</Label>
                  <Input type="tel" value={phone} onChange={e => setPhone(e.target.value)} data-testid="input-member-phone" className="bg-white/[0.04] border-white/10 text-white" />
                </div>
              </div>
            </div>
          </section>

          {/* 2 — Facility */}
          <section>
            <SectionHeading n={2} brand={brand}>Choose a facility</SectionHeading>
            {!facilities ? (
              <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-10 text-center text-white/40 text-sm">Loading facilities…</div>
            ) : facilities.length === 0 ? (
              <div className="rounded-2xl border border-white/[0.06] p-10 text-center text-white/50 text-sm">No facilities available right now.</div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {facilities.map(f => {
                  const selected = facility?.id === f.id;
                  const imgs = facilityImages(f);
                  return (
                    <div
                      key={f.id}
                      onClick={() => {
                        setFacility(selected ? null : f);
                        setStartTime(null); setEndTime(null);
                        setHalfFull(f.halfFull ? "half" : "full");
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFacility(selected ? null : f); } }}
                      data-testid={`button-member-facility-${f.id}`}
                      className="group cursor-pointer rounded-2xl border overflow-hidden transition-all duration-200 ease-out hover:bg-white/[0.04]"
                      style={{
                        borderColor: selected ? brand : "rgba(255,255,255,0.08)",
                        background: selected ? `${brand}10` : "rgba(255,255,255,0.02)",
                      }}
                    >
                      {imgs.length > 0 && (
                        <FacilityCarousel images={imgs} alt={f.name} brand={brand} testIdPrefix={`member-facility-${f.id}`} className="w-full" />
                      )}
                      <div className="flex items-center gap-3 p-4">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
                          style={{
                            background: selected ? `${brand}30` : "rgba(255,255,255,0.04)",
                            color: selected ? brand : "rgba(255,255,255,0.5)",
                          }}
                        >
                          <Shield className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">{f.name}</div>
                          <div className="text-[11px] text-white/40 mt-0.5 truncate">
                            {f.halfFull ? "Full, half or quarter field" : FACILITY_TYPE_LABELS[f.type]}
                          </div>
                        </div>
                        <div
                          className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 transition-all duration-200"
                          style={{
                            background: selected ? brand : "rgba(255,255,255,0.06)",
                            color: selected ? "white" : "transparent",
                          }}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 3 — Date & time */}
          {facility && (
            <section className="animate-in fade-in slide-in-from-top-2 duration-200">
              <SectionHeading n={3} brand={brand}>Pick a date &amp; time</SectionHeading>
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  <div>
                    <Label className="text-xs text-white/60 mb-2 block">Date</Label>
                    <CalendarGrid
                      date={date}
                      setDate={(d) => { setDate(d); setStartTime(null); setEndTime(null); }}
                      min={todayISO()}
                      max={addDays(todayISO(), settings.advanceBookingDays)}
                      brand={brand}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-xs text-white/60">Time</Label>
                      <span className="text-[10px] text-white/40">
                        {!startTime ? "Tap your start time" : !endTime ? "Tap your end time" : "Time selected"}
                      </span>
                    </div>
                    <TimeGrid
                      slots={slots}
                      startTime={startTime}
                      endTime={endTime}
                      onSelect={handleSlotClick}
                      isBusy={(s, e) => isSlotConflicted(s, e)}
                      isPast={isPastSlot}
                      brand={brand}
                    />
                    {startTime && endTime && (
                      <div className="mt-3 flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 animate-in fade-in slide-in-from-bottom-2 duration-200">
                        <Clock className="w-4 h-4 text-white/30 flex-shrink-0" />
                        <div className="text-sm font-semibold">{fmtTime(startTime)} – {fmtTime(endTime)}</div>
                        <div className="text-[11px] text-white/40 ml-auto">
                          {durationMinutes >= 60 ? `${durationMinutes / 60}hr` : `${durationMinutes}m`}
                        </div>
                      </div>
                    )}
                    {startTime && endTime && durationMinutes < settings.minDurationMinutes && (
                      <div className="mt-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs p-2.5">
                        Minimum booking is {settings.minDurationMinutes} minutes.
                      </div>
                    )}
                    {slotConflicted && (
                      <div className="mt-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs p-2.5">
                        That time overlaps an existing booking — try another slot or a different part of the field.
                      </div>
                    )}
                  </div>
                </div>

                {supportsSizes && (
                  <div className="mt-5">
                    <Label className="text-xs text-white/60 mb-1.5 block">Field size</Label>
                    <div className="flex gap-2">
                      {(["full", "half", "quarter"] as FieldSize[])
                        .filter(opt => opt === "full" || (opt === "half" && facility.halfFull) || (opt === "quarter" && facility.quarterField))
                        .map(opt => (
                          <button
                            key={opt}
                            onClick={() => setHalfFull(opt)}
                            data-testid={`button-member-size-${opt}`}
                            className="flex-1 px-3 py-2 rounded-lg text-sm border transition capitalize"
                            style={{
                              borderColor: halfFull === opt ? brand : "rgba(255,255,255,0.1)",
                              background: halfFull === opt ? `${brand}25` : "transparent",
                              color: halfFull === opt ? "white" : "rgba(255,255,255,0.7)",
                            }}
                          >
                            {opt} field
                          </button>
                        ))}
                    </div>
                    {halfFull === "half" && (
                      <div className="mt-3">
                        <Label className="text-xs text-white/60 mb-1.5 block">Which half?</Label>
                        <div className="flex gap-2">
                          {(["front", "back"] as const).map(pos => (
                            <button
                              key={pos}
                              onClick={() => setHalfPosition(pos)}
                              data-testid={`button-member-half-${pos}`}
                              className="flex-1 px-3 py-2 rounded-lg text-sm border transition capitalize"
                              style={{
                                borderColor: halfPosition === pos ? brand : "rgba(255,255,255,0.1)",
                                background: halfPosition === pos ? `${brand}25` : "transparent",
                                color: halfPosition === pos ? "white" : "rgba(255,255,255,0.7)",
                              }}
                            >
                              {pos} half
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {halfFull === "quarter" && (
                      <div className="mt-3">
                        <Label className="text-xs text-white/60 mb-1.5 block">Which quarter?</Label>
                        <div className="grid grid-cols-2 gap-2">
                          {QUARTER_POSITIONS.map(q => (
                            <button
                              key={q.value}
                              onClick={() => setQuarterPos(q.value)}
                              data-testid={`button-member-quarter-${q.value}`}
                              className="px-3 py-2 rounded-lg text-sm border transition"
                              style={{
                                borderColor: quarterPos === q.value ? brand : "rgba(255,255,255,0.1)",
                                background: quarterPos === q.value ? `${brand}25` : "transparent",
                                color: quarterPos === q.value ? "white" : "rgba(255,255,255,0.7)",
                              }}
                            >
                              {q.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* 4 — Waiver */}
          <section>
            <SectionHeading n={facility ? 4 : 3} brand={brand}>Terms &amp; liability waiver</SectionHeading>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <ScrollText className="w-4 h-4 text-white/40" />
                <div className="text-sm font-semibold">Facility Use Terms &amp; Liability Waiver</div>
                <div className="text-[10px] text-white/30 ml-auto">v{USC_WAIVER_VERSION}</div>
              </div>
              <div className="max-h-64 overflow-y-auto px-5 py-4 space-y-4" data-testid="waiver-scrollbox">
                {USC_WAIVER_SECTIONS.map(s => (
                  <div key={s.title}>
                    <div className="text-xs font-semibold text-white/80 mb-1">{s.title}</div>
                    <p className="text-xs text-white/50 leading-relaxed">{s.body}</p>
                  </div>
                ))}
              </div>
              <label
                className="flex items-start gap-3 px-5 py-4 border-t border-white/[0.06] cursor-pointer transition"
                style={{ background: waiverAgreed ? `${brand}10` : "rgba(255,255,255,0.02)" }}
              >
                <input
                  type="checkbox"
                  checked={waiverAgreed}
                  onChange={e => setWaiverAgreed(e.target.checked)}
                  data-testid="checkbox-waiver"
                  className="mt-0.5 w-4 h-4 accent-[#6366f1] flex-shrink-0"
                />
                <span className="text-xs text-white/70 leading-relaxed">
                  I confirm I am a current club member, I have read and agree to the
                  <span className="text-white font-medium"> Facility Use Terms &amp; Liability Waiver</span> above
                  on behalf of myself and my group, and I accept full liability for any damage and responsibility
                  for any injury as set out in those terms.
                </span>
              </label>
            </div>
          </section>

          {submitErr && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3" data-testid="text-submit-error">{submitErr}</div>
          )}

          <Button
            onClick={submit}
            disabled={!canSubmit}
            data-testid="button-submit-request"
            className="w-full h-12 text-white border-0 text-sm font-semibold transition-all duration-200 disabled:opacity-30"
            style={{ background: brand }}
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending request…</>
              : <><Send className="w-4 h-4 mr-2" /> Submit booking request</>}
          </Button>
          <p className="text-[11px] text-white/35 text-center -mt-2 pb-4">
            Your request isn't a confirmed booking — we'll email you once it's approved.
          </p>
        </div>

        {/* Summary sidebar */}
        <aside className="order-first lg:order-last">
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 sticky top-[88px]">
            <h3 className="font-semibold flex items-center gap-2 mb-3"><CalendarIcon className="w-4 h-4" /> Your request</h3>
            <div className="space-y-2 text-xs">
              <SummaryRow label="Member" value={fullName.trim() || "—"} brand={brand} />
              <SummaryRow label="Facility" value={facility ? facility.name : "—"} brand={brand} />
              {facility && supportsSizes && (
                <SummaryRow label="Size" value={fieldSizeLabel(effectiveSize, wantPos)} brand={brand} />
              )}
              <SummaryRow label="Date" value={facility ? fmtDateLong(date) : "—"} brand={brand} />
              <SummaryRow label="Time" value={startTime && endTime ? `${fmtTime(startTime)} – ${fmtTime(endTime)}` : "—"} brand={brand} />
              <SummaryRow label="Waiver" value={waiverAgreed ? "Agreed" : "Not yet agreed"} brand={brand} highlight={waiverAgreed} />
            </div>
            <div className="border-t border-white/[0.06] mt-3 pt-3 text-[11px] text-white/40 leading-relaxed">
              Members only · No payment taken · Approval by the USC team, confirmation by email.
            </div>
          </div>
        </aside>
      </div>
    </Shell>
  );
}

// ============ UI bits ============
function Shell({ organization, settings, brand, children }: {
  organization: { name: string; logoUrl: string | null };
  settings: VenueSettings;
  brand: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen text-white" style={{ background: "linear-gradient(180deg, #0a0e1a 0%, #050810 100%)" }}>
      <header className="border-b border-white/[0.06] backdrop-blur-xl sticky top-0 z-30" style={{ background: "rgba(10,14,26,0.85)" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          {organization.logoUrl ? (
            <img src={organization.logoUrl} alt={organization.name} className="h-8 w-auto" />
          ) : (
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: brand }}>
              <MapPin className="w-4 h-4 text-white" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" data-testid="text-member-site-title">Member Booking</div>
            <div className="text-[11px] text-white/40 truncate">{organization.name}</div>
          </div>
          <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded-full" style={{ background: `${brand}20`, color: brand }}>
            <Shield className="w-3 h-3" /> Members only
          </span>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</main>
      <footer className="border-t border-white/[0.06] mt-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 text-xs text-white/40">
          United Sports Centre · Operated by Christchurch United Football Club · info@cufc.co.nz
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({ n, brand, children }: { n: number; brand: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 mb-3">
      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold text-white" style={{ background: brand }}>{n}</div>
      <h2 className="text-base font-semibold">{children}</h2>
    </div>
  );
}

function SummaryRow({ label, value, brand, highlight }: { label: string; value: string; brand: string; highlight?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className="text-right font-medium" style={{ color: highlight ? brand : "rgba(255,255,255,0.9)" }}>{value}</span>
    </div>
  );
}

// Compact month calendar — single-date selection (no multi-day for member requests).
function CalendarGrid({ date, setDate, min, max, brand }: {
  date: string;
  setDate: (d: string) => void;
  min: string;
  max: string;
  brand: string;
}) {
  const current = new Date(date + "T00:00:00");
  const [viewMonth, setViewMonth] = useState({ year: current.getFullYear(), month: current.getMonth() });
  const first = new Date(viewMonth.year, viewMonth.month, 1);
  const startWeekday = (first.getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(viewMonth.year, viewMonth.month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewMonth.year, viewMonth.month, d));

  const monthLabel = first.toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = todayISO();

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="member-calendar">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setViewMonth(v => v.month === 0 ? { year: v.year - 1, month: 11 } : { year: v.year, month: v.month - 1 })}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          data-testid="button-member-prev-month"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-medium">{monthLabel}</div>
        <button
          onClick={() => setViewMonth(v => v.month === 11 ? { year: v.year + 1, month: 0 } : { year: v.year, month: v.month + 1 })}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/[0.06] transition"
          data-testid="button-member-next-month"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
          <div key={d} className="text-[10px] text-white/30 text-center py-1 uppercase tracking-wider">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          if (!d) return <div key={`p${i}`} />;
          const dStr = ymd(d);
          const selected = dStr === date;
          const isToday = dStr === todayStr;
          const disabled = dStr < min || dStr > max;
          return (
            <button
              key={dStr}
              disabled={disabled}
              onClick={() => setDate(dStr)}
              data-testid={`member-day-${dStr}`}
              className={`aspect-square rounded-full text-xs font-medium transition-all duration-150 border ${
                disabled
                  ? "text-white/15 cursor-not-allowed border-transparent"
                  : selected
                    ? "text-white border-transparent"
                    : isToday
                      ? "text-blue-300 border-transparent hover:bg-blue-500/[0.08]"
                      : "text-white/70 border-transparent hover:bg-white/[0.06]"
              }`}
              style={selected ? { borderColor: brand, background: `${brand}25` } : undefined}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// Time slot grid — tap start, tap end. Busy/past slots dimmed. No pricing for
// member requests.
function TimeGrid({ slots, startTime, endTime, onSelect, isBusy, isPast, brand }: {
  slots: string[];
  startTime: string | null;
  endTime: string | null;
  onSelect: (slot: string) => void;
  isBusy: (s: string, e: string) => boolean;
  isPast: (slot: string) => boolean;
  brand: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3" data-testid="member-time-grid">
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-1 max-h-[300px] overflow-y-auto">
        {slots.map((s, i) => {
          const next = slots[i + 1] || s;
          const slotBusy = isBusy(s, next);
          const slotPast = isPast(s);
          const isStart = s === startTime;
          const inBooking = !!(startTime && (
            (endTime && s >= startTime && s < endTime) ||
            (!endTime && isStart)
          ));
          const isEndMarker = s === endTime;
          const unavailable = (slotBusy || slotPast) && !inBooking && !isEndMarker;
          return (
            <button
              key={s}
              onClick={() => onSelect(s)}
              disabled={unavailable}
              data-testid={`member-slot-${s}`}
              title={slotPast && !slotBusy ? "This time has already passed" : undefined}
              className={`h-10 rounded-md text-xs font-medium transition-all duration-150 border flex items-center justify-center ${
                unavailable
                  ? slotPast && !slotBusy
                    ? "text-white/15 cursor-not-allowed border-transparent bg-white/[0.02]"
                    : "text-white/15 line-through cursor-not-allowed border-transparent bg-white/[0.02]"
                  : inBooking || isEndMarker
                    ? "text-white border-transparent"
                    : "text-white/70 border-white/[0.08] bg-transparent hover:bg-white/[0.05] hover:border-white/15 hover:text-white"
              }`}
              style={
                inBooking || isEndMarker
                  ? {
                      borderColor: brand,
                      background: isStart || isEndMarker ? `${brand}30` : `${brand}15`,
                    }
                  : undefined
              }
            >
              {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}

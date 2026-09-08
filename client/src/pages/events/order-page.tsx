/**
 * Club Events — the buyer's booking page (join.cufc.co.nz/events/{slug}/order/{token}).
 *
 * Linked from the ticket email. Shows the booking, and until the event starts
 * lets the buyer fill in guest names, dietary requirements and the table they
 * want to sit at. Authenticated by the 128-bit token in the URL and nothing else.
 */
import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import { clubEventBrand, dollars, nzLongDate, nzClock } from "@shared/club-events";
import { TeampayShell, Card, Button, Field, inputStyle, Notice, Loading, NotFoundPage } from "../teampay/shell";

const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.message || "Something went wrong.");
  return body;
};

type Guest = { seatNo: number; fullName: string; dietary: string };

export default function ClubEventOrderPage() {
  const [, params] = useRoute("/events/:slug/order/:token");
  const token = params?.token || "";
  const { data, isLoading, isError, refetch } = useQuery<any>({
    queryKey: ["club-event-order", token],
    queryFn: () => api(`/api/public/club-events/order/${token}`),
    enabled: !!token,
    retry: false,
  });
  const brand = useMemo(() => clubEventBrand(data?.event?.brand), [data?.event?.brand]);

  const [guests, setGuests] = useState<Guest[]>([]);
  const [tableName, setTableName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setGuests((data.guests || []).map((g: any) => ({ seatNo: g.seatNo, fullName: g.fullName || "", dietary: g.dietary || "" })));
    setTableName(data.order?.tableName || "");
  }, [data]);
  useEffect(() => {
    const id = "club-events-fonts";
    if (document.getElementById(id)) return;
    const l = document.createElement("link");
    l.id = id; l.rel = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap";
    document.head.appendChild(l);
  }, []);

  if (isLoading) return <TeampayShell brand={brand}><Loading brand={brand} /></TeampayShell>;
  if (isError || !data) return <NotFoundPage brand={brand} />;

  const { order, event: ev, editable } = data;

  const save = async () => {
    setBusy(true); setError(null); setSaved(false);
    try {
      await api(`/api/public/club-events/order/${token}`, { method: "PATCH", body: JSON.stringify({ tableName, guests }) });
      setSaved(true);
      refetch();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const resend = async () => {
    setBusy(true); setError(null);
    try { await api(`/api/public/club-events/order/${token}/resend`, { method: "POST" }); setResent(true); }
    catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  return (
    <TeampayShell brand={brand} eyebrow={ev.name} title="Your booking">
      <Card brand={brand} className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase" style={{ color: brand.mute, letterSpacing: "0.14em" }}>Ticket number</div>
            <div className="mt-1 text-[26px] font-bold" style={{ color: brand.accent, fontFamily: brand.fontHeading, letterSpacing: "0.04em" }}>{order.ref}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase" style={{ color: brand.mute, letterSpacing: "0.14em" }}>{order.status === "paid" ? "Paid" : order.status}</div>
            <div className="mt-1 text-[20px] font-bold" style={{ fontFamily: brand.fontHeading }}>{dollars(order.paidCents ?? order.totalCents)}</div>
          </div>
        </div>
        <dl className="mt-5 grid gap-3 text-[14px] sm:grid-cols-2">
          <div><dt style={{ color: brand.mute }}>When</dt><dd>{nzLongDate(ev.startsAt)}, {nzClock(ev.startsAt)}{ev.endsAt ? ` to ${nzClock(ev.endsAt)}` : ""}</dd></div>
          <div><dt style={{ color: brand.mute }}>Where</dt><dd>{ev.venueName}{ev.venueAddress ? `, ${ev.venueAddress}` : ""}</dd></div>
          <div><dt style={{ color: brand.mute }}>Tickets</dt><dd>{order.quantity} × {dollars(order.unitPriceCents)}</dd></div>
          <div><dt style={{ color: brand.mute }}>Booked by</dt><dd>{order.buyerName}<br /><span style={{ color: brand.mute }}>{order.buyerEmail}</span></dd></div>
        </dl>
        {order.status === "paid" && (
          <p className="mt-4 text-[13px] leading-relaxed" style={{ color: brand.mute }}>
            Your confirmation email is your ticket. Show it on your phone at the door, or give your name.
            {ev.ageRestriction ? ` This event is ${ev.ageRestriction}.` : ""}
          </p>
        )}
      </Card>

      {order.status === "paid" && (
        <Card brand={brand} className="mt-5 p-5 sm:p-6">
          <h2 className="text-[13px] font-semibold uppercase" style={{ color: brand.accent, letterSpacing: "0.14em" }}>Who's coming</h2>
          <p className="mt-1 text-[13px]" style={{ color: brand.mute }}>
            {editable ? "Names and dietary requirements help the kitchen and the seating plan. You can change these until the night." : "Changes are closed for this event."}
          </p>
          <div className="mt-4 space-y-4">
            <Field brand={brand} label="Sit us with (table name)" hint={`Tables of ${ev.tableSize}. Everyone who enters the same table name is seated together where we can.`}>
              <input value={tableName} onChange={(e) => setTableName(e.target.value)} disabled={!editable} style={inputStyle(brand)} className="min-h-[44px] w-full" />
            </Field>
            {guests.map((g, i) => (
              <div key={g.seatNo} className="grid gap-2 sm:grid-cols-2">
                <input value={g.fullName} disabled={!editable} onChange={(e) => setGuests((gs) => gs.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} placeholder={`Seat ${g.seatNo} — name`} style={inputStyle(brand)} className="min-h-[44px] w-full" />
                <input value={g.dietary} disabled={!editable} onChange={(e) => setGuests((gs) => gs.map((x, j) => (j === i ? { ...x, dietary: e.target.value } : x)))} placeholder="Dietary requirements" style={inputStyle(brand)} className="min-h-[44px] w-full" />
              </div>
            ))}
            {error && <Notice brand={brand} tone="error">{error}</Notice>}
            {saved && <Notice brand={brand} tone="good"><span className="inline-flex items-center gap-2"><CheckCircle2 size={15} /> Saved.</span></Notice>}
            {editable && (
              <Button brand={brand} onClick={save} disabled={busy} className="w-full">
                {busy ? <Loader2 size={17} className="mr-2 animate-spin" /> : null}Save
              </Button>
            )}
          </div>
        </Card>
      )}

      {order.status === "paid" && (
        <div className="mt-5 text-center">
          <Button brand={brand} variant="ghost" onClick={resend} disabled={busy || resent}>
            <Mail size={15} className="mr-2" />{resent ? "Ticket email sent again" : "Email me my ticket again"}
          </Button>
        </div>
      )}
      {ev.contactEmail && (
        <p className="mt-6 text-center text-[13px]" style={{ color: brand.mute }}>
          Questions? <a className="underline" href={`mailto:${ev.contactEmail}`}>{ev.contactEmail}</a>
        </p>
      )}
    </TeampayShell>
  );
}

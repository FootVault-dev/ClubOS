// Club Events — the list (admin).
//
// Ticketed club events (the first: the CUFC Club Dinner, Fri 13 Nov 2026).
// One card per event with its live stats; "New event" creates the shell and
// jumps straight to its detail page to add ticket types, copy and the sale.
// Light mode only — see CLAUDE.md's ClubOS admin standing rule.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ClubEvent, ClubEventTicketType } from "@shared/schema";
import { CLUB_EVENT_STATUSES, type ClubEventStatus, dollars, nzClock, nzLocalToUtc, nzLongDate } from "@shared/club-events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CalendarDays, Loader2, MapPin, Plus, Ticket, Users, Wallet } from "lucide-react";

// ── shapes ───────────────────────────────────────────────────────────────────
interface EventStats {
  seatsPaid: number;
  seatsPending: number;
  ordersPaid: number;
  revenueCents: number;
  refundedCents: number;
  byType: { name: string; seats: number; revenueCents: number }[];
  byTender: { method: string; seats: number; revenueCents: number }[];
  guestsNamed: number;
  dietaryCount: number;
  checkedIn: number;
  tables: number;
}
interface EventRow extends ClubEvent {
  stats: EventStats;
  ticketTypes: ClubEventTicketType[];
}

// ── light-mode status badge ──────────────────────────────────────────────────
const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  open: "bg-emerald-50 text-emerald-700 border-emerald-200",
  closed: "bg-slate-200 text-slate-700 border-slate-300",
};
const STATUS_LABEL: Record<string, string> = { draft: "Draft", open: "Open", closed: "Closed" };

// ── auto-fill helpers for the New Event dialog ──────────────────────────────
const STOPWORDS = new Set(["the", "a", "an", "of", "and", "for", "club", "cufc", "siu", "united", "fc"]);

function slugify(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

/** "Club Dinner" -> "DIN26" (single significant word -> its first 3 letters); "Awards Night" -> "AN26". */
function autoShortCode(name: string, dateIso: string): string {
  const words = name.trim().split(/\s+/).map((w) => w.replace(/[^a-zA-Z]/g, "")).filter(Boolean);
  const significant = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const base = significant.length >= 2
    ? significant.map((w) => w[0]).join("").toUpperCase().slice(0, 6)
    : (significant[0] || words[0] || "EV").slice(0, 3).toUpperCase();
  let year = String(new Date().getFullYear()).slice(-2);
  if (dateIso) {
    const y = Number(dateIso.slice(0, 4));
    if (Number.isFinite(y) && y > 0) year = String(y).slice(-2);
  }
  return (base + year).slice(0, 8) || "EV" + year;
}

/** Pull the server's own { message } out of an apiRequest() throw, falling back to the raw error text. */
function apiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const i = raw.indexOf(": ");
  const body = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through to the raw text
  }
  return raw;
}

const emptyForm = {
  name: "",
  slug: "",
  shortCode: "",
  date: "",
  startTime: "",
  endTime: "",
  venueName: "",
  venueAddress: "",
  capacity: "",
  tableSize: "10",
  status: "draft" as ClubEventStatus,
};
type NewEventForm = typeof emptyForm;

// Light-mode override for the dark-styled date/time popovers so they read on white.
const PICKER_CLASS = "h-11 bg-white border-slate-200 text-slate-900 hover:bg-slate-50 focus:border-blue-400";

export default function ClubEventsAdmin() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data, isLoading } = useQuery<{ events: EventRow[] }>({ queryKey: ["/api/admin/club-events"] });
  const events = data?.events ?? [];

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<NewEventForm>(emptyForm);
  const [slugTouched, setSlugTouched] = useState(false);
  const [codeTouched, setCodeTouched] = useState(false);

  const resetForm = () => {
    setForm(emptyForm);
    setSlugTouched(false);
    setCodeTouched(false);
  };

  const setName = (name: string) =>
    setForm((f) => ({
      ...f,
      name,
      slug: slugTouched ? f.slug : slugify(name),
      shortCode: codeTouched ? f.shortCode : autoShortCode(name, f.date),
    }));
  const setDate = (date: string) =>
    setForm((f) => ({ ...f, date, shortCode: codeTouched ? f.shortCode : autoShortCode(f.name, date) }));

  const create = useMutation({
    mutationFn: async () => {
      if (!form.name.trim()) throw new Error("Name is required.");
      if (!form.slug.trim()) throw new Error("Slug is required.");
      if (!form.date || !form.startTime) throw new Error("Date and start time are required.");
      const startsAt = nzLocalToUtc(form.date, form.startTime).toISOString();
      const endsAt = form.endTime ? nzLocalToUtc(form.date, form.endTime).toISOString() : null;
      const res = await apiRequest("POST", "/api/admin/club-events", {
        name: form.name.trim(),
        slug: form.slug.trim(),
        shortCode: form.shortCode.trim() || undefined,
        startsAt,
        endsAt,
        venueName: form.venueName.trim() || null,
        venueAddress: form.venueAddress.trim() || null,
        capacity: form.capacity.trim() === "" ? null : Number(form.capacity),
        tableSize: Number(form.tableSize) || 10,
        status: form.status,
      });
      return (await res.json()) as ClubEvent;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/club-events"] });
      toast({ title: "Event created" });
      setOpen(false);
      resetForm();
      navigate(`/admin/club-events/${created.id}`);
    },
    onError: (err) => toast({ title: "Couldn't create the event", description: apiErrorMessage(err), variant: "destructive" }),
  });

  return (
    <div className="p-4 sm:p-6 pb-24 space-y-6 bg-slate-50 min-h-full">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Events</h1>
          <p className="text-sm text-slate-500 mt-1">
            Ticketed club events — sell tickets, take the door, and know who's coming.
          </p>
        </div>
        <Button className="gap-2 min-h-11" onClick={() => setOpen(true)} data-testid="button-new-event">
          <Plus className="w-4 h-4" /> New event
        </Button>
      </div>

      <Dialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) resetForm();
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto bg-white text-slate-900">
          <DialogHeader>
            <DialogTitle>New event</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-slate-700">Name</Label>
              <Input
                className="h-11 mt-1"
                value={form.name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Christchurch United Club Dinner"
                data-testid="input-event-name"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Slug</Label>
                <Input
                  className="h-11 mt-1"
                  value={form.slug}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, slug: slugify(e.target.value) }));
                    setSlugTouched(true);
                  }}
                  data-testid="input-event-slug"
                />
              </div>
              <div>
                <Label className="text-slate-700">Short code</Label>
                <Input
                  className="h-11 mt-1"
                  value={form.shortCode}
                  maxLength={8}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, shortCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }));
                    setCodeTouched(true);
                  }}
                  data-testid="input-event-code"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-slate-700">Date</Label>
                <div className="mt-1">
                  <DatePickerInput value={form.date} onChange={(e) => setDate(e.target.value)} className={PICKER_CLASS} data-testid="input-event-date" />
                </div>
              </div>
              <div>
                <Label className="text-slate-700">Start time</Label>
                <div className="mt-1">
                  <TimePickerInput
                    value={form.startTime}
                    onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    className={PICKER_CLASS}
                    data-testid="input-event-start"
                  />
                </div>
              </div>
              <div>
                <Label className="text-slate-700">End time</Label>
                <div className="mt-1">
                  <TimePickerInput
                    value={form.endTime}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    className={PICKER_CLASS}
                    data-testid="input-event-end"
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Venue name</Label>
                <Input
                  className="h-11 mt-1"
                  value={form.venueName}
                  onChange={(e) => setForm((f) => ({ ...f, venueName: e.target.value }))}
                  data-testid="input-event-venue-name"
                />
              </div>
              <div>
                <Label className="text-slate-700">Venue address</Label>
                <Input
                  className="h-11 mt-1"
                  value={form.venueAddress}
                  onChange={(e) => setForm((f) => ({ ...f, venueAddress: e.target.value }))}
                  data-testid="input-event-venue-address"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-slate-700">Capacity</Label>
                <Input
                  className="h-11 mt-1"
                  inputMode="numeric"
                  value={form.capacity}
                  placeholder="No cap"
                  onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value.replace(/[^0-9]/g, "") }))}
                  data-testid="input-event-capacity"
                />
              </div>
              <div>
                <Label className="text-slate-700">Table size</Label>
                <Input
                  className="h-11 mt-1"
                  inputMode="numeric"
                  value={form.tableSize}
                  onChange={(e) => setForm((f) => ({ ...f, tableSize: e.target.value.replace(/[^0-9]/g, "") }))}
                  data-testid="input-event-table-size"
                />
              </div>
              <div>
                <Label className="text-slate-700">Status</Label>
                <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v as ClubEventStatus }))}>
                  <SelectTrigger className="h-11 mt-1" data-testid="select-event-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CLUB_EVENT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABEL[s] ?? s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="min-h-11 gap-2" disabled={create.isPending} onClick={() => create.mutate()} data-testid="button-create-event">
              {create.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {create.isPending ? "Creating…" : "Create event"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="text-slate-500 text-sm py-16 text-center">Loading events…</div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center rounded-2xl border border-dashed border-slate-300 bg-white">
          <Ticket className="w-10 h-10 text-slate-300 mb-3" />
          <p className="text-slate-700 font-medium">No events yet.</p>
          <p className="text-slate-400 text-sm mt-1">Create the first one — the Club Dinner is a good place to start.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {events.map((e) => {
            const status = STATUS_LABEL[e.status] ? e.status : "draft";
            return (
              <Link
                key={e.id}
                href={`/admin/club-events/${e.id}`}
                className="block rounded-2xl border border-slate-200 bg-white p-5 hover:shadow-md hover:border-slate-300 transition-all"
                data-testid={`card-event-${e.id}`}
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <h2 className="text-base font-semibold text-slate-900 leading-snug">{e.name}</h2>
                  <Badge className={STATUS_BADGE[status]} variant="outline">
                    {STATUS_LABEL[status]}
                  </Badge>
                </div>
                <div className="space-y-1.5 text-sm text-slate-600">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                    {nzLongDate(e.startsAt)}, {nzClock(e.startsAt)}
                  </div>
                  {e.venueName && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      {e.venueName}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-slate-100">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 flex items-center gap-1">
                      <Users className="w-3 h-3" /> Seats
                    </div>
                    <div className="text-lg font-semibold text-slate-900">
                      {e.stats.seatsPaid}
                      {e.capacity != null && <span className="text-slate-400 text-sm font-normal"> / {e.capacity}</span>}
                    </div>
                    {e.stats.seatsPending > 0 && <div className="text-[11px] text-amber-600">{e.stats.seatsPending} pending</div>}
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400 flex items-center gap-1">
                      <Wallet className="w-3 h-3" /> Revenue
                    </div>
                    <div className="text-lg font-semibold text-slate-900">{dollars(e.stats.revenueCents)}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-slate-400">Tables</div>
                    <div className="text-lg font-semibold text-slate-900">{e.stats.tables}</div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

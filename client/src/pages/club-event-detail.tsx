// Club Events — one event's admin page.
//
// Overview / Orders / Guests ("the door") / Sell in person / Settings. Every
// mutation invalidates the single detail query — the API bundles event,
// ticket types, live stats, orders and guests into one GET, so a full refetch
// after any write is cheap and keeps every tab honest. Light mode only.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ClubEvent, ClubEventTicketType } from "@shared/schema";
import {
  CLUB_EVENT_STATUSES, STRIPE_ACCOUNTS, type ClubEventStatus, type StripeAccountKey,
  currentTicketType, dollars, nzClock, nzDateIso, nzLocalToUtc, nzLongDate, nzShortDate, nzTimeHm, typeOnSale,
} from "@shared/club-events";
import { OFFICE_PAYMENT_METHODS } from "@shared/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertTriangle, ChevronDown, ChevronUp, Copy, Download, ExternalLink, Loader2, Plus, RefreshCw,
  Ticket, Trash2, Users,
} from "lucide-react";

// ── shapes returned by GET /api/admin/club-events/:id ───────────────────────
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
interface OrderRow {
  id: number;
  ref: string;
  token: string;
  status: "pending" | "paid" | "cancelled" | "refunded";
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  paidCents: number | null;
  paidAt: string | null;
  refundedCents: number;
  refundedAt: string | null;
  refundReason: string | null;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  stripePaymentIntentId: string | null;
  servedBy: string | null;
  tableName: string | null;
  buyerNotes: string | null;
  staffNotes: string | null;
  source: string | null;
  ticketTypeName: string;
  checkedIn: number;
  createdAt: string;
}
interface GuestRow {
  id: number;
  seatNo: number;
  fullName: string | null;
  dietary: string | null;
  checkedInAt: string | null;
  orderId: number;
  ref: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  tableName: string | null;
  quantity: number;
}
interface DetailData {
  event: ClubEvent;
  ticketTypes: ClubEventTicketType[];
  stats: EventStats;
  orders: OrderRow[];
  guests: GuestRow[];
  publicUrl: string;
  stripeReady: boolean;
}

// ── shared helpers ───────────────────────────────────────────────────────────
function apiErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const i = raw.indexOf(": ");
  const body = i >= 0 ? raw.slice(i + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return raw;
}

const TENDER_LABEL: Record<string, string> = {
  online_card: "Card online",
  eftpos: "EFTPOS",
  cash: "Cash",
  bank_transfer: "Bank transfer",
  other: "Other",
};
function tenderLabel(m: string | null | undefined): string {
  if (!m) return "Unknown";
  return TENDER_LABEL[m] ?? m;
}

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  open: "bg-emerald-50 text-emerald-700 border-emerald-200",
  closed: "bg-slate-200 text-slate-700 border-slate-300",
};
const STATUS_LABEL: Record<string, string> = { draft: "Draft", open: "Open", closed: "Closed" };

const ORDER_STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-slate-100 text-slate-500 border-slate-200",
  refunded: "bg-rose-50 text-rose-700 border-rose-200",
};
const ORDER_STATUS_LABEL: Record<string, string> = { pending: "Pending", paid: "Paid", cancelled: "Cancelled", refunded: "Refunded" };

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

const PICKER_CLASS = "h-11 bg-white border-slate-200 text-slate-900 hover:bg-slate-50 focus:border-blue-400";

function StatTile({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
        {Icon && <Icon className="w-3.5 h-3.5 text-slate-300" />}
      </div>
      <div className="text-xl font-semibold text-slate-900 mt-1">{value}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function ClubEventDetailAdmin() {
  const [, params] = useRoute("/admin/club-events/:id");
  const id = params?.id ? Number(params.id) : NaN;
  const { toast } = useToast();

  const detailKey = [`/api/admin/club-events/${id}`];
  const { data, isLoading, error } = useQuery<DetailData>({ queryKey: detailKey, enabled: Number.isFinite(id) });

  const [tab, setTab] = useState<string>(() => {
    if (typeof window === "undefined") return "overview";
    const h = window.location.hash.replace("#", "");
    return h || "overview";
  });
  const changeTab = (v: string) => {
    setTab(v);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `#${v}`);
  };

  // ── Orders tab state ────────────────────────────────────────────────────
  const [orderStatusFilter, setOrderStatusFilter] = useState<"all" | "paid" | "pending" | "refunded" | "cancelled">("paid");
  const [orderSearch, setOrderSearch] = useState("");
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [refundTarget, setRefundTarget] = useState<OrderRow | null>(null);

  // ── Guests tab state ────────────────────────────────────────────────────
  const [guestSearch, setGuestSearch] = useState("");

  // ── Settings tab state (populated once the event loads) ────────────────
  const [settingsForm, setSettingsForm] = useState<{
    name: string; tagline: string; description: string; includes: string[];
    venueName: string; venueAddress: string; date: string; startTime: string; endTime: string;
    capacity: string; tableSize: string; maxPerOrder: string; ageRestriction: string;
    contactEmail: string; paymentNote: string; status: ClubEventStatus; stripeAccount: StripeAccountKey;
  } | null>(null);

  useEffect(() => {
    const e = data?.event;
    if (!e) return;
    setSettingsForm({
      name: e.name,
      tagline: e.tagline ?? "",
      description: e.description ?? "",
      includes: e.includes && e.includes.length ? [...e.includes] : [],
      venueName: e.venueName ?? "",
      venueAddress: e.venueAddress ?? "",
      date: nzDateIso(e.startsAt),
      startTime: nzTimeHm(e.startsAt),
      endTime: e.endsAt ? nzTimeHm(e.endsAt) : "",
      capacity: e.capacity != null ? String(e.capacity) : "",
      tableSize: String(e.tableSize),
      maxPerOrder: String(e.maxPerOrder),
      ageRestriction: e.ageRestriction ?? "",
      contactEmail: e.contactEmail ?? "",
      paymentNote: e.paymentNote ?? "",
      status: (e.status as ClubEventStatus) ?? "draft",
      stripeAccount: (e.stripeAccount as StripeAccountKey) ?? "club",
    });
    // Re-sync whenever the server's copy of the event changes (another save, a status toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.event?.id, data?.event?.updatedAt]);

  // ── Sell in person tab state ────────────────────────────────────────────
  const [sellForm, setSellForm] = useState({
    buyerName: "", buyerEmail: "", buyerPhone: "",
    quantity: "1", ticketTypeId: "", unitPrice: "",
    paymentMethod: "", paymentReference: "", tableName: "", staffNotes: "",
  });
  const [guestNames, setGuestNames] = useState<string[]>([""]);

  useEffect(() => {
    const types = data?.ticketTypes;
    if (!types || !types.length || sellForm.ticketTypeId) return;
    const cur = currentTicketType(types) ?? types[0];
    if (cur) setSellForm((f) => ({ ...f, ticketTypeId: String(cur.id), unitPrice: centsToDollarInput(cur.priceCents) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.ticketTypes]);

  const setSellQuantity = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, "");
    setSellForm((f) => ({ ...f, quantity: digits }));
    const n = Math.max(0, Math.min(50, Number(digits) || 0));
    setGuestNames((prev) => {
      const next = prev.slice(0, n);
      while (next.length < n) next.push("");
      return next;
    });
  };

  // ── mutations (declared unconditionally, above any early return) ───────
  const invalidate = () => queryClient.invalidateQueries({ queryKey: detailKey });
  const invalidateList = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/club-events"] });

  const updateEvent = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("PATCH", `/api/admin/club-events/${id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      invalidateList();
      toast({ title: "Saved" });
    },
    onError: (err) => toast({ title: "Couldn't save", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const saveTicketType = useMutation({
    mutationFn: async ({ typeId, patch }: { typeId: number; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/admin/club-events/${id}/ticket-types/${typeId}`, patch);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Ticket type saved" });
    },
    onError: (err) => toast({ title: "Couldn't save ticket type", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const addTicketType = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/ticket-types`, patch);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Ticket type added" });
    },
    onError: (err) => toast({ title: "Couldn't add ticket type", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const deleteTicketType = useMutation({
    mutationFn: async (typeId: number) => {
      const res = await apiRequest("DELETE", `/api/admin/club-events/${id}/ticket-types/${typeId}`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Ticket type deleted" });
    },
    onError: (err) => toast({ title: "Couldn't delete", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const reconcile = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/reconcile`);
      return (await res.json()) as { checked: number; paid: number };
    },
    onSuccess: (r) => {
      invalidate();
      toast({ title: "Reconciled with Stripe", description: `Checked ${r.checked}, ${r.paid} newly paid.` });
    },
    onError: (err) => toast({ title: "Reconcile failed", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const patchOrder = useMutation({
    mutationFn: async ({ orderId, patch }: { orderId: number; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/admin/club-events/${id}/orders/${orderId}`, patch);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Order updated" });
    },
    onError: (err) => toast({ title: "Couldn't update the order", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const resendTicket = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/orders/${orderId}/resend`);
      return (await res.json()) as { ok: boolean };
    },
    onSuccess: (r) => toast({ title: r.ok ? "Ticket resent" : "Couldn't resend", description: r.ok ? undefined : "That order isn't paid yet.", variant: r.ok ? undefined : "destructive" }),
    onError: (err) => toast({ title: "Couldn't resend", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const cancelOrder = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/orders/${orderId}/cancel`);
      return res.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Order cancelled" });
    },
    onError: (err) => toast({ title: "Couldn't cancel", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const refundOrder = useMutation({
    mutationFn: async ({ orderId, amountCents, reason }: { orderId: number; amountCents: number | null; reason: string | null }) => {
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/orders/${orderId}/refund`, { amountCents, reason });
      return (await res.json()) as { refundedCents: number; status: string };
    },
    onSuccess: (r) => {
      invalidate();
      setRefundTarget(null);
      toast({ title: r.status === "refunded" ? "Fully refunded" : "Partially refunded" });
    },
    onError: (err) => toast({ title: "Refund failed", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const patchGuest = useMutation({
    mutationFn: async ({ guestId, patch }: { guestId: number; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/admin/club-events/${id}/guests/${guestId}`, patch);
      return res.json();
    },
    onSuccess: () => invalidate(),
    onError: (err) => toast({ title: "Couldn't save", description: apiErrorMessage(err), variant: "destructive" }),
  });

  const manualSale = useMutation({
    mutationFn: async () => {
      const quantity = Number(sellForm.quantity);
      if (!quantity || quantity < 1) throw new Error("Quantity must be at least 1.");
      if (!sellForm.buyerName.trim()) throw new Error("Buyer name is required.");
      if (!sellForm.buyerEmail.trim()) throw new Error("Buyer email is required — the ticket is sent there.");
      if (!sellForm.ticketTypeId) throw new Error("Choose a ticket type.");
      if (!sellForm.paymentMethod) throw new Error("Choose how they paid.");
      const res = await apiRequest("POST", `/api/admin/club-events/${id}/orders`, {
        buyerName: sellForm.buyerName.trim(),
        buyerEmail: sellForm.buyerEmail.trim(),
        buyerPhone: sellForm.buyerPhone.trim() || null,
        quantity,
        ticketTypeId: Number(sellForm.ticketTypeId),
        unitPriceCents: dollarInputToCents(sellForm.unitPrice || "0"),
        paymentMethod: sellForm.paymentMethod,
        paymentReference: sellForm.paymentReference.trim() || null,
        tableName: sellForm.tableName.trim() || null,
        staffNotes: sellForm.staffNotes.trim() || null,
        guests: guestNames.slice(0, quantity).map((n) => ({ fullName: n.trim() || null })),
      });
      return (await res.json()) as OrderRow;
    },
    onSuccess: (order) => {
      invalidate();
      toast({ title: `Sold — ${order.ref}`, description: `Ticket emailed to ${order.buyerEmail}.` });
      setSellForm((f) => ({
        buyerName: "", buyerEmail: "", buyerPhone: "",
        quantity: "1", ticketTypeId: f.ticketTypeId, unitPrice: f.unitPrice,
        paymentMethod: "", paymentReference: "", tableName: "", staffNotes: "",
      }));
      setGuestNames([""]);
    },
    onError: (err) => toast({ title: "Sale failed", description: apiErrorMessage(err), variant: "destructive" }),
  });

  // ── early returns — every hook above this line ──────────────────────────
  if (!Number.isFinite(id)) return <div className="p-6 text-slate-500">That event doesn't exist.</div>;
  if (isLoading || !settingsForm) return <div className="p-6 text-slate-500">Loading event…</div>;
  if (error || !data) return <div className="p-6 text-rose-600">Couldn't load this event.</div>;

  const { event, ticketTypes, stats, orders, guests, publicUrl, stripeReady } = data;

  const copyLink = () => {
    navigator.clipboard.writeText(publicUrl).then(
      () => toast({ title: "Link copied" }),
      () => toast({ title: "Couldn't copy — copy it from the address bar instead.", variant: "destructive" }),
    );
  };

  const downloadGuestsCsv = async () => {
    try {
      const res = await apiRequest("GET", `/api/admin/club-events/${id}/guests.csv`);
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${event.slug}-guests.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast({ title: "Download failed", description: apiErrorMessage(err), variant: "destructive" });
    }
  };

  const filteredOrders = orders.filter((o) => {
    if (orderStatusFilter !== "all" && o.status !== orderStatusFilter) return false;
    const q = orderSearch.trim().toLowerCase();
    if (!q) return true;
    return o.ref.toLowerCase().includes(q) || o.buyerName.toLowerCase().includes(q) || o.buyerEmail.toLowerCase().includes(q);
  });

  const filteredGuests = guests.filter((g) => {
    const q = guestSearch.trim().toLowerCase();
    if (!q) return true;
    return (g.fullName ?? "").toLowerCase().includes(q) || g.ref.toLowerCase().includes(q) || g.buyerName.toLowerCase().includes(q);
  });
  const guestGroups = new Map<string, GuestRow[]>();
  for (const g of filteredGuests) {
    const key = g.tableName?.trim() || "No table yet";
    if (!guestGroups.has(key)) guestGroups.set(key, []);
    guestGroups.get(key)!.push(g);
  }
  const sortedGroupKeys = Array.from(guestGroups.keys()).sort((a, b) => a.localeCompare(b));

  return (
    <div className="p-4 sm:p-6 pb-24 space-y-6 bg-slate-50 min-h-full">
      {/* header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold text-slate-900">{event.name}</h1>
            <Badge className={STATUS_BADGE[event.status] ?? STATUS_BADGE.draft} variant="outline">
              {STATUS_LABEL[event.status] ?? event.status}
            </Badge>
          </div>
          <p className="text-sm text-slate-500 mt-1">
            {nzLongDate(event.startsAt)}, {nzClock(event.startsAt)}
            {event.endsAt ? ` to ${nzClock(event.endsAt)}` : ""}
            {event.venueName ? ` · ${event.venueName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" className="min-h-11 gap-2" onClick={copyLink} data-testid="button-copy-link">
            <Copy className="w-4 h-4" /> Copy ticket link
          </Button>
          <Button variant="outline" className="min-h-11 gap-2" onClick={() => window.open(publicUrl, "_blank", "noopener")} data-testid="button-open-page">
            <ExternalLink className="w-4 h-4" /> Open page
          </Button>
          <Button
            className="min-h-11"
            variant={event.status === "open" ? "outline" : "default"}
            disabled={updateEvent.isPending}
            onClick={() => updateEvent.mutate({ status: event.status === "open" ? "closed" : "open" })}
            data-testid="button-toggle-status"
          >
            {event.status === "open" ? "Close sale" : "Open sale"}
          </Button>
        </div>
      </div>

      {!stripeReady && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          Online payment isn't configured for this event's Stripe account.
        </div>
      )}

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="flex-wrap h-auto bg-white border border-slate-200 p-1">
          <TabsTrigger className="min-h-9" value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger className="min-h-9" value="orders" data-testid="tab-orders">Orders</TabsTrigger>
          <TabsTrigger className="min-h-9" value="guests" data-testid="tab-guests">Guests</TabsTrigger>
          <TabsTrigger className="min-h-9" value="sell" data-testid="tab-sell">Sell in person</TabsTrigger>
          <TabsTrigger className="min-h-9" value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>

        {/* ── Overview ────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6 mt-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Seats sold" value={`${stats.seatsPaid}${event.capacity != null ? ` / ${event.capacity}` : ""}`} icon={Users} />
            <StatTile label="Revenue" value={dollars(stats.revenueCents)} />
            <StatTile label="Refunded" value={dollars(stats.refundedCents)} />
            <StatTile label="Tables" value={`${stats.tables} of ${event.tableSize}`} />
            <StatTile label="Pending holds" value={String(stats.seatsPending)} />
            <StatTile label="Guests named" value={`${stats.guestsNamed} / ${stats.seatsPaid}`} />
            <StatTile label="Dietary needs" value={String(stats.dietaryCount)} />
            <StatTile label="Checked in" value={String(stats.checkedIn)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 text-sm font-medium text-slate-700">By ticket type</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-right">Seats</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.byType.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-slate-400 text-center">No sales yet</TableCell></TableRow>
                  ) : (
                    stats.byType.map((t) => (
                      <TableRow key={t.name}>
                        <TableCell>{t.name}</TableCell>
                        <TableCell className="text-right">{t.seats}</TableCell>
                        <TableCell className="text-right">{dollars(t.revenueCents)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 text-sm font-medium text-slate-700">By tender</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Paid via</TableHead>
                    <TableHead className="text-right">Seats</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.byTender.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="text-slate-400 text-center">No sales yet</TableCell></TableRow>
                  ) : (
                    stats.byTender.map((t) => (
                      <TableRow key={t.method}>
                        <TableCell>{tenderLabel(t.method)}</TableCell>
                        <TableCell className="text-right">{t.seats}</TableCell>
                        <TableCell className="text-right">{dollars(t.revenueCents)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" className="min-h-11 gap-2" disabled={reconcile.isPending} onClick={() => reconcile.mutate()} data-testid="button-reconcile">
              {reconcile.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Reconcile with Stripe
            </Button>
            <Button variant="outline" className="min-h-11 gap-2" onClick={downloadGuestsCsv} data-testid="button-download-guests">
              <Download className="w-4 h-4" /> Download guest list (CSV)
            </Button>
          </div>
        </TabsContent>

        {/* ── Orders ──────────────────────────────────────────────────── */}
        <TabsContent value="orders" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
            <div className="flex gap-2 flex-wrap">
              {(["all", "paid", "pending", "refunded", "cancelled"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setOrderStatusFilter(s)}
                  className={`px-3 py-2 min-h-9 rounded-lg text-sm border transition-colors ${
                    orderStatusFilter === s ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                  data-testid={`button-order-filter-${s}`}
                >
                  {s === "all" ? "All" : ORDER_STATUS_LABEL[s]}
                </button>
              ))}
            </div>
            <Input
              className="h-11 sm:max-w-xs"
              placeholder="Search ref, name or email…"
              value={orderSearch}
              onChange={(e) => setOrderSearch(e.target.value)}
              data-testid="input-order-search"
            />
          </div>

          {filteredOrders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white py-14 text-center text-slate-400">No orders in this view.</div>
          ) : (
            <div className="space-y-2">
              {filteredOrders.map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  guests={guests.filter((g) => g.orderId === o.id)}
                  expanded={expandedOrderId === o.id}
                  onToggle={() => setExpandedOrderId(expandedOrderId === o.id ? null : o.id)}
                  onSave={(patch) => patchOrder.mutate({ orderId: o.id, patch })}
                  onResend={() => resendTicket.mutate(o.id)}
                  onCancel={() => cancelOrder.mutate(o.id)}
                  onRefund={() => setRefundTarget(o)}
                  saving={patchOrder.isPending}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Guests (the door) ───────────────────────────────────────── */}
        <TabsContent value="guests" className="space-y-4 mt-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <p className="text-sm text-slate-600">
              {stats.checkedIn} of {stats.seatsPaid} checked in · {stats.dietaryCount} dietary requirement{stats.dietaryCount === 1 ? "" : "s"}
            </p>
            <Input
              className="h-11 sm:max-w-xs"
              placeholder="Search name, ref or buyer…"
              value={guestSearch}
              onChange={(e) => setGuestSearch(e.target.value)}
              data-testid="input-guest-search"
            />
          </div>

          {sortedGroupKeys.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white py-14 text-center text-slate-400">No guests to show.</div>
          ) : (
            <div className="space-y-5">
              {sortedGroupKeys.map((key) => (
                <div key={key} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 text-sm font-medium text-slate-700">{key}</div>
                  <div className="divide-y divide-slate-100">
                    {guestGroups.get(key)!.map((g) => (
                      <GuestLine key={g.id} guest={g} onSave={(patch) => patchGuest.mutate({ guestId: g.id, patch })} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Sell in person ──────────────────────────────────────────── */}
        <TabsContent value="sell" className="mt-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 max-w-2xl space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Buyer name</Label>
                <Input className="h-11 mt-1" value={sellForm.buyerName} onChange={(e) => setSellForm((f) => ({ ...f, buyerName: e.target.value }))} data-testid="input-sell-name" />
              </div>
              <div>
                <Label className="text-slate-700">Buyer email</Label>
                <Input className="h-11 mt-1" type="email" value={sellForm.buyerEmail} onChange={(e) => setSellForm((f) => ({ ...f, buyerEmail: e.target.value }))} data-testid="input-sell-email" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Buyer phone</Label>
                <Input className="h-11 mt-1" value={sellForm.buyerPhone} onChange={(e) => setSellForm((f) => ({ ...f, buyerPhone: e.target.value }))} data-testid="input-sell-phone" />
              </div>
              <div>
                <Label className="text-slate-700">Table name</Label>
                <Input className="h-11 mt-1" value={sellForm.tableName} onChange={(e) => setSellForm((f) => ({ ...f, tableName: e.target.value }))} data-testid="input-sell-table" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-slate-700">Quantity</Label>
                <Input className="h-11 mt-1" inputMode="numeric" value={sellForm.quantity} onChange={(e) => setSellQuantity(e.target.value)} data-testid="input-sell-quantity" />
              </div>
              <div>
                <Label className="text-slate-700">Ticket type</Label>
                <Select
                  value={sellForm.ticketTypeId}
                  onValueChange={(v) => {
                    const t = ticketTypes.find((tt) => String(tt.id) === v);
                    setSellForm((f) => ({ ...f, ticketTypeId: v, unitPrice: t ? centsToDollarInput(t.priceCents) : f.unitPrice }));
                  }}
                >
                  <SelectTrigger className="h-11 mt-1" data-testid="select-sell-type"><SelectValue placeholder="Choose a type" /></SelectTrigger>
                  <SelectContent>
                    {ticketTypes.filter((t) => t.isActive).map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>{t.name} — {dollars(t.priceCents)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-700">Price per ticket</Label>
                <div className="mt-1">
                  <MoneyInput className="h-11" value={sellForm.unitPrice} onChange={(v) => setSellForm((f) => ({ ...f, unitPrice: v }))} data-testid="input-sell-price" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Paid via</Label>
                <Select value={sellForm.paymentMethod} onValueChange={(v) => setSellForm((f) => ({ ...f, paymentMethod: v }))}>
                  <SelectTrigger className="h-11 mt-1" data-testid="select-sell-tender"><SelectValue placeholder="Choose how they paid" /></SelectTrigger>
                  <SelectContent>
                    {OFFICE_PAYMENT_METHODS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-700">Payment reference</Label>
                <Input className="h-11 mt-1" value={sellForm.paymentReference} onChange={(e) => setSellForm((f) => ({ ...f, paymentReference: e.target.value }))} data-testid="input-sell-reference" />
              </div>
            </div>

            {guestNames.length > 0 && (
              <div>
                <Label className="text-slate-700">Guest names (optional)</Label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                  {guestNames.map((n, i) => (
                    <Input
                      key={i}
                      className="h-11"
                      placeholder={`Seat ${i + 1} name`}
                      value={n}
                      onChange={(e) => setGuestNames((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                      data-testid={`input-sell-guest-${i}`}
                    />
                  ))}
                </div>
              </div>
            )}

            <div>
              <Label className="text-slate-700">Staff notes</Label>
              <Textarea className="mt-1" rows={2} value={sellForm.staffNotes} onChange={(e) => setSellForm((f) => ({ ...f, staffNotes: e.target.value }))} data-testid="input-sell-notes" />
            </div>

            <Button className="min-h-11 gap-2" disabled={manualSale.isPending} onClick={() => manualSale.mutate()} data-testid="button-sell-submit">
              {manualSale.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Record sale &amp; email ticket
            </Button>
          </div>
        </TabsContent>

        {/* ── Settings ────────────────────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-6 mt-4">
          <div className="rounded-xl border border-slate-200 bg-white p-5 max-w-3xl space-y-4">
            <div>
              <Label className="text-slate-700">Name</Label>
              <Input className="h-11 mt-1" value={settingsForm.name} onChange={(e) => setSettingsForm((f) => f && { ...f, name: e.target.value })} data-testid="input-settings-name" />
            </div>
            <div>
              <Label className="text-slate-700">Tagline</Label>
              <Input className="h-11 mt-1" value={settingsForm.tagline} onChange={(e) => setSettingsForm((f) => f && { ...f, tagline: e.target.value })} data-testid="input-settings-tagline" />
            </div>
            <div>
              <Label className="text-slate-700">Description</Label>
              <Textarea className="mt-1" rows={4} value={settingsForm.description} onChange={(e) => setSettingsForm((f) => f && { ...f, description: e.target.value })} data-testid="input-settings-description" />
            </div>
            <div>
              <Label className="text-slate-700">What's included</Label>
              <div className="space-y-2 mt-1">
                {settingsForm.includes.map((line, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      className="h-11"
                      value={line}
                      onChange={(e) => setSettingsForm((f) => f && { ...f, includes: f.includes.map((v, idx) => (idx === i ? e.target.value : v)) })}
                      data-testid={`input-settings-includes-${i}`}
                    />
                    <Button
                      variant="outline" size="icon" className="min-h-11 min-w-11 flex-shrink-0"
                      onClick={() => setSettingsForm((f) => f && { ...f, includes: f.includes.filter((_, idx) => idx !== i) })}
                      data-testid={`button-settings-includes-remove-${i}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline" className="min-h-11 gap-2"
                  onClick={() => setSettingsForm((f) => f && { ...f, includes: [...f.includes, ""] })}
                  data-testid="button-settings-includes-add"
                >
                  <Plus className="w-4 h-4" /> Add line
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Venue name</Label>
                <Input className="h-11 mt-1" value={settingsForm.venueName} onChange={(e) => setSettingsForm((f) => f && { ...f, venueName: e.target.value })} data-testid="input-settings-venue-name" />
              </div>
              <div>
                <Label className="text-slate-700">Venue address</Label>
                <Input className="h-11 mt-1" value={settingsForm.venueAddress} onChange={(e) => setSettingsForm((f) => f && { ...f, venueAddress: e.target.value })} data-testid="input-settings-venue-address" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-slate-700">Date</Label>
                <div className="mt-1">
                  <DatePickerInput value={settingsForm.date} onChange={(e) => setSettingsForm((f) => f && { ...f, date: e.target.value })} className={PICKER_CLASS} data-testid="input-settings-date" />
                </div>
              </div>
              <div>
                <Label className="text-slate-700">Start time</Label>
                <div className="mt-1">
                  <TimePickerInput value={settingsForm.startTime} onChange={(e) => setSettingsForm((f) => f && { ...f, startTime: e.target.value })} className={PICKER_CLASS} data-testid="input-settings-start" />
                </div>
              </div>
              <div>
                <Label className="text-slate-700">End time</Label>
                <div className="mt-1">
                  <TimePickerInput value={settingsForm.endTime} onChange={(e) => setSettingsForm((f) => f && { ...f, endTime: e.target.value })} className={PICKER_CLASS} data-testid="input-settings-end" />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-slate-700">Capacity</Label>
                <Input className="h-11 mt-1" inputMode="numeric" placeholder="No cap" value={settingsForm.capacity} onChange={(e) => setSettingsForm((f) => f && { ...f, capacity: e.target.value.replace(/[^0-9]/g, "") })} data-testid="input-settings-capacity" />
              </div>
              <div>
                <Label className="text-slate-700">Table size</Label>
                <Input className="h-11 mt-1" inputMode="numeric" value={settingsForm.tableSize} onChange={(e) => setSettingsForm((f) => f && { ...f, tableSize: e.target.value.replace(/[^0-9]/g, "") })} data-testid="input-settings-table-size" />
              </div>
              <div>
                <Label className="text-slate-700">Max per order</Label>
                <Input className="h-11 mt-1" inputMode="numeric" value={settingsForm.maxPerOrder} onChange={(e) => setSettingsForm((f) => f && { ...f, maxPerOrder: e.target.value.replace(/[^0-9]/g, "") })} data-testid="input-settings-max-per-order" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Age restriction</Label>
                <Input className="h-11 mt-1" placeholder="e.g. 18+" value={settingsForm.ageRestriction} onChange={(e) => setSettingsForm((f) => f && { ...f, ageRestriction: e.target.value })} data-testid="input-settings-age" />
              </div>
              <div>
                <Label className="text-slate-700">Contact email</Label>
                <Input className="h-11 mt-1" type="email" value={settingsForm.contactEmail} onChange={(e) => setSettingsForm((f) => f && { ...f, contactEmail: e.target.value })} data-testid="input-settings-contact-email" />
              </div>
            </div>
            <div>
              <Label className="text-slate-700">Payment note</Label>
              <Textarea className="mt-1" rows={2} value={settingsForm.paymentNote} onChange={(e) => setSettingsForm((f) => f && { ...f, paymentNote: e.target.value })} data-testid="input-settings-payment-note" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-slate-700">Status</Label>
                <Select value={settingsForm.status} onValueChange={(v) => setSettingsForm((f) => f && { ...f, status: v as ClubEventStatus })}>
                  <SelectTrigger className="h-11 mt-1" data-testid="select-settings-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CLUB_EVENT_STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-slate-700">Stripe account</Label>
                <Select value={settingsForm.stripeAccount} onValueChange={(v) => setSettingsForm((f) => f && { ...f, stripeAccount: v as StripeAccountKey })}>
                  <SelectTrigger className="h-11 mt-1" data-testid="select-settings-stripe"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STRIPE_ACCOUNTS.map((s) => <SelectItem key={s} value={s}>{s === "club" ? "Club" : "Cross Street Football Trust"}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-slate-400 mt-1">
                  Trust = Cross Street Football Trust's own Stripe account; needs its keys configured.
                </p>
              </div>
            </div>
            <Button
              className="min-h-11 gap-2"
              disabled={updateEvent.isPending}
              onClick={() => {
                const f = settingsForm;
                const startsAt = f.date && f.startTime ? nzLocalToUtc(f.date, f.startTime).toISOString() : undefined;
                const endsAt = f.date && f.endTime ? nzLocalToUtc(f.date, f.endTime).toISOString() : f.endTime === "" ? null : undefined;
                updateEvent.mutate({
                  name: f.name.trim(),
                  tagline: f.tagline.trim() || null,
                  description: f.description.trim() || null,
                  includes: f.includes.map((v) => v.trim()).filter(Boolean),
                  venueName: f.venueName.trim() || null,
                  venueAddress: f.venueAddress.trim() || null,
                  ...(startsAt ? { startsAt } : {}),
                  endsAt,
                  capacity: f.capacity.trim() === "" ? null : Number(f.capacity),
                  tableSize: Number(f.tableSize) || 10,
                  maxPerOrder: Number(f.maxPerOrder) || 10,
                  ageRestriction: f.ageRestriction.trim() || null,
                  contactEmail: f.contactEmail.trim() || null,
                  paymentNote: f.paymentNote.trim() || null,
                  status: f.status,
                  stripeAccount: f.stripeAccount,
                });
              }}
              data-testid="button-save-settings"
            >
              {updateEvent.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save event
            </Button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden max-w-4xl">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-medium text-slate-700">Ticket types</div>
            <div className="divide-y divide-slate-100">
              {ticketTypes.map((t) => (
                <TicketTypeRow
                  key={t.id}
                  type={t}
                  onSave={(patch) => saveTicketType.mutate({ typeId: t.id, patch })}
                  onDelete={() => deleteTicketType.mutate(t.id)}
                  saving={saveTicketType.isPending || deleteTicketType.isPending}
                />
              ))}
              <AddTicketTypeRow onAdd={(patch) => addTicketType.mutate(patch)} saving={addTicketType.isPending} />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {refundTarget && (
        <RefundDialog
          order={refundTarget}
          onClose={() => setRefundTarget(null)}
          onSubmit={(amountCents, reason) => refundOrder.mutate({ orderId: refundTarget.id, amountCents, reason })}
          submitting={refundOrder.isPending}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Orders tab — one expandable card per order.
// ═══════════════════════════════════════════════════════════════════════════
function OrderCard({
  order, guests, expanded, onToggle, onSave, onResend, onCancel, onRefund, saving,
}: {
  order: OrderRow;
  guests: GuestRow[];
  expanded: boolean;
  onToggle: () => void;
  onSave: (patch: { staffNotes?: string | null; tableName?: string | null }) => void;
  onResend: () => void;
  onCancel: () => void;
  onRefund: () => void;
  saving: boolean;
}) {
  const [staffNotes, setStaffNotes] = useState(order.staffNotes ?? "");
  const [tableName, setTableName] = useState(order.tableName ?? "");
  const dirty = staffNotes !== (order.staffNotes ?? "") || tableName !== (order.tableName ?? "");

  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden" data-testid={`card-order-${order.id}`}>
      <button onClick={onToggle} className="w-full text-left px-4 py-3 flex items-center justify-between gap-3 hover:bg-slate-50 min-h-11">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-900">{order.ref}</span>
            <Badge className={ORDER_STATUS_BADGE[order.status]} variant="outline">{ORDER_STATUS_LABEL[order.status]}</Badge>
            {order.tableName && <span className="text-xs text-slate-400">Table {order.tableName}</span>}
          </div>
          <div className="text-sm text-slate-600 truncate">
            {order.buyerName} · {order.buyerEmail} · {order.quantity} × {order.ticketTypeName}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            {tenderLabel(order.paymentMethod)}{order.servedBy ? ` · served by ${order.servedBy}` : ""} · {fmtDateTime(order.createdAt)}
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="font-semibold text-slate-900">{dollars(order.totalCents)}</span>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-100 px-4 py-4 space-y-4">
          {order.refundedCents > 0 && (
            <p className="text-sm text-rose-600">
              Refunded {dollars(order.refundedCents)}{order.refundReason ? ` — ${order.refundReason}` : ""}
              {order.refundedAt ? ` on ${fmtDateTime(order.refundedAt)}` : ""}
            </p>
          )}
          {order.buyerNotes && <p className="text-sm text-slate-600"><span className="text-slate-400">Buyer notes:</span> {order.buyerNotes}</p>}

          {guests.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Guests</p>
              <div className="text-sm text-slate-700 space-y-0.5">
                {guests.map((g) => (
                  <div key={g.id}>
                    Seat {g.seatNo} — {g.fullName || <span className="text-slate-400">no name yet</span>}
                    {g.dietary ? ` · ${g.dietary}` : ""}
                    {g.checkedInAt ? " · checked in" : ""}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label className="text-slate-700">Table name</Label>
              <Input className="h-11 mt-1" value={tableName} onChange={(e) => setTableName(e.target.value)} data-testid={`input-order-table-${order.id}`} />
            </div>
            <div>
              <Label className="text-slate-700">Staff notes</Label>
              <Textarea className="mt-1" rows={2} value={staffNotes} onChange={(e) => setStaffNotes(e.target.value)} data-testid={`input-order-notes-${order.id}`} />
            </div>
          </div>
          {dirty && (
            <Button
              variant="outline" className="min-h-11"
              onClick={() => onSave({ staffNotes: staffNotes.trim() || null, tableName: tableName.trim() || null })}
              data-testid={`button-order-save-${order.id}`}
            >
              Save
            </Button>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
            {order.status === "paid" && (
              <Button variant="outline" className="min-h-11" onClick={onResend} data-testid={`button-order-resend-${order.id}`}>Resend ticket</Button>
            )}
            {order.status === "pending" && (
              <Button variant="outline" className="min-h-11 text-slate-600" disabled={saving} onClick={onCancel} data-testid={`button-order-cancel-${order.id}`}>Cancel</Button>
            )}
            {order.status === "paid" && (
              <Button variant="outline" className="min-h-11 text-rose-600 border-rose-200 hover:bg-rose-50" onClick={onRefund} data-testid={`button-order-refund-${order.id}`}>Refund</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Refund dialog — Full or a part amount, plus a reason. Server computes the
// remainder when amountCents is null; a 403 here means no refund permission.
// ═══════════════════════════════════════════════════════════════════════════
function RefundDialog({
  order, onClose, onSubmit, submitting,
}: {
  order: OrderRow;
  onClose: () => void;
  onSubmit: (amountCents: number | null, reason: string | null) => void;
  submitting: boolean;
}) {
  const remainingCents = (order.paidCents ?? order.totalCents) - order.refundedCents;
  const [mode, setMode] = useState<"full" | "part">("full");
  const [partAmount, setPartAmount] = useState(centsToDollarInput(remainingCents));
  const [reason, setReason] = useState("");

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md bg-white text-slate-900">
        <DialogHeader>
          <DialogTitle>Refund {order.ref}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{dollars(remainingCents)} available to refund.</p>
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as "full" | "part")} className="space-y-2">
            <label className="flex items-center gap-2 min-h-11">
              <RadioGroupItem value="full" id="refund-full" /> Full — {dollars(remainingCents)}
            </label>
            <label className="flex items-center gap-2 min-h-11">
              <RadioGroupItem value="part" id="refund-part" /> Part amount
            </label>
          </RadioGroup>
          {mode === "part" && (
            <MoneyInput className="h-11" value={partAmount} onChange={setPartAmount} data-testid="input-refund-amount" />
          )}
          <div>
            <Label className="text-slate-700">Reason (optional)</Label>
            <Input className="h-11 mt-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-refund-reason" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="min-h-11" onClick={onClose}>Cancel</Button>
          <Button
            className="min-h-11 gap-2"
            disabled={submitting}
            onClick={() => onSubmit(mode === "full" ? null : dollarInputToCents(partAmount || "0"), reason.trim() || null)}
            data-testid="button-refund-submit"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />} Refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Guests tab — one line per seat, inline-editable, with the door check-in.
// ═══════════════════════════════════════════════════════════════════════════
function GuestLine({ guest, onSave }: { guest: GuestRow; onSave: (patch: Record<string, unknown>) => void }) {
  const [fullName, setFullName] = useState(guest.fullName ?? "");
  const [dietary, setDietary] = useState(guest.dietary ?? "");

  return (
    <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3" data-testid={`row-guest-${guest.id}`}>
      <div className="w-14 flex-shrink-0 text-sm text-slate-400">Seat {guest.seatNo}</div>
      <Input
        className="h-11 flex-1 min-w-0"
        placeholder="Guest name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        onBlur={() => { if (fullName !== (guest.fullName ?? "")) onSave({ fullName: fullName.trim() || null }); }}
        data-testid={`input-guest-name-${guest.id}`}
      />
      <Input
        className="h-11 flex-1 min-w-0"
        placeholder="Dietary"
        value={dietary}
        onChange={(e) => setDietary(e.target.value)}
        onBlur={() => { if (dietary !== (guest.dietary ?? "")) onSave({ dietary: dietary.trim() || null }); }}
        data-testid={`input-guest-dietary-${guest.id}`}
      />
      <div className="text-xs text-slate-400 flex-shrink-0 sm:w-40 truncate">
        Booked by {guest.buyerName} · {guest.ref}
      </div>
      <Button
        variant="outline"
        className={`min-h-11 flex-shrink-0 ${guest.checkedInAt ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}`}
        onClick={() => onSave({ checkedIn: !guest.checkedInAt })}
        data-testid={`button-guest-checkin-${guest.id}`}
      >
        {guest.checkedInAt ? "Checked in ✓" : "Check in"}
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Settings — ticket type rows.
// ═══════════════════════════════════════════════════════════════════════════
function ticketTypeStatus(t: ClubEventTicketType, now: Date): string {
  if (!t.isActive) return "Inactive";
  if (typeOnSale(t, now)) return "On sale now";
  if (t.salesStart && new Date(t.salesStart).getTime() > now.getTime()) return `Opens ${nzShortDate(t.salesStart)}`;
  if (t.salesEnd && new Date(t.salesEnd).getTime() <= now.getTime()) return "Ended";
  return "Not on sale";
}

function TicketTypeRow({
  type, onSave, onDelete, saving,
}: {
  type: ClubEventTicketType;
  onSave: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(type.name);
  const [price, setPrice] = useState(centsToDollarInput(type.priceCents));
  const [salesStart, setSalesStart] = useState(type.salesStart ? nzDateIso(type.salesStart) : "");
  const [salesEnd, setSalesEnd] = useState(type.salesEnd ? nzDateIso(type.salesEnd) : "");
  const [cap, setCap] = useState(type.quantityCap != null ? String(type.quantityCap) : "");
  const [active, setActive] = useState(type.isActive);

  const status = ticketTypeStatus(type, new Date());

  return (
    <div className="px-4 py-4 space-y-3" data-testid={`row-ticket-type-${type.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-medium text-slate-700">{type.name}</span>
        <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">{status}</Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
        <Input className="h-11" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid={`input-type-name-${type.id}`} />
        <MoneyInput className="h-11" value={price} onChange={setPrice} data-testid={`input-type-price-${type.id}`} />
        <DatePickerInput value={salesStart} onChange={(e) => setSalesStart(e.target.value)} placeholder="Open-ended" className={PICKER_CLASS} data-testid={`input-type-sales-start-${type.id}`} />
        <DatePickerInput value={salesEnd} onChange={(e) => setSalesEnd(e.target.value)} placeholder="Open-ended" className={PICKER_CLASS} data-testid={`input-type-sales-end-${type.id}`} />
        <Input className="h-11" inputMode="numeric" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))} data-testid={`input-type-cap-${type.id}`} />
      </div>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 min-h-9">
          <Switch checked={active} onCheckedChange={setActive} data-testid={`switch-type-active-${type.id}`} />
          <span className="text-sm text-slate-600">Active</span>
        </label>
        <div className="flex gap-2">
          <Button
            variant="outline" className="min-h-11" disabled={saving}
            onClick={() =>
              onSave({
                name: name.trim(),
                priceCents: dollarInputToCents(price || "0"),
                salesStart: salesStart ? nzLocalToUtc(salesStart, "00:00").toISOString() : null,
                salesEnd: salesEnd ? nzLocalToUtc(salesEnd, "00:00").toISOString() : null,
                quantityCap: cap.trim() === "" ? null : Number(cap),
                isActive: active,
              })
            }
            data-testid={`button-type-save-${type.id}`}
          >
            Save
          </Button>
          <Button
            variant="outline" className="min-h-11 min-w-11 text-rose-600 border-rose-200 hover:bg-rose-50" disabled={saving}
            onClick={onDelete}
            data-testid={`button-type-delete-${type.id}`}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddTicketTypeRow({ onAdd, saving }: { onAdd: (patch: Record<string, unknown>) => void; saving: boolean }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [salesStart, setSalesStart] = useState("");
  const [salesEnd, setSalesEnd] = useState("");
  const [cap, setCap] = useState("");

  const submit = () => {
    if (!name.trim()) return;
    onAdd({
      name: name.trim(),
      priceCents: dollarInputToCents(price || "0"),
      salesStart: salesStart ? nzLocalToUtc(salesStart, "00:00").toISOString() : null,
      salesEnd: salesEnd ? nzLocalToUtc(salesEnd, "00:00").toISOString() : null,
      quantityCap: cap.trim() === "" ? null : Number(cap),
      isActive: true,
    });
    setName(""); setPrice(""); setSalesStart(""); setSalesEnd(""); setCap("");
  };

  return (
    <div className="px-4 py-4 space-y-2 bg-slate-50">
      <p className="text-[11px] uppercase tracking-wide text-slate-400">Add ticket type</p>
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
        <Input className="h-11" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-new-type-name" />
        <MoneyInput className="h-11" value={price} onChange={setPrice} data-testid="input-new-type-price" />
        <DatePickerInput value={salesStart} onChange={(e) => setSalesStart(e.target.value)} placeholder="Open-ended" className={PICKER_CLASS} data-testid="input-new-type-sales-start" />
        <DatePickerInput value={salesEnd} onChange={(e) => setSalesEnd(e.target.value)} placeholder="Open-ended" className={PICKER_CLASS} data-testid="input-new-type-sales-end" />
        <Input className="h-11" inputMode="numeric" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9]/g, ""))} data-testid="input-new-type-cap" />
      </div>
      <Button variant="outline" className="min-h-11 gap-2" disabled={saving || !name.trim()} onClick={submit} data-testid="button-new-type-add">
        <Plus className="w-4 h-4" /> Add ticket type
      </Button>
    </div>
  );
}

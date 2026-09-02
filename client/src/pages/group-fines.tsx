// ─────────────────────────────────────────────────────────────────────────────
// FINES — paid and unpaid fines, both directions, with their paperwork.
// United Sports Group workspace, locked (see server/fines-routes.ts).
//
// A fine the club owes and a fine owed to the club are one object pointing
// opposite ways, so this is one list with a direction — but the TOTALS are
// always shown separately. Netting them would produce a number that describes
// nothing and would hide an overdue council fine behind a player's unpaid one.
//
// Every status (paid / waived / overdue / due soon / unpaid) is computed
// server-side by @shared/fines and shipped down ready to render. This file
// colours and labels; it never recomputes one, so the chip and the row can
// never disagree.
//
// Hard rule inherited from @shared/fines: every date here is a calendar string
// ("2026-08-21") and is never round-tripped through `new Date()` — that bug has
// shipped twice in this codebase. `formatNzDate` splits the string. "N days"
// maths uses `today` from the API response, never the browser clock.
// ─────────────────────────────────────────────────────────────────────────────

import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents, formatCurrency } from "@/lib/format";
import {
  ReceiptText, Plus, Search, Trash2, Pencil, Paperclip, Download, Check,
  AlertTriangle, Upload, X, Car, User,
} from "lucide-react";
import {
  FINE_DIRECTIONS, FINE_CATEGORIES, FINE_ATTACHMENT_KINDS,
  DIRECTION_LABEL, DIRECTION_SENTENCE, CATEGORY_LABEL, ATTACHMENT_KIND_LABEL, STATUS_LABEL,
  daysUntil,
  type FineDirection, type FineCategory, type FineAttachmentKind, type FineStatus, type FineTotals,
} from "@shared/fines";

const LIST_KEY = ["/api/admin/fines"];

// ── Types (mirror server/fines-routes.ts) ───────────────────────────────────
interface AttachmentRow {
  id: number;
  kind: FineAttachmentKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}
interface FineRow {
  id: number;
  direction: FineDirection;
  category: FineCategory;
  reference: string | null;
  counterparty: string;
  description: string | null;
  person: { id: number; name: string } | null;
  vehicle: { id: number; plate: string; label: string } | null;
  amountCents: number;
  offenceOn: string | null;
  issuedOn: string | null;
  dueOn: string | null;
  paidOn: string | null;
  paidReference: string | null;
  waivedOn: string | null;
  waivedReason: string | null;
  notes: string | null;
  status: FineStatus;
  createdByName: string | null;
  attachments: AttachmentRow[];
}
interface ListResponse {
  fines: FineRow[];
  totals: Record<FineDirection, FineTotals>;
  today: string;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatNzDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return iso;
  return `${Number(d)} ${MONTHS_SHORT[mi]} ${y}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const STATUS_STYLES: Record<FineStatus, { color: string; bg: string; border: string }> = {
  overdue:  { color: "#f87171", bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.35)" },
  due_soon: { color: "#fbbf24", bg: "rgba(251,191,36,0.10)",  border: "rgba(251,191,36,0.35)" },
  open:     { color: "#93c5fd", bg: "rgba(147,197,253,0.08)", border: "rgba(147,197,253,0.28)" },
  waived:   { color: "#94a3b8", bg: "rgba(148,163,184,0.08)", border: "rgba(148,163,184,0.28)" },
  paid:     { color: "#4ade80", bg: "rgba(74,222,128,0.10)",  border: "rgba(74,222,128,0.32)" },
};

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40";
const selectCls = "rounded-lg bg-white/[0.04] border border-white/10 px-2 py-1 text-[11px] text-white/80 focus:outline-none focus:border-blue-500/50 cursor-pointer";
const labelCls = "text-[11px] text-white/40 mb-1 block";

function apiErrorMessage(e: unknown): string {
  const m = (e as any)?.message;
  return typeof m === "string" && m.trim() ? m : "Something went wrong";
}

// ─────────────────────────────────────────────────────────────────────────────

export default function GroupFines() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<ListResponse>({ queryKey: LIST_KEY });

  const [search, setSearch] = useState("");
  const [directionFilter, setDirectionFilter] = useState<FineDirection | "all">("all");
  const [statusFilter, setStatusFilter] = useState<FineStatus | "outstanding" | "all">("all");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<FineRow | undefined>(undefined);
  const [detail, setDetail] = useState<number | null>(null);

  const today = data?.today ?? "";
  const fines = data?.fines ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: LIST_KEY });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/fines/${id}`),
    onSuccess: () => { invalidate(); setDetail(null); toast({ title: "Fine deleted" }); },
    onError: (e: unknown) => toast({ title: "Couldn't delete it", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return fines
      .filter((f) => {
        if (directionFilter !== "all" && f.direction !== directionFilter) return false;
        if (statusFilter === "outstanding") {
          if (f.status === "paid" || f.status === "waived") return false;
        } else if (statusFilter !== "all" && f.status !== statusFilter) return false;
        if (!q) return true;
        return [f.counterparty, f.reference, f.description, f.person?.name, f.vehicle?.plate, f.notes]
          .some((v) => (v ?? "").toLowerCase().includes(q));
      })
      // Worst first, then soonest due — the point of the page is that the
      // things needing action are at the top.
      .sort((a, b) => {
        const rank: Record<FineStatus, number> = { overdue: 0, due_soon: 1, open: 2, waived: 3, paid: 4 };
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        const ad = a.dueOn ?? "9999-12-31";
        const bd = b.dueOn ?? "9999-12-31";
        return ad.localeCompare(bd);
      });
  }, [fines, search, directionFilter, statusFilter]);

  const detailFine = detail != null ? fines.find((f) => f.id === detail) ?? null : null;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ReceiptText className="w-6 h-6 text-blue-400" /> Fines
          </h1>
          <p className="text-sm text-white/45 mt-1 max-w-2xl">
            Fines the club has to pay and fines owed to the club — what's been paid, what hasn't,
            and the paperwork for each.
          </p>
        </div>
        <button
          onClick={() => { setEditing(undefined); setFormOpen(true); }}
          className="rounded-xl bg-blue-600/90 hover:bg-blue-600 px-4 py-2 text-sm font-medium flex items-center gap-2"
          data-testid="button-add-fine"
        >
          <Plus className="w-4 h-4" /> Log a fine
        </button>
      </div>

      {/* Two totals, never one. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
        {FINE_DIRECTIONS.map((d) => {
          const t = data?.totals?.[d];
          const overdue = t?.overdueCount ?? 0;
          return (
            <button
              key={d}
              onClick={() => setDirectionFilter(directionFilter === d ? "all" : d)}
              className={`text-left rounded-2xl border px-4 py-3 transition ${
                directionFilter === d ? "border-blue-500/50 bg-blue-500/[0.06]" : "border-white/10 bg-white/[0.02] hover:border-white/20"
              }`}
              data-testid={`chip-direction-${d}`}
            >
              <div className="text-[11px] uppercase tracking-wide text-white/40">{DIRECTION_SENTENCE[d]}</div>
              <div className="text-2xl font-semibold mt-1 tabular-nums">
                {formatCurrency(t?.outstandingCents ?? 0, { fromCents: true })}
              </div>
              <div className="text-[11px] text-white/40 mt-0.5">
                {t?.outstandingCount ?? 0} outstanding
                {overdue > 0 && (
                  <span className="text-red-400"> · {overdue} overdue ({formatCurrency(t?.overdueCents ?? 0, { fromCents: true })})</span>
                )}
                {(t?.paidCents ?? 0) > 0 && (
                  <span className="text-white/30"> · {formatCurrency(t?.paidCents ?? 0, { fromCents: true })} paid</span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap mt-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as any)}
          className={selectCls}
          data-testid="select-status-filter"
        >
          <option value="all">All fines</option>
          <option value="outstanding">Outstanding</option>
          <option value="overdue">Overdue</option>
          <option value="due_soon">Due soon</option>
          <option value="open">Unpaid</option>
          <option value="paid">Paid</option>
          <option value="waived">Waived</option>
        </select>
        {directionFilter !== "all" && (
          <button onClick={() => setDirectionFilter("all")} className={`${selectCls} flex items-center gap-1`}>
            {DIRECTION_LABEL[directionFilter]} <X className="w-3 h-3" />
          </button>
        )}
        <div className="relative ml-auto">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference, who, vehicle…"
            className={`${inputCls} pl-9 w-full sm:w-72`}
            data-testid="input-search-fines"
          />
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {isLoading && <div className="text-sm text-white/40 py-8 text-center">Loading…</div>}
        {!isLoading && !fines.length && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-12 text-center">
            <ReceiptText className="w-8 h-8 mx-auto text-white/15" />
            <div className="text-sm text-white/60 mt-3">No fines logged yet</div>
            <div className="text-xs text-white/35 mt-1 max-w-md mx-auto">
              When one arrives — a parking ticket, a misconduct charge — log it here and attach the
              notice. Attach the payment confirmation when it's paid.
            </div>
          </div>
        )}
        {!isLoading && fines.length > 0 && !visible.length && (
          <div className="text-sm text-white/40 py-8 text-center">Nothing matches those filters.</div>
        )}
        {visible.map((f) => (
          <FineCard key={f.id} fine={f} today={today} onOpen={() => setDetail(f.id)} />
        ))}
      </div>

      {formOpen && (
        <FineForm
          fine={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => { setFormOpen(false); invalidate(); }}
        />
      )}

      {detailFine && (
        <FineDetail
          fine={detailFine}
          today={today}
          onClose={() => setDetail(null)}
          onEdit={() => { setEditing(detailFine); setDetail(null); setFormOpen(true); }}
          onDelete={() => deleteMut.mutate(detailFine.id)}
          deleting={deleteMut.isPending}
          onChanged={invalidate}
        />
      )}
    </div>
  );
}

// ── One row ─────────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: FineStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border"
      style={{ color: s.color, background: s.bg, borderColor: s.border }}
      data-testid={`pill-status-${status}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function FineCard({ fine: f, today, onOpen }: { fine: FineRow; today: string; onOpen: () => void }) {
  const days = f.dueOn && today ? daysUntil(f.dueOn, today) : null;
  const notices = f.attachments.filter((a) => a.kind === "notice").length;
  const receipts = f.attachments.filter((a) => a.kind === "payment_confirmation").length;
  return (
    <button
      onClick={onOpen}
      className="w-full text-left rounded-2xl border border-white/10 bg-white/[0.02] hover:border-white/20 px-4 py-3 transition"
      data-testid={`card-fine-${f.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] uppercase tracking-wide text-white/35">{DIRECTION_LABEL[f.direction]}</span>
        <span className="font-semibold tabular-nums">{formatCurrency(f.amountCents, { fromCents: true })}</span>
        <StatusPill status={f.status} />
        <span className="text-[11px] text-white/30">{CATEGORY_LABEL[f.category]}</span>
        {f.reference && <span className="text-[11px] text-white/30 font-mono">#{f.reference}</span>}
      </div>
      <div className="text-sm text-white/70 mt-1">{f.counterparty}</div>
      {f.description && <div className="text-xs text-white/40 mt-0.5 line-clamp-1">{f.description}</div>}
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-white/35 mt-2">
        {f.vehicle && <span className="flex items-center gap-1"><Car className="w-3 h-3" /> {f.vehicle.plate}</span>}
        {f.person && <span className="flex items-center gap-1"><User className="w-3 h-3" /> {f.person.name}</span>}
        {f.status === "paid"
          ? <span className="text-green-400/70">Paid {formatNzDate(f.paidOn)}</span>
          : f.status === "waived"
            ? <span>Waived {formatNzDate(f.waivedOn)}</span>
            : f.dueOn
              ? (
                <span className={f.status === "overdue" ? "text-red-400" : f.status === "due_soon" ? "text-amber-400" : ""}>
                  Due {formatNzDate(f.dueOn)}
                  {days !== null && (days < 0 ? ` · ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} late` : ` · ${days} day${days === 1 ? "" : "s"}`)}
                </span>
              )
              : <span className="text-white/25">No due date recorded</span>}
        {(notices > 0 || receipts > 0) && (
          <span className="flex items-center gap-1">
            <Paperclip className="w-3 h-3" />
            {notices > 0 && `${notices} notice${notices === 1 ? "" : "s"}`}
            {notices > 0 && receipts > 0 && ", "}
            {receipts > 0 && `${receipts} receipt${receipts === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
    </button>
  );
}

// ── Create / edit ───────────────────────────────────────────────────────────

function FineForm({ fine, onClose, onSaved }: { fine?: FineRow; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const editing = !!fine;

  const [direction, setDirection] = useState<FineDirection>(fine?.direction ?? "club_owes");
  const [category, setCategory] = useState<FineCategory>(fine?.category ?? "parking");
  const [counterparty, setCounterparty] = useState(fine?.counterparty ?? "");
  const [reference, setReference] = useState(fine?.reference ?? "");
  const [description, setDescription] = useState(fine?.description ?? "");
  const [amount, setAmount] = useState(centsToDollarInput(fine?.amountCents ?? null));
  const [offenceOn, setOffenceOn] = useState(fine?.offenceOn ?? "");
  const [issuedOn, setIssuedOn] = useState(fine?.issuedOn ?? "");
  const [dueOn, setDueOn] = useState(fine?.dueOn ?? "");
  const [vehicleId, setVehicleId] = useState<string>(fine?.vehicle?.id ? String(fine.vehicle.id) : "");
  const [notes, setNotes] = useState(fine?.notes ?? "");

  const { data: vehicleData } = useQuery<{ vehicles: Array<{ id: number; plate: string; make: string; model: string; status: string }> }>({
    queryKey: ["/api/admin/vehicles"],
  });
  const vehicles = (vehicleData?.vehicles ?? []).filter((v) => v.status !== "disposed");

  // 🔴 A HINT, not an answer. The fleet register knows who held the vehicle on
  // the offence date; naming a driver is a legal assertion (in NZ the owner is
  // liable unless liability is formally transferred), so this offers and the
  // person decides. Nothing is stored unless they type it.
  const { data: hint } = useQuery<{ hint: { holderName: string; assignedOn: string } | null }>({
    queryKey: [`/api/admin/fines/driver-hint?vehicleId=${vehicleId}&on=${offenceOn}`],
    enabled: !!vehicleId && !!offenceOn,
  });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing
        ? apiRequest("PATCH", `/api/admin/fines/${fine!.id}`, body)
        : apiRequest("POST", "/api/admin/fines", body),
    onSuccess: () => { toast({ title: editing ? "Fine updated" : "Fine logged" }); onSaved(); },
    onError: (e: unknown) => toast({ title: "Couldn't save it", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const submit = () => {
    const cents = dollarInputToCents(amount);
    if (cents === null) { toast({ title: "How much is the fine?", variant: "destructive" }); return; }
    if (!counterparty.trim()) { toast({ title: direction === "club_owes" ? "Who issued it?" : "What is it for?", variant: "destructive" }); return; }
    save.mutate({
      direction, category,
      counterparty: counterparty.trim(),
      reference: reference.trim() || null,
      description: description.trim() || null,
      amountCents: cents,
      offenceOn: offenceOn || null,
      issuedOn: issuedOn || null,
      dueOn: dueOn || null,
      vehicleId: vehicleId ? Number(vehicleId) : null,
      notes: notes.trim() || null,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-[#0b0f17] border-white/10 text-white/90 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">{editing ? "Edit fine" : "Log a fine"}</h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <div>
            <label className={labelCls}>Direction</label>
            <select value={direction} onChange={(e) => setDirection(e.target.value as FineDirection)} className={inputCls} data-testid="select-direction">
              {FINE_DIRECTIONS.map((d) => <option key={d} value={d}>{DIRECTION_SENTENCE[d]}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>Type</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as FineCategory)} className={inputCls} data-testid="select-category">
              {FINE_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>{direction === "club_owes" ? "Who issued it" : "What it's for"}</label>
            <input
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder={direction === "club_owes" ? "Christchurch City Council" : "Missed training — 12 Aug"}
              className={inputCls}
              data-testid="input-counterparty"
            />
          </div>
          <div>
            <label className={labelCls}>Amount</label>
            <MoneyInput value={amount} onChange={setAmount} data-testid="input-amount" />
          </div>
          <div>
            <label className={labelCls}>Reference / notice number</label>
            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" className={inputCls} data-testid="input-reference" />
          </div>
          <div>
            <label className={labelCls}>Date of the offence</label>
            <DatePickerInput value={offenceOn} onChange={(e) => setOffenceOn(e.target.value)} className={inputCls} data-testid="input-offence-on" />
          </div>
          <div>
            <label className={labelCls}>Date issued</label>
            <DatePickerInput value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={inputCls} data-testid="input-issued-on" />
          </div>
          <div>
            <label className={labelCls}>Due</label>
            <DatePickerInput value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={inputCls} data-testid="input-due-on" />
          </div>
          <div>
            <label className={labelCls}>Vehicle</label>
            <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className={inputCls} data-testid="select-vehicle">
              <option value="">Not about a vehicle</option>
              {vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} · {v.make} {v.model}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>What happened</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className={inputCls} data-testid="input-description" />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} data-testid="input-notes" />
          </div>
        </div>

        {hint?.hint && (
          <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-xs text-amber-200/80">
            The fleet register says <span className="font-medium">{hint.hint.holderName}</span> was
            holding this vehicle on {formatNzDate(offenceOn)}. Worth checking before you transfer
            liability — the club is the registered owner until it's formally transferred.
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={submit}
            disabled={save.isPending}
            className="rounded-xl bg-blue-600/90 hover:bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-50"
            data-testid="button-save-fine"
          >
            {save.isPending ? "Saving…" : editing ? "Save" : "Log it"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Detail: payment, waiver, attachments ────────────────────────────────────

function FineDetail({
  fine: f, today, onClose, onEdit, onDelete, deleting, onChanged,
}: {
  fine: FineRow; today: string; onClose: () => void; onEdit: () => void;
  onDelete: () => void; deleting: boolean; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [paidOn, setPaidOn] = useState(f.paidOn ?? "");
  const [paidReference, setPaidReference] = useState(f.paidReference ?? "");
  const [waivedOn, setWaivedOn] = useState(f.waivedOn ?? "");
  const [waivedReason, setWaivedReason] = useState(f.waivedReason ?? "");
  const [uploadKind, setUploadKind] = useState<FineAttachmentKind>("notice");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => apiRequest("PATCH", `/api/admin/fines/${f.id}`, body),
    onSuccess: () => { onChanged(); toast({ title: "Saved" }); },
    onError: (e: unknown) => toast({ title: "Couldn't save it", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const removeAttachment = useMutation({
    mutationFn: (aid: number) => apiRequest("DELETE", `/api/admin/fines/${f.id}/attachments/${aid}`),
    onSuccess: () => { onChanged(); toast({ title: "Attachment deleted" }); },
    onError: (e: unknown) => toast({ title: "Couldn't delete it", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // Uploads go as multipart, so this is a raw fetch rather than apiRequest —
  // setting a JSON content-type here would break the multipart boundary.
  const doUpload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("kind", uploadKind);
      const res = await fetch(`/api/admin/fines/${f.id}/attachments`, {
        method: "POST",
        body,
        credentials: "include",
        headers: { "X-Workspace-Slug": localStorage.getItem("clubos_workspace") || "united-sports-group" },
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        throw new Error(msg?.message || `Upload failed (${res.status})`);
      }
      onChanged();
      toast({ title: "Attached" });
    } catch (e) {
      toast({ title: "Couldn't attach that", description: apiErrorMessage(e), variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const notices = f.attachments.filter((a) => a.kind !== "payment_confirmation");
  const receipts = f.attachments.filter((a) => a.kind === "payment_confirmation");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl bg-[#0b0f17] border-white/10 text-white/90 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-2xl font-semibold tabular-nums">{formatCurrency(f.amountCents, { fromCents: true })}</span>
              <StatusPill status={f.status} />
            </div>
            <div className="text-sm text-white/60 mt-1">{DIRECTION_SENTENCE[f.direction]} · {CATEGORY_LABEL[f.category]}</div>
            <div className="text-sm text-white/80 mt-1">{f.counterparty}</div>
            {f.reference && <div className="text-xs text-white/35 font-mono mt-0.5">#{f.reference}</div>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onEdit} className="p-2 rounded-lg hover:bg-white/5 text-white/40 hover:text-white/80" title="Edit" data-testid="button-edit-fine">
              <Pencil className="w-4 h-4" />
            </button>
            <button
              onClick={onDelete}
              disabled={deleting}
              className="p-2 rounded-lg hover:bg-red-500/10 text-white/40 hover:text-red-400 disabled:opacity-40"
              title="Delete"
              data-testid="button-delete-fine"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {f.description && <div className="text-sm text-white/60 mt-3">{f.description}</div>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 text-xs">
          <Field label="Offence" value={formatNzDate(f.offenceOn)} />
          <Field label="Issued" value={formatNzDate(f.issuedOn)} />
          <Field label="Due" value={formatNzDate(f.dueOn)} />
          <Field label="Vehicle" value={f.vehicle?.plate ?? "—"} />
        </div>
        {f.person && <div className="text-xs text-white/50 mt-2">Person: {f.person.name}</div>}
        {f.notes && <div className="text-xs text-white/45 mt-2 whitespace-pre-wrap">{f.notes}</div>}

        {/* ── Payment ─────────────────────────────────────────────────────── */}
        <div className="mt-5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="text-[11px] uppercase tracking-wide text-white/40 mb-2">Payment</div>
          {f.waivedOn ? (
            <div className="text-xs text-white/50">
              Waived {formatNzDate(f.waivedOn)}{f.waivedReason ? ` — ${f.waivedReason}` : ""}.
              <button
                onClick={() => patch.mutate({ waivedOn: null, waivedReason: null })}
                className="ml-2 text-blue-400 hover:underline"
                data-testid="button-unwaive"
              >
                Undo
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
              <div>
                <label className={labelCls}>Paid on</label>
                <DatePickerInput value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={inputCls} data-testid="input-paid-on" />
              </div>
              <div>
                <label className={labelCls}>Payment reference</label>
                <input value={paidReference} onChange={(e) => setPaidReference(e.target.value)} placeholder="Optional" className={inputCls} data-testid="input-paid-reference" />
              </div>
              <button
                onClick={() => patch.mutate({ paidOn: paidOn || null, paidReference: paidReference.trim() || null })}
                disabled={patch.isPending}
                className="rounded-xl bg-green-600/80 hover:bg-green-600 px-4 py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                data-testid="button-mark-paid"
              >
                <Check className="w-4 h-4" /> {f.paidOn ? "Update" : "Mark paid"}
              </button>
            </div>
          )}
          {!f.paidOn && !f.waivedOn && (
            <details className="mt-3">
              <summary className="text-[11px] text-white/35 cursor-pointer hover:text-white/60">
                Challenged or written off instead?
              </summary>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end mt-2">
                <div>
                  <label className={labelCls}>Waived on</label>
                  <DatePickerInput value={waivedOn} onChange={(e) => setWaivedOn(e.target.value)} className={inputCls} data-testid="input-waived-on" />
                </div>
                <div>
                  <label className={labelCls}>Why</label>
                  <input value={waivedReason} onChange={(e) => setWaivedReason(e.target.value)} placeholder="Challenge upheld" className={inputCls} data-testid="input-waived-reason" />
                </div>
                <button
                  onClick={() => patch.mutate({ waivedOn: waivedOn || null, waivedReason: waivedReason.trim() || null })}
                  disabled={patch.isPending || !waivedOn}
                  className="rounded-xl bg-white/10 hover:bg-white/15 px-4 py-2 text-sm disabled:opacity-40"
                  data-testid="button-waive"
                >
                  Waive it
                </button>
              </div>
            </details>
          )}
          {f.paidOn && (
            <div className="text-[11px] text-white/35 mt-2">
              Paid {formatNzDate(f.paidOn)}{f.paidReference ? ` · ${f.paidReference}` : ""}
              <button onClick={() => patch.mutate({ paidOn: null, paidReference: null })} className="ml-2 text-blue-400 hover:underline" data-testid="button-unpay">
                Clear
              </button>
            </div>
          )}
        </div>

        {/* ── Attachments ─────────────────────────────────────────────────── */}
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-[11px] uppercase tracking-wide text-white/40">Paperwork</div>
            <div className="flex items-center gap-2">
              <select value={uploadKind} onChange={(e) => setUploadKind(e.target.value as FineAttachmentKind)} className={selectCls} data-testid="select-attachment-kind">
                {FINE_ATTACHMENT_KINDS.map((k) => <option key={k} value={k}>{ATTACHMENT_KIND_LABEL[k]}</option>)}
              </select>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => { const file = e.target.files?.[0]; if (file) doUpload(file); }}
                data-testid="input-attachment-file"
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="rounded-lg bg-white/10 hover:bg-white/15 px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-40"
                data-testid="button-upload-attachment"
              >
                <Upload className="w-3.5 h-3.5" /> {uploading ? "Uploading…" : "Attach"}
              </button>
            </div>
          </div>

          <AttachmentList
            title="The fine"
            items={notices}
            fineId={f.id}
            onDelete={(id) => removeAttachment.mutate(id)}
            empty="No notice attached yet."
          />
          <AttachmentList
            title="Payment confirmation"
            items={receipts}
            fineId={f.id}
            onDelete={(id) => removeAttachment.mutate(id)}
            empty={f.paidOn ? "Marked paid, but no confirmation attached." : "Nothing yet."}
            warn={!!f.paidOn && receipts.length === 0}
          />
        </div>

        {f.createdByName && (
          <div className="text-[11px] text-white/25 mt-3">Logged by {f.createdByName}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AttachmentList({
  title, items, fineId, onDelete, empty, warn,
}: {
  title: string; items: AttachmentRow[]; fineId: number;
  onDelete: (id: number) => void; empty: string; warn?: boolean;
}) {
  return (
    <div className="mt-3">
      <div className="text-[11px] text-white/35 mb-1.5">{title}</div>
      {!items.length && (
        <div className={`text-[11px] ${warn ? "text-amber-400/80 flex items-center gap-1" : "text-white/25"}`}>
          {warn && <AlertTriangle className="w-3 h-3" />}{empty}
        </div>
      )}
      <div className="space-y-1.5">
        {items.map((a) => (
          <div key={a.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-1.5">
            <Paperclip className="w-3.5 h-3.5 text-white/30 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-white/75 truncate">{a.filename}</div>
              <div className="text-[10px] text-white/30">
                {ATTACHMENT_KIND_LABEL[a.kind]} · {formatBytes(a.sizeBytes)}
              </div>
            </div>
            {/* A plain link, opened in a new tab — the endpoint redirects to a
                short-lived signed URL, so nothing durable is ever in the DOM. */}
            <a
              href={`/api/admin/fines/${fineId}/attachments/${a.id}?download=1`}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-lg hover:bg-white/5 text-white/40 hover:text-white/80 shrink-0"
              title="Download"
              data-testid={`link-attachment-${a.id}`}
            >
              <Download className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={() => onDelete(a.id)}
              className="p-1.5 rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 shrink-0"
              title="Delete"
              data-testid={`button-delete-attachment-${a.id}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/30">{label}</div>
      <div className="text-white/70 mt-0.5">{value}</div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatCurrency, dollarInputToCents, centsToDollarInput } from "@/lib/format";
import {
  Receipt, Plus, Copy, Send, Ban, CircleDollarSign, Clock, Eye,
  CheckCircle2, FileText, MailWarning, Trash2,
} from "lucide-react";

const INVOICE_SITE_BASE = "https://usg-invoices.vercel.app";

// ── Types (mirror server/invoice-routes.ts + shared/invoice-types.ts) ───────
interface AdminInvoice {
  id: number;
  token: string;
  number: string;
  status: "draft" | "sent" | "paid" | "void";
  derivedStatus: "draft" | "sent" | "overdue" | "paid" | "void";
  brand: string;
  recipientName: string;
  recipientEmail: string | null;
  title: string;
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  issuedOn: string;
  dueOn: string;
  cardEnabled: boolean;
  isDraft: boolean;
  paidAt: string | null;
  paidAmountCents: number | null;
  paidMethod: string | null;
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  reminderCount: number;
  createdAt: string;
}
interface InvoiceEvent {
  id: number;
  invoiceId: number;
  kind: string;
  at: string;
  isStaff: boolean;
  meta: any;
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#94a3b8" },
  sent: { label: "Awaiting payment", color: "#c59949" },
  overdue: { label: "Overdue", color: "#ef4444" },
  paid: { label: "Paid", color: "#22c55e" },
  void: { label: "Void", color: "#6b7280" },
};

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {label}
    </span>
  );
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50";

export default function GroupInvoices() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidAmount, setMarkPaidAmount] = useState("");

  const { data, isLoading } = useQuery<{ invoices: AdminInvoice[] }>({ queryKey: ["/api/admin/invoices"] });
  const invoices = data?.invoices ?? [];

  const { data: detail } = useQuery<{ invoice: AdminInvoice; timeline: InvoiceEvent[] }>({
    queryKey: ["/api/admin/invoices", selectedId],
    enabled: selectedId != null,
  });

  const totals = useMemo(() => {
    const outstanding = invoices.filter((i) => i.derivedStatus === "sent" || i.derivedStatus === "overdue");
    const overdue = invoices.filter((i) => i.derivedStatus === "overdue");
    const now = new Date();
    const paidThisMonth = invoices.filter(
      (i) => i.status === "paid" && i.paidAt && new Date(i.paidAt).getMonth() === now.getMonth() && new Date(i.paidAt).getFullYear() === now.getFullYear(),
    );
    return {
      outstandingCents: outstanding.reduce((s, i) => s + i.totalCents, 0),
      overdueCents: overdue.reduce((s, i) => s + i.totalCents, 0),
      paidThisMonthCents: paidThisMonth.reduce((s, i) => s + (i.paidAmountCents ?? i.totalCents), 0),
      awaitingCount: outstanding.length,
    };
  }, [invoices]);

  const sendMut = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/invoices/${id}/send`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
      toast({ title: "Sent" });
    },
    onError: (e: any) => toast({ title: "Couldn't send", description: e.message, variant: "destructive" }),
  });

  const reminderMut = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/invoices/${id}/reminder`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices", selectedId] });
      toast({ title: "Reminder sent" });
    },
    onError: (e: any) => toast({ title: "Couldn't send reminder", description: e.message, variant: "destructive" }),
  });

  const markPaidMut = useMutation({
    mutationFn: ({ id, amountCents }: { id: number; amountCents: number }) =>
      apiRequest("POST", `/api/admin/invoices/${id}/mark-paid`, { method: "bank", amountCents }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices", selectedId] });
      setMarkPaidOpen(false);
      setMarkPaidAmount("");
      toast({ title: "Marked paid" });
    },
    onError: (e: any) => toast({ title: "Couldn't mark paid", description: e.message, variant: "destructive" }),
  });

  const voidMut = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/invoices/${id}/void`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices", selectedId] });
      toast({ title: "Voided" });
    },
    onError: (e: any) => toast({ title: "Couldn't void", description: e.message, variant: "destructive" }),
  });

  const copyLink = (token: string) => {
    navigator.clipboard.writeText(`${INVOICE_SITE_BASE}/i/${token}`);
    toast({ title: "Link copied" });
  };

  const selectedInvoice = detail?.invoice;
  const locked = selectedInvoice?.status === "paid" || selectedInvoice?.status === "void";

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="w-5 h-5 text-amber-400" /> Invoices
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Tracked, payable invoices for United Sports Group — sent as a link, tracked when opened, reconciled when paid.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          data-testid="button-new-invoice"
          className="inline-flex items-center gap-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 px-4 py-2 text-sm font-medium hover:bg-amber-500/25 transition-colors"
        >
          <Plus className="w-4 h-4" /> New invoice
        </button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
        <Tile label="Outstanding" value={formatCurrency(totals.outstandingCents, { fromCents: true })} />
        <Tile label="Overdue" value={formatCurrency(totals.overdueCents, { fromCents: true })} accent="#ef4444" />
        <Tile label="Paid this month" value={formatCurrency(totals.paidThisMonthCents, { fromCents: true })} accent="#22c55e" />
        <Tile label="Awaiting payment" value={String(totals.awaitingCount)} />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : invoices.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <FileText className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">No invoices yet.</div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-white/35 border-b border-white/[0.06]">
                  <th className="px-4 py-2.5 font-medium">Number</th>
                  <th className="px-4 py-2.5 font-medium">Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Issued</th>
                  <th className="px-4 py-2.5 font-medium">Due</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Opens</th>
                  <th className="px-4 py-2.5 font-medium">Last opened</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const sc = STATUS_STYLE[inv.derivedStatus] ?? STATUS_STYLE.draft;
                  return (
                    <tr
                      key={inv.id}
                      onClick={() => setSelectedId(inv.id)}
                      data-testid={`row-invoice-${inv.id}`}
                      className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-2.5 font-mono text-[13px]">{inv.number}</td>
                      <td className="px-4 py-2.5">{inv.recipientName}</td>
                      <td className="px-4 py-2.5 font-medium">{formatCurrency(inv.totalCents, { fromCents: true })}</td>
                      <td className="px-4 py-2.5 text-white/50">{fmtDate(inv.issuedOn)}</td>
                      <td className="px-4 py-2.5 text-white/50">{fmtDate(inv.dueOn)}</td>
                      <td className="px-4 py-2.5"><Badge label={sc.label} color={sc.color} /></td>
                      <td className="px-4 py-2.5 text-white/50">{inv.openCount}</td>
                      <td className="px-4 py-2.5 text-white/50">{fmtDateTime(inv.lastOpenedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={selectedId != null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <DialogContent className="max-w-xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
          {selectedInvoice && (
            <div>
              <div className="flex items-start justify-between gap-3 mb-1">
                <div>
                  <h2 className="text-base font-semibold font-mono">{selectedInvoice.number}</h2>
                  <p className="text-[13px] text-white/50 mt-0.5">{selectedInvoice.title}</p>
                </div>
                <Badge
                  label={(STATUS_STYLE[selectedInvoice.derivedStatus] ?? STATUS_STYLE.draft).label}
                  color={(STATUS_STYLE[selectedInvoice.derivedStatus] ?? STATUS_STYLE.draft).color}
                />
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4 text-[13px]">
                <div>
                  <div className="text-white/35 text-[11px] uppercase tracking-wide">Recipient</div>
                  <div className="mt-0.5">{selectedInvoice.recipientName}</div>
                  <div className="text-white/40">{selectedInvoice.recipientEmail ?? "—"}</div>
                </div>
                <div>
                  <div className="text-white/35 text-[11px] uppercase tracking-wide">Amount</div>
                  <div className="mt-0.5 font-semibold">{formatCurrency(selectedInvoice.totalCents, { fromCents: true })}</div>
                  <div className="text-white/40">
                    {formatCurrency(selectedInvoice.subtotalCents, { fromCents: true })} + {formatCurrency(selectedInvoice.gstCents, { fromCents: true })} GST
                  </div>
                </div>
                <div>
                  <div className="text-white/35 text-[11px] uppercase tracking-wide">Issued / due</div>
                  <div className="mt-0.5">{fmtDate(selectedInvoice.issuedOn)} → {fmtDate(selectedInvoice.dueOn)}</div>
                </div>
                <div>
                  <div className="text-white/35 text-[11px] uppercase tracking-wide">Card payments</div>
                  <div className="mt-0.5">{selectedInvoice.cardEnabled ? "Enabled" : "Off — bank transfer only"}</div>
                </div>
              </div>

              {/* Tracked link */}
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2">
                <span className="text-[12px] font-mono text-white/60 truncate flex-1">
                  {INVOICE_SITE_BASE}/i/{selectedInvoice.token}
                </span>
                <button
                  onClick={() => copyLink(selectedInvoice.token)}
                  data-testid="button-copy-link"
                  className="inline-flex items-center gap-1 text-[12px] text-blue-300 hover:text-blue-200 shrink-0"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2 mt-4">
                <button
                  onClick={() => sendMut.mutate(selectedInvoice.id)}
                  disabled={sendMut.isPending || locked}
                  data-testid="button-send"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 px-3 py-1.5 text-[12px] font-medium hover:bg-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-3.5 h-3.5" /> {selectedInvoice.status === "draft" ? "Send" : "Re-send"}
                </button>
                <button
                  onClick={() => reminderMut.mutate(selectedInvoice.id)}
                  disabled={reminderMut.isPending || locked}
                  data-testid="button-reminder"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 px-3 py-1.5 text-[12px] font-medium hover:bg-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <MailWarning className="w-3.5 h-3.5" /> Send reminder
                </button>
                <button
                  onClick={() => setMarkPaidOpen(true)}
                  disabled={locked}
                  data-testid="button-mark-paid"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <CircleDollarSign className="w-3.5 h-3.5" /> Mark paid (bank transfer)
                </button>
                <button
                  onClick={() => { if (confirm("Void this invoice?")) voidMut.mutate(selectedInvoice.id); }}
                  disabled={voidMut.isPending || selectedInvoice.status === "paid" || selectedInvoice.status === "void"}
                  data-testid="button-void"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/50 px-3 py-1.5 text-[12px] font-medium hover:text-red-300 hover:border-red-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <Ban className="w-3.5 h-3.5" /> Void
                </button>
              </div>

              {/* Timeline */}
              <div className="mt-5">
                <div className="text-white/35 text-[11px] uppercase tracking-wide mb-2">Timeline</div>
                <div className="space-y-1.5">
                  {(detail?.timeline ?? []).map((ev) => (
                    <div key={ev.id} className="flex items-center gap-2 text-[12px] text-white/60">
                      <TimelineIcon kind={ev.kind} />
                      <span className="capitalize">{ev.kind.replace(/_/g, " ")}</span>
                      {ev.isStaff && <span className="text-white/30">(staff)</span>}
                      <span className="text-white/30 ml-auto">{fmtDateTime(ev.at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Mark paid dialog */}
      <Dialog open={markPaidOpen} onOpenChange={setMarkPaidOpen}>
        <DialogContent className="max-w-sm bg-[#0a0f1a] border border-white/10 text-white/90">
          <h2 className="text-base font-semibold mb-3">Mark paid — bank transfer</h2>
          <label className="text-[11px] text-white/40 mb-1 block">Amount received ($)</label>
          <input
            value={markPaidAmount}
            onChange={(e) => setMarkPaidAmount(e.target.value)}
            placeholder={selectedInvoice ? centsToDollarInput(selectedInvoice.totalCents) : "0.00"}
            data-testid="input-mark-paid-amount"
            className={inputCls}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-4">
            <button onClick={() => setMarkPaidOpen(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
            <button
              onClick={() => {
                if (!selectedInvoice) return;
                const amountCents = dollarInputToCents(markPaidAmount || centsToDollarInput(selectedInvoice.totalCents));
                markPaidMut.mutate({ id: selectedInvoice.id, amountCents });
              }}
              disabled={markPaidMut.isPending}
              data-testid="button-confirm-mark-paid"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 px-4 py-2 text-sm font-medium hover:bg-emerald-500/30 disabled:opacity-50 transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" /> {markPaidMut.isPending ? "Saving…" : "Confirm"}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {showCreate && <CreateInvoiceDialog open={showCreate} onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div className="text-[10px] font-medium text-white/40 uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold mt-0.5" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}

function TimelineIcon({ kind }: { kind: string }) {
  const cls = "w-3.5 h-3.5 shrink-0";
  if (kind === "paid") return <CheckCircle2 className={cls + " text-emerald-400"} />;
  if (kind === "voided") return <Ban className={cls + " text-white/40"} />;
  if (kind === "sent") return <Send className={cls + " text-blue-400"} />;
  if (kind === "reminder_sent") return <MailWarning className={cls + " text-amber-400"} />;
  if (kind === "opened") return <Eye className={cls + " text-white/50"} />;
  return <Clock className={cls + " text-white/30"} />;
}

// ── New invoice ──────────────────────────────────────────────────────────
interface LineRow { description: string; detail: string; amount: string }

function CreateInvoiceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [number, setNumber] = useState("");
  const [brand, setBrand] = useState<"siu" | "cufc">("siu");
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueOn, setDueOn] = useState("");
  const [termsLabel, setTermsLabel] = useState("Payment due within 7 days of invoice date");
  const [gstTreatment, setGstTreatment] = useState<"inclusive" | "exclusive">("inclusive");
  const [lines, setLines] = useState<LineRow[]>([{ description: "", detail: "", amount: "" }]);
  const [bankAccountName, setBankAccountName] = useState("Christchurch United Football Club Incorporated");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankReference, setBankReference] = useState("");

  const createMut = useMutation({
    mutationFn: (body: any) => apiRequest("POST", "/api/admin/invoices", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/invoices"] });
      toast({ title: "Invoice created" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't create invoice", description: e.message, variant: "destructive" }),
  });

  const submit = () => {
    if (!number.trim() || !recipientName.trim() || !title.trim() || !issuedOn || !dueOn) {
      toast({ title: "Fill in number, recipient, title, issued and due dates", variant: "destructive" });
      return;
    }
    const cleanLines = lines
      .filter((l) => l.description.trim() && l.amount)
      .map((l) => ({ description: l.description.trim(), detail: l.detail.trim() || undefined, amountCents: dollarInputToCents(l.amount) }));
    if (cleanLines.length === 0) {
      toast({ title: "Add at least one line item", variant: "destructive" });
      return;
    }
    createMut.mutate({
      number: number.trim(),
      brand,
      recipientName: recipientName.trim(),
      recipientEmail: recipientEmail.trim() || undefined,
      title: title.trim(),
      intro: intro.trim() || undefined,
      issuedOn,
      dueOn,
      termsLabel: termsLabel.trim() || undefined,
      gstTreatment,
      lines: cleanLines,
      bankAccountName: bankAccountName.trim() || undefined,
      bankAccountNumber: bankAccountNumber.trim() || undefined,
      bankReference: bankReference.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold mb-1">New invoice</h2>
        <p className="text-[12px] text-white/40 mb-3">Created as a draft — nothing is sent until you hit Send.</p>

        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Invoice number *</label>
              <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="CUFC-2026-003" data-testid="input-number" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Brand</label>
              <select value={brand} onChange={(e) => setBrand(e.target.value as "siu" | "cufc")} data-testid="select-brand" className={inputCls + " cursor-pointer"}>
                <option value="siu">South Island United</option>
                <option value="cufc">Christchurch United</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Recipient name *</label>
              <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} data-testid="input-recipient-name" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Recipient email</label>
              <input value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} type="email" data-testid="input-recipient-email" className={inputCls} />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Title *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Partnership rebate" data-testid="input-title" className={inputCls} />
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Intro (optional)</label>
            <textarea value={intro} onChange={(e) => setIntro(e.target.value)} data-testid="input-intro" className={inputCls + " min-h-[60px]"} />
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Issued *</label>
              <input value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} type="date" data-testid="input-issued-on" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Due *</label>
              <input value={dueOn} onChange={(e) => setDueOn(e.target.value)} type="date" data-testid="input-due-on" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">GST treatment</label>
              <select value={gstTreatment} onChange={(e) => setGstTreatment(e.target.value as "inclusive" | "exclusive")} data-testid="select-gst-treatment" className={inputCls + " cursor-pointer"}>
                <option value="inclusive">Inclusive</option>
                <option value="exclusive">Exclusive</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Terms label</label>
            <input value={termsLabel} onChange={(e) => setTermsLabel(e.target.value)} data-testid="input-terms-label" className={inputCls} />
          </div>

          {/* Line items */}
          <div>
            <label className="text-[11px] text-white/40 mb-1 block">Line items *</label>
            <div className="space-y-2">
              {lines.map((line, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <input
                    value={line.description}
                    onChange={(e) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)))}
                    placeholder="Description"
                    data-testid={`input-line-description-${idx}`}
                    className={inputCls + " flex-1"}
                  />
                  <input
                    value={line.amount}
                    onChange={(e) => setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, amount: e.target.value } : l)))}
                    placeholder="0.00"
                    data-testid={`input-line-amount-${idx}`}
                    className={inputCls + " w-28"}
                  />
                  <button
                    onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                    disabled={lines.length === 1}
                    className="text-white/25 hover:text-red-400 disabled:opacity-30 mt-2"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => setLines((ls) => [...ls, { description: "", detail: "", amount: "" }])}
              data-testid="button-add-line"
              className="text-[12px] text-blue-400 hover:underline mt-2"
            >
              + Add line
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2.5">
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Bank account name</label>
              <input value={bankAccountName} onChange={(e) => setBankAccountName(e.target.value)} data-testid="input-bank-name" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Account number</label>
              <input value={bankAccountNumber} onChange={(e) => setBankAccountNumber(e.target.value)} data-testid="input-bank-account" className={inputCls} />
            </div>
            <div>
              <label className="text-[11px] text-white/40 mb-1 block">Reference</label>
              <input value={bankReference} onChange={(e) => setBankReference(e.target.value)} data-testid="input-bank-reference" className={inputCls} />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">Cancel</button>
          <button
            onClick={submit}
            disabled={createMut.isPending}
            data-testid="button-submit-invoice"
            className="inline-flex items-center gap-2 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-200 px-4 py-2 text-sm font-medium hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
          >
            {createMut.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

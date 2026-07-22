// ─────────────────────────────────────────────────────────────────────────────
// QUOTES — the "Quotes" tab in the United Prints workspace of ClubOS.
//
// Indicative quotes submitted from the unitedprints.co.nz "Instant Quote" page,
// waiting on the Print manager (Dima) to Approve or Reject. Approve materialises
// the quote into a real print_orders row (+ items + a 'created' event) and it
// shows up in the existing Orders tab; Reject just closes it out.
//
// House style copied from group-hiring.tsx / feedback.tsx (stat chips that
// double as filters, dark-glass Tailwind, apiRequest/queryClient wired to the
// X-Workspace-Slug header automatically via localStorage — no explicit header
// wiring needed here).
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Receipt, Check, X, Clock, Mail, Phone, FileText } from "lucide-react";

// ── Types (mirror server/print-quote-routes.ts response shapes) ────────────
interface PrintQuoteItem {
  id: number;
  quoteId: number;
  designName: string | null;
  material: string | null;
  sizeLabel: string | null;
  areaM2: string | null;
  quantity: number;
  lineExGstCents: number;
  designFileName: string | null;
}

interface PrintQuote {
  id: number;
  organizationId: number;
  token: string;
  status: "new" | "approved" | "rejected";
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  source: string | null;
  sourceUrl: string | null;
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
  indicative: boolean;
  note: string | null;
  reviewedBy: number | null;
  decidedAt: string | null;
  rejectedReason: string | null;
  promotedOrderId: number | null;
  createdAt: string;
  items: PrintQuoteItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
};

function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "Something went wrong");
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw;
}

const STATUS_META: Record<PrintQuote["status"], { label: string; color: string }> = {
  new: { label: "New", color: "#3b82f6" },
  approved: { label: "Approved", color: "#22c55e" },
  rejected: { label: "Rejected", color: "#ef4444" },
};

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${color}22`, color, border: `1px solid ${color}55` }}
    >
      {label}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function PrintsQuotes() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<"new" | "approved" | "rejected">("new");

  const { data, isLoading } = useQuery<{ quotes: PrintQuote[] }>({
    queryKey: ["/api/admin/print-quotes"],
  });
  const quotes = data?.quotes ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/print-quotes"] });

  const patchMut = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
      apiRequest("PATCH", `/api/admin/print-quotes/${id}`, body),
    onSuccess: (_data, variables) => {
      invalidate();
      toast({
        title: variables.action === "approve" ? "Approved — moved to Orders / production" : "Quote rejected",
      });
    },
    onError: (e: unknown) => toast({ title: "Couldn't update quote", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { new: 0, approved: 0, rejected: 0 };
    for (const q of quotes) c[q.status] = (c[q.status] || 0) + 1;
    return c;
  }, [quotes]);

  const filtered = useMemo(() => quotes.filter((q) => q.status === statusFilter), [quotes, statusFilter]);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Receipt className="w-5 h-5 text-blue-400" /> Quotes
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Indicative quotes submitted from the Instant Quote page on unitedprints.co.nz. Approve to move
            a quote into Orders / production, or reject it.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200/90 mb-4">
        These totals are indicative pricing from the customer's self-serve builder, not a confirmed
        quote — check the numbers before approving.
      </div>

      {/* stat chips — filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(["new", "approved", "rejected"] as const).map((st) => {
          const meta = STATUS_META[st];
          const active = statusFilter === st;
          return (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              data-testid={`filter-status-${st}`}
              className="rounded-xl border px-3 py-2 text-left transition-colors"
              style={{
                borderColor: active ? `${meta.color}88` : "rgba(255,255,255,0.06)",
                background: active ? `${meta.color}18` : "rgba(255,255,255,0.02)",
              }}
            >
              <div className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</div>
              <div className="text-lg font-semibold mt-0.5">{counts[st] || 0}</div>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <Receipt className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">
            {statusFilter === "new" ? "No new quotes waiting on review." : `No ${statusFilter} quotes.`}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((q) => (
            <QuoteCard
              key={q.id}
              quote={q}
              busy={patchMut.isPending}
              onApprove={() => patchMut.mutate({ id: q.id, action: "approve" })}
              onReject={() => {
                const reason = window.prompt("Reason for rejecting this quote? (optional)") ?? undefined;
                patchMut.mutate({ id: q.id, action: "reject", reason });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuoteCard({ quote, busy, onApprove, onReject }: {
  quote: PrintQuote;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const meta = STATUS_META[quote.status];
  return (
    <div data-testid={`card-quote-${quote.id}`} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-medium text-[14px] text-white/90">{quote.customerName || "Unknown customer"}</span>
            <Pill label={meta.label} color={meta.color} />
            {quote.indicative && <Pill label="Indicative" color="#eab308" />}
          </div>
          <div className="flex items-center gap-3 flex-wrap text-[12px] text-white/45">
            {quote.customerEmail && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{quote.customerEmail}</span>}
            {quote.customerPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{quote.customerPhone}</span>}
            <span className="flex items-center gap-1 text-white/30"><Clock className="w-3 h-3" />{fmtRelative(quote.createdAt)}</span>
            {quote.source && <span className="text-white/30">· {quote.source}</span>}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-lg font-semibold text-white/90">{money(quote.totalCents)}</div>
          <div className="text-[11px] text-white/35">incl GST</div>
        </div>
      </div>

      <div className="mt-3 border-t border-white/[0.06] pt-3 space-y-1.5">
        {quote.items.map((it) => (
          <div key={it.id} className="flex items-center justify-between text-[13px] text-white/70">
            <span className="flex items-center gap-1.5 min-w-0 truncate">
              <FileText className="w-3.5 h-3.5 text-white/25 shrink-0" />
              <span className="truncate">
                {it.designName || "Untitled"}{it.material ? ` · ${it.material}` : ""}{it.sizeLabel ? ` · ${it.sizeLabel}` : ""}
              </span>
            </span>
            <span className="shrink-0 flex items-center gap-3 text-white/50">
              <span>×{it.quantity}</span>
              <span className="font-medium text-white/80">{money(it.lineExGstCents)}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-3 text-[12px]">
        <div className="text-white/40 space-x-3">
          <span>Subtotal {money(quote.subtotalCents)}</span>
          <span>GST {money(quote.gstCents)}</span>
        </div>

        {quote.status === "new" ? (
          <div className="flex items-center gap-2">
            <button
              onClick={onReject}
              disabled={busy}
              data-testid={`button-reject-${quote.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/60 px-3 py-1.5 text-[12px] font-medium hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/30 transition-colors disabled:opacity-40"
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              data-testid={`button-approve-${quote.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-500/25 transition-colors disabled:opacity-40"
            >
              <Check className="w-3.5 h-3.5" /> Approve
            </button>
          </div>
        ) : quote.status === "approved" ? (
          <span className="text-emerald-300/80 text-[12px]">
            {quote.promotedOrderId ? `→ Order #${quote.promotedOrderId}` : "Moved to Orders"}
          </span>
        ) : (
          <span className="text-white/30 text-[12px]">{quote.rejectedReason || "Rejected"}</span>
        )}
      </div>
    </div>
  );
}

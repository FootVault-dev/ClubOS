// Expenses — every purchase the print shop makes, with its invoice attached.
//
// 🔴 GST is stated, not assumed. Four treatments, because a real supplier
// invoice is any of them: GST-inclusive, plus-GST, zero-rated, or overseas with
// no GST at all. The form does the arithmetic Dima asks for and shows him the
// result before he saves — it never picks a rate on his behalf, because an
// invented GST figure is a wrong claim, not a rounding error.

import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, X, Trash2, Paperclip, FileText, Receipt, TrendingDown, Filter, Download,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";

type Expense = {
  id: number; category: string; supplier: string | null; description: string;
  reference: string | null; totalCents: number; gstCents: number; netCents: number;
  gstTreatment: string; spentOn: string; paidWith: string | null;
  invoiceFileName: string | null; invoiceMime: string | null; hasInvoice: boolean;
  notes: string | null; createdByName: string | null;
};
type Payload = {
  expenses: Expense[];
  totals: { count: number; totalCents: number; gstCents: number; netCents: number };
  byCategory: Record<string, { totalCents: number; gstCents: number; count: number }>;
  byMonth: Record<string, number>;
  vocab: { categories: string[]; treatments: string[]; paidWith: string[] };
};

const CAT_LABEL: Record<string, string> = {
  merchandise: "Merchandise", materials: "Materials", equipment: "Equipment / printers",
  services: "Services", freight: "Freight / courier", software: "Software", other: "Other",
};
const TREAT_LABEL: Record<string, string> = {
  inclusive: "Price includes GST",
  plus_gst: "Price is plus GST",
  zero_rated: "Zero-rated (no GST)",
  overseas_no_gst: "Overseas — no NZ GST",
};
const PAID_LABEL: Record<string, string> = {
  card: "Card", eftpos: "EFTPOS", bank_transfer: "Bank transfer", cash: "Cash",
  account: "On account", other: "Other",
};

const money = (c: number) => `$${(c / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Bare ISO date → "12 Aug 2026". Never through a JS Date. */
function niceDate(d: string): string {
  const [y, m, day] = String(d).slice(0, 10).split("-");
  if (!y || !m || !day) return d;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(day)} ${months[Number(m) - 1]} ${y}`;
}
/** Today in NZ, as a bare ISO date — not toISOString(), which is a day behind. */
function nzToday(): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "01";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const NZ_GST = 0.15;

function ExpenseModal({ existing, vocab, onClose }: { existing: Expense | null; vocab: Payload["vocab"]; onClose: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({
    category: existing?.category ?? "materials",
    supplier: existing?.supplier ?? "",
    description: existing?.description ?? "",
    reference: existing?.reference ?? "",
    amount: existing ? centsToDollarInput(existing.gstTreatment === "plus_gst" ? existing.netCents : existing.totalCents) : "",
    gstTreatment: existing?.gstTreatment ?? "inclusive",
    gstOverride: existing && existing.gstTreatment === "inclusive" ? centsToDollarInput(existing.gstCents) : "",
    spentOn: existing?.spentOn ?? nzToday(),
    paidWith: existing?.paidWith ?? "card",
    notes: existing?.notes ?? "",
  });
  const [file, setFile] = useState<{ name: string; dataUrl: string } | null>(null);
  const [removeInvoice, setRemoveInvoice] = useState(false);

  // Live preview of exactly what will be stored — he sees the GST before saving.
  const preview = useMemo(() => {
    const entered = dollarInputToCents(f.amount);
    if (f.gstTreatment === "zero_rated" || f.gstTreatment === "overseas_no_gst") {
      return { total: entered, gst: 0, net: entered };
    }
    if (f.gstTreatment === "plus_gst") {
      const gst = Math.round(entered * NZ_GST);
      return { total: entered + gst, gst, net: entered };
    }
    const override = f.gstOverride.trim() ? dollarInputToCents(f.gstOverride) : null;
    const gst = override !== null ? Math.min(override, entered) : Math.round(entered - entered / (1 + NZ_GST));
    return { total: entered, gst, net: entered - gst };
  }, [f.amount, f.gstTreatment, f.gstOverride]);

  const save = useMutation({
    mutationFn: async () => {
      const body: any = {
        category: f.category,
        supplier: f.supplier.trim() || null,
        description: f.description.trim(),
        reference: f.reference.trim() || null,
        totalCents: dollarInputToCents(f.amount),
        gstTreatment: f.gstTreatment,
        gstCents: f.gstTreatment === "inclusive" && f.gstOverride.trim() ? dollarInputToCents(f.gstOverride) : undefined,
        spentOn: f.spentOn,
        paidWith: f.paidWith,
        notes: f.notes.trim() || null,
      };
      if (file) { body.invoiceData = file.dataUrl; body.invoiceFileName = file.name; }
      else if (removeInvoice) { body.invoiceData = null; }
      const res = existing
        ? await apiRequest("PATCH", `/api/admin/print-expenses/${existing.id}`, body)
        : await apiRequest("POST", "/api/admin/print-expenses", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-expenses"] });
      toast({ title: existing ? "Expense updated" : "Expense added" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const pick = (fl: File | undefined) => {
    if (!fl) return;
    if (fl.size > 6_000_000) { toast({ title: "That file is over 6MB", description: "Try a smaller PDF or photo.", variant: "destructive" }); return; }
    const r = new FileReader();
    r.onload = () => { setFile({ name: fl.name, dataUrl: String(r.result) }); setRemoveInvoice(false); };
    r.onerror = () => toast({ title: "Couldn't read that file", variant: "destructive" });
    r.readAsDataURL(fl);
  };

  const amountLabel = f.gstTreatment === "plus_gst" ? "Amount before GST" : "Amount paid";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{existing ? "Edit expense" : "Add an expense"}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">What kind</label>
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                {vocab.categories.map((c) => <option key={c} value={c} className="bg-[#02060E]">{CAT_LABEL[c] ?? c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Invoice date</label>
              <DatePickerInput value={f.spentOn} onChange={(e) => setF({ ...f, spentOn: e.target.value })}
                className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">What was it for</label>
            <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
              placeholder="e.g. 50 rolls of 440gsm banner vinyl" className="bg-white/[0.02] border-white/10 text-white" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Supplier</label>
              <Input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}
                placeholder="e.g. KELME, Spicers" className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Their invoice no.</label>
              <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })}
                placeholder="optional" className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>

          {/* ── Money + GST ── */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">How the price is quoted</label>
              <select value={f.gstTreatment} onChange={(e) => setF({ ...f, gstTreatment: e.target.value })}
                className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                {vocab.treatments.map((t) => <option key={t} value={t} className="bg-[#02060E]">{TREAT_LABEL[t] ?? t}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">{amountLabel}</label>
                <MoneyInput value={f.amount} onChange={(v) => setF({ ...f, amount: v })}
                  className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              {f.gstTreatment === "inclusive" && (
                <div>
                  <label className="text-[10px] uppercase tracking-wider text-white/40">GST on the invoice</label>
                  <MoneyInput value={f.gstOverride} onChange={(v) => setF({ ...f, gstOverride: v })}
                    className="bg-white/[0.02] border-white/10 text-white" />
                  <div className="text-[10px] text-white/30 mt-0.5">Leave blank and we'll work it out at 15%</div>
                </div>
              )}
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">Paid with</label>
                <select value={f.paidWith} onChange={(e) => setF({ ...f, paidWith: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
                  {vocab.paidWith.map((p) => <option key={p} value={p} className="bg-[#02060E]">{PAID_LABEL[p] ?? p}</option>)}
                </select>
              </div>
            </div>
            {/* What will actually be stored — shown before saving, not after. */}
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-2 border-t border-white/5 text-xs font-mono">
              <span className="text-white/50">Net <span className="text-white">{money(preview.net)}</span></span>
              <span className="text-white/50">GST <span className="text-white">{money(preview.gst)}</span></span>
              <span className="text-white/50">Total <span className="text-white font-bold">{money(preview.total)}</span></span>
            </div>
            {(f.gstTreatment === "overseas_no_gst" || f.gstTreatment === "zero_rated") && (
              <div className="text-[11px] leading-snug text-amber-300/90">
                Recorded with no GST. If this was an import, the customs GST comes on its own document and gets
                claimed separately — it isn't part of this invoice.
              </div>
            )}
          </div>

          {/* ── Invoice ── */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Invoice</label>
            <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.02] p-3">
              {file ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white/80 truncate flex items-center gap-2"><FileText className="w-4 h-4 text-blue-300 shrink-0" />{file.name}</span>
                  <button onClick={() => setFile(null)} className="text-white/40 hover:text-red-300 text-xs">Remove</button>
                </div>
              ) : existing?.hasInvoice && !removeInvoice ? (
                <div className="flex items-center justify-between gap-2">
                  <a href={`/api/admin/print-expenses/${existing.id}/invoice`} target="_blank" rel="noreferrer"
                    className="text-sm text-blue-300 hover:text-blue-200 truncate flex items-center gap-2">
                    <Paperclip className="w-4 h-4 shrink-0" />{existing.invoiceFileName || "View invoice"}
                  </a>
                  <button onClick={() => setRemoveInvoice(true)} className="text-white/40 hover:text-red-300 text-xs">Replace / remove</button>
                </div>
              ) : (
                <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp"
                  onChange={(e) => pick(e.target.files?.[0])}
                  className="text-xs text-white/60 file:mr-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-white" />
              )}
              <div className="text-[10px] text-white/30 mt-1.5">PDF, or a photo of a paper invoice. Up to about 6MB.</div>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Notes</label>
            <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })}
              placeholder="anything worth remembering about this purchase"
              className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[60px]" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !f.description.trim() || preview.total <= 0}
            className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Saving..." : existing ? "Save changes" : "Add expense"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PrintsExpenses() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [category, setCategory] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const qs = new URLSearchParams();
  if (category !== "all") qs.set("category", category);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);

  const { data, isLoading, error } = useQuery<Payload>({
    queryKey: ["/api/admin/print-expenses", { orgId, category, from, to }],
    queryFn: async () => {
      const res = await workspaceFetch(`/api/admin/print-expenses${qs.toString() ? `?${qs}` : ""}`);
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.message || `Couldn't load expenses (HTTP ${res.status})`);
      }
      return res.json();
    },
    enabled: !!orgId,
  });

  const remove = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/print-expenses/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/print-expenses"] }); toast({ title: "Deleted" }); },
    onError: (e: Error) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  const expenses = data?.expenses ?? [];
  const totals = data?.totals;
  const vocab = data?.vocab ?? { categories: Object.keys(CAT_LABEL), treatments: Object.keys(TREAT_LABEL), paidWith: Object.keys(PAID_LABEL) };

  const csv = () => {
    const head = ["Date", "Category", "Supplier", "Description", "Their invoice no.", "Net", "GST", "Total", "GST treatment", "Paid with", "Invoice attached", "Notes", "Added by"];
    const rows = expenses.map((e) => [
      e.spentOn, CAT_LABEL[e.category] ?? e.category, e.supplier ?? "", e.description, e.reference ?? "",
      (e.netCents / 100).toFixed(2), (e.gstCents / 100).toFixed(2), (e.totalCents / 100).toFixed(2),
      TREAT_LABEL[e.gstTreatment] ?? e.gstTreatment, PAID_LABEL[e.paidWith ?? ""] ?? (e.paidWith ?? ""),
      e.hasInvoice ? "yes" : "no", e.notes ?? "", e.createdByName ?? "",
    ]);
    const text = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `print-expenses_${nzToday()}.csv`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Expenses</h1>
          <p className="text-sm text-white/40 mt-0.5">Everything the print shop buys, with the invoice attached.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={csv} disabled={!expenses.length} className="text-white/70">
            <Download className="w-4 h-4 mr-1.5" /> CSV
          </Button>
          <Button onClick={() => setAdding(true)} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-1.5" /> Add expense
          </Button>
        </div>
      </div>

      {/* ── Totals ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { l: "Total spent", v: money(totals?.totalCents ?? 0), icon: TrendingDown, accent: "text-white" },
          { l: "Net of GST", v: money(totals?.netCents ?? 0), icon: Receipt, accent: "text-white/80" },
          { l: "GST", v: money(totals?.gstCents ?? 0), icon: Receipt, accent: "text-white/80" },
          { l: "Purchases", v: String(totals?.count ?? 0), icon: FileText, accent: "text-white/80" },
        ].map((s) => (
          <div key={s.l} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <div className="text-[10px] uppercase tracking-wider text-white/40">{s.l}</div>
            <div className={`mt-1 font-mono text-xl font-bold ${s.accent}`}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40 flex items-center gap-1"><Filter className="w-3 h-3" /> Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm">
            <option value="all" className="bg-[#02060E]">All</option>
            {vocab.categories.map((c) => <option key={c} value={c} className="bg-[#02060E]">{CAT_LABEL[c] ?? c}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">From</label>
          <DatePickerInput value={from} onChange={(e) => setFrom(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-wider text-white/40">To</label>
          <DatePickerInput value={to} onChange={(e) => setTo(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
        </div>
        {(from || to || category !== "all") && (
          <Button variant="ghost" onClick={() => { setFrom(""); setTo(""); setCategory("all"); }} className="text-white/50">Clear</Button>
        )}
      </div>

      {/* ── By category ── */}
      {data && Object.keys(data.byCategory).length > 1 && (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
          <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2">Where the money went</div>
          <div className="space-y-1.5">
            {Object.entries(data.byCategory).sort((a, b) => b[1].totalCents - a[1].totalCents).map(([cat, b]) => {
              const pct = totals?.totalCents ? Math.round((b.totalCents / totals.totalCents) * 100) : 0;
              return (
                <div key={cat} className="flex items-center gap-3 text-xs">
                  <span className="w-40 shrink-0 text-white/70">{CAT_LABEL[cat] ?? cat}</span>
                  <div className="h-2 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500/70" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-white">{money(b.totalCents)}</span>
                  <span className="w-10 shrink-0 text-right text-white/40">{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── List ── */}
      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4">
          <div className="text-sm font-semibold text-white">Expenses didn't load</div>
          <div className="mt-1 text-sm text-white/60">{(error as Error).message}</div>
          <Button onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/admin/print-expenses"] })}
            className="mt-3 bg-blue-600 hover:bg-blue-700">Try again</Button>
        </div>
      ) : isLoading ? (
        <div className="text-white/40 text-sm">Loading...</div>
      ) : expenses.length === 0 ? (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] p-8 text-center">
          <Receipt className="w-8 h-8 text-white/20 mx-auto" />
          <div className="mt-3 text-sm text-white/60">No expenses recorded{from || to || category !== "all" ? " for that filter" : " yet"}.</div>
          <div className="mt-1 text-xs text-white/35">Add the first purchase and attach its invoice.</div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-white/40">
                  <th className="text-left px-3 py-2.5">Date</th>
                  <th className="text-left px-3 py-2.5">What</th>
                  <th className="text-left px-3 py-2.5">Supplier</th>
                  <th className="text-right px-3 py-2.5">Net</th>
                  <th className="text-right px-3 py-2.5">GST</th>
                  <th className="text-right px-3 py-2.5">Total</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} className="border-t border-white/5 hover:bg-white/[0.02]">
                    <td className="px-3 py-2.5 whitespace-nowrap text-white/70">{niceDate(e.spentOn)}</td>
                    <td className="px-3 py-2.5">
                      <button onClick={() => setEditing(e)} className="text-left">
                        <div className="text-white font-medium">{e.description}</div>
                        <div className="text-[11px] text-white/40">
                          {CAT_LABEL[e.category] ?? e.category}
                          {e.reference ? ` · ${e.reference}` : ""}
                          {e.paidWith ? ` · ${PAID_LABEL[e.paidWith] ?? e.paidWith}` : ""}
                          {e.gstTreatment !== "inclusive" ? ` · ${TREAT_LABEL[e.gstTreatment] ?? e.gstTreatment}` : ""}
                        </div>
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-white/70">{e.supplier || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-white/70">{money(e.netCents)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-white/50">{money(e.gstCents)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-white font-bold">{money(e.totalCents)}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        {e.hasInvoice ? (
                          <a href={`/api/admin/print-expenses/${e.id}/invoice`} target="_blank" rel="noreferrer"
                            title={e.invoiceFileName || "View invoice"} className="text-blue-300 hover:text-blue-200">
                            <Paperclip className="w-4 h-4" />
                          </a>
                        ) : <span className="text-white/15" title="No invoice attached"><Paperclip className="w-4 h-4" /></span>}
                        <button onClick={() => { if (confirm(`Delete "${e.description}"?`)) remove.mutate(e.id); }}
                          className="text-white/25 hover:text-red-400" aria-label="Delete">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(adding || editing) && (
        <ExpenseModal existing={editing} vocab={vocab}
          onClose={() => { setAdding(false); setEditing(null); }}
          key={editing?.id ?? "new"} />
      )}
    </div>
  );
}

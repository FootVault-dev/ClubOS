// ─────────────────────────────────────────────────────────────────────────────
// CODING BUDGET — the club's chart of accounts.
// United Sports Group workspace, locked (see server/coding-budget-routes.ts).
//
// Victor Zoubkov's FY2026 coding structure: thirty streams, 882 codes. Xero is
// being matched to this, and every transaction will be mapped against it.
//
// Three things this page refuses to do, because the workbook it replaces does
// all three and they are the reason the club cannot answer "does the Academy
// make money":
//
//   * It never renders an unbudgeted line as $0.00. A budget of null and a
//     budget of zero are different statements and both appear here — 800 lines
//     roll up from their children, 35 are deliberately budgeted at nil.
//
//   * It never nets GST-inclusive income against GST-inclusive expenses. That
//     arithmetic turns the club's $23,616 deficit into a $46,596 "surplus" by
//     treating GST collected for Inland Revenue as income. The GST-exclusive
//     figure is shown as the real one and the inclusive one is labelled.
//
//   * It never quietly corrects Victor's numbers. Where the workbook's own
//     stated total disagrees with the sum of its codes, both are shown and the
//     variance is named.
//
// Money is cents everywhere; `dollars()` from @shared/coding-budget is the only
// thing that formats it.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Calculator, ChevronRight, ChevronDown, Search, AlertTriangle, Check,
  Lock, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import {
  dollars, isPostable, GST_TREATMENTS, GST_LABELS, type GstTreatment,
} from "@shared/coding-budget";

const KEY = ["/api/admin/coding-budget"];

interface AccountRow {
  id: number;
  code: string;
  parentCode: string | null;
  topCode: string;
  depth: number;
  name: string;
  kind: "income" | "expense";
  treatment: "entry" | "coding" | "subtotal" | "reserved";
  postable: boolean;
  budgetExclCents: number | null;
  budgetInclCents: number | null;
  xeroAccount: string | null;
  xeroTracking: string | null;
  xeroAccountCode: string | null;
  gstTreatment: GstTreatment | null;
  note: string | null;
  active: boolean;
}

interface Payload {
  accounts: AccountRow[];
  actuals: { excl: Record<string, number>; incl: Record<string, number>; count: Record<string, number> };
  budget: { incomeExcl: number; incomeIncl: number; expenseExcl: number; expenseIncl: number };
  netExcl: number;
  netIncl: number;
  today: string;
  mappedToXero: number;
  gstDecided: number;
  postableCount: number;
}

const TREATMENT_LABEL: Record<AccountRow["treatment"], string> = {
  entry: "Invoice line",
  coding: "Coding line",
  subtotal: "Control row",
  reserved: "Reserved",
};

export default function CodingBudget() {
  const { toast } = useToast();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<AccountRow | null>(null);

  const { data, isLoading } = useQuery<Payload>({ queryKey: KEY });

  const save = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/admin/coding-budget/accounts/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: "Saved" });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e?.message, variant: "destructive" }),
  });

  const accounts = data?.accounts ?? [];

  // Searching flattens the tree: typing "sponsorship" should find every code
  // with that word regardless of how deep it sits or whether its parents are
  // expanded. Empty search shows the tree.
  const searching = q.trim().length > 0;
  const matches = useMemo(() => {
    if (!searching) return [];
    const needle = q.trim().toLowerCase();
    return accounts.filter(a =>
      a.name.toLowerCase().includes(needle) || a.code.includes(needle));
  }, [accounts, q, searching]);

  const childrenOf = useMemo(() => {
    const m = new Map<string | null, AccountRow[]>();
    for (const a of accounts) {
      const k = a.parentCode;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return m;
  }, [accounts]);

  const toggle = (code: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });

  if (isLoading) {
    return <div className="p-8 text-sm text-muted-foreground">Loading the chart of accounts…</div>;
  }
  if (!data) {
    return <div className="p-8 text-sm text-muted-foreground">Could not load the chart of accounts.</div>;
  }

  const tops = accounts.filter(a => a.depth === 1);
  const income = tops.filter(a => a.kind === "income");
  const expense = tops.filter(a => a.kind === "expense");

  // ── The variance the workbook cannot see in itself. Stated on the sheet's own
  //    TOTAL row vs the sum of its thirty streams. Expenses reconcile exactly;
  //    income does not, and the difference is $28,750 on the GST-inclusive
  //    column. Reported, never corrected.
  const STATED = { incomeExcl: 276290900, incomeIncl: 298914500,
                   expenseExcl: 278652500, expenseIncl: 294254900 };
  const variance = data.budget.incomeIncl - STATED.incomeIncl;

  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Calculator className="h-6 w-6 text-muted-foreground" />
            Coding Budget
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            The club's chart of accounts for 2026 — {accounts.length} codes across{" "}
            {tops.length} streams. This is the structure Xero is being matched to,
            and every transaction will be coded against it.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 rounded-md px-2.5 py-1.5">
          <Lock className="h-3.5 w-3.5" />
          Super admins only — code 21 carries individual salaries
        </div>
      </div>

      {/* ── The four numbers ───────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Budgeted income" value={dollars(data.budget.incomeExcl)}
              sub="excl. GST" tone="income" />
        <Stat label="Budgeted expenses" value={dollars(data.budget.expenseExcl)}
              sub="excl. GST" tone="expense" />
        <Stat label="Net position" value={dollars(data.netExcl)}
              sub={data.netExcl < 0 ? "deficit, excl. GST" : "surplus, excl. GST"}
              tone={data.netExcl < 0 ? "expense" : "income"} />
        <Stat label="Coded to Xero" value={`${data.mappedToXero} / ${data.postableCount}`}
              sub="postable codes mapped" tone="neutral" />
      </div>

      {/* ── What the numbers don't say on their own ─────────────────────── */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-2.5 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Two things to settle with Victor before this drives Xero
        </div>
        <p className="text-muted-foreground">
          <strong className="text-foreground">The surplus depends on which column you read.</strong>{" "}
          Excluding GST the budget is a {dollars(Math.abs(data.netExcl))}{" "}
          {data.netExcl < 0 ? "deficit" : "surplus"}. The workbook's own summary
          nets the GST-inclusive columns instead and reports a{" "}
          {dollars(Math.abs(data.netIncl))} {data.netIncl < 0 ? "deficit" : "surplus"} — but
          GST collected on a registration is Inland Revenue's, not the club's, so
          the excluding-GST figure is the real one.
        </p>
        {variance !== 0 && (
          <p className="text-muted-foreground">
            <strong className="text-foreground">
              The workbook's stated income total is {dollars(Math.abs(variance))} adrift.
            </strong>{" "}
            Its TOTAL INCOME row says {dollars(STATED.incomeIncl)} including GST, while
            its thirty income codes sum to {dollars(data.budget.incomeIncl)}. The
            excluding-GST column and both expense columns reconcile to the cent, so
            this is one figure on one row, not a structural problem. Nothing here has
            been corrected — the codes are as Victor wrote them.
          </p>
        )}
        <p className="text-muted-foreground">
          <strong className="text-foreground">{data.postableCount - data.gstDecided} codes
          have no GST treatment set.</strong>{" "}
          The workbook mixes 15%, zero-rated and out-of-scope lines — donations
          carry no GST, FIFA prize money is an overseas supply — and none of it
          was assumed. Set each one below as it is decided.
        </p>
      </div>

      {/* ── Search ─────────────────────────────────────────────────────── */}
      <div className="relative">
        <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search 882 codes — by name or code number"
          className="w-full pl-9 pr-3 h-10 rounded-md border bg-background text-sm"
        />
      </div>

      {/* ── The tree ───────────────────────────────────────────────────── */}
      {searching ? (
        <div className="rounded-lg border divide-y">
          <div className="px-3 py-2 text-xs text-muted-foreground bg-muted/40">
            {matches.length} code{matches.length === 1 ? "" : "s"} matching "{q.trim()}"
          </div>
          {matches.slice(0, 200).map(a => (
            <Row key={a.id} a={a} data={data} indent={0}
                 onSelect={() => setSelected(a)} showFullCode />
          ))}
          {matches.length > 200 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              Showing the first 200 of {matches.length}. Narrow the search to see the rest.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <Section title="Income" subtitle="Streams 01–20" rows={income}
                   childrenOf={childrenOf} open={open} toggle={toggle}
                   data={data} onSelect={setSelected} />
          <Section title="Expenses" subtitle="Streams 21–30" rows={expense}
                   childrenOf={childrenOf} open={open} toggle={toggle}
                   data={data} onSelect={setSelected} />
        </div>
      )}

      {selected && (
        <DetailPanel
          a={selected}
          data={data}
          onClose={() => setSelected(null)}
          onSave={(patch) => save.mutate({ id: selected.id, patch })}
          saving={save.isPending}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone: "income" | "expense" | "neutral";
}) {
  const colour = tone === "income" ? "text-emerald-600"
    : tone === "expense" ? "text-rose-600" : "text-foreground";
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold mt-1 tabular-nums ${colour}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function Section({ title, subtitle, rows, childrenOf, open, toggle, data, onSelect }: {
  title: string; subtitle: string; rows: AccountRow[];
  childrenOf: Map<string | null, AccountRow[]>;
  open: Set<string>; toggle: (c: string) => void;
  data: Payload; onSelect: (a: AccountRow) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </div>
      <div className="rounded-lg border divide-y">
        {rows.map(a => (
          <Branch key={a.id} a={a} childrenOf={childrenOf} open={open}
                  toggle={toggle} data={data} onSelect={onSelect} indent={0} />
        ))}
      </div>
    </div>
  );
}

function Branch({ a, childrenOf, open, toggle, data, onSelect, indent }: {
  a: AccountRow; childrenOf: Map<string | null, AccountRow[]>;
  open: Set<string>; toggle: (c: string) => void;
  data: Payload; onSelect: (a: AccountRow) => void; indent: number;
}) {
  const kids = childrenOf.get(a.code) ?? [];
  const isOpen = open.has(a.code);
  return (
    <>
      <Row a={a} data={data} indent={indent} onSelect={() => onSelect(a)}
           expandable={kids.length > 0} expanded={isOpen}
           onToggle={() => toggle(a.code)} childCount={kids.length} />
      {isOpen && kids.map(k => (
        <Branch key={k.id} a={k} childrenOf={childrenOf} open={open}
                toggle={toggle} data={data} onSelect={onSelect} indent={indent + 1} />
      ))}
    </>
  );
}

function Row({ a, data, indent, onSelect, expandable, expanded, onToggle, childCount, showFullCode }: {
  a: AccountRow; data: Payload; indent: number; onSelect: () => void;
  expandable?: boolean; expanded?: boolean; onToggle?: () => void;
  childCount?: number; showFullCode?: boolean;
}) {
  const actual = data.actuals.excl[a.code] ?? 0;
  const n = data.actuals.count[a.code] ?? 0;

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 text-sm"
      style={{ paddingLeft: `${12 + indent * 18}px` }}
    >
      {expandable ? (
        <button onClick={onToggle} className="p-0.5 hover:bg-muted rounded shrink-0"
                aria-label={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      ) : <span className="w-5 shrink-0" />}

      <code className="text-xs text-muted-foreground tabular-nums shrink-0 w-24">{a.code}</code>

      <button onClick={onSelect} className="flex-1 text-left truncate hover:underline">
        {a.name}
      </button>

      {/* 🔴 A control row is labelled, because it is the one thing on this page
          a person must not code money to. `reserved` likewise. */}
      {!a.postable && (
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
          {TREATMENT_LABEL[a.treatment]}
        </span>
      )}
      {a.gstTreatment && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-700 shrink-0">
          {GST_LABELS[a.gstTreatment]}
        </span>
      )}
      {a.xeroAccountCode && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 shrink-0 tabular-nums">
          Xero {a.xeroAccountCode}
        </span>
      )}

      {n > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground shrink-0 w-28 text-right">
          {dollars(actual)}
        </span>
      )}

      {/* 🔴 An unbudgeted line shows an em-dash, never $0.00 — dollars(null)
          returns "—". The 35 lines budgeted at an explicit zero DO show
          $0.00, and the difference is the point. */}
      <span className="text-xs tabular-nums shrink-0 w-28 text-right font-medium">
        {dollars(a.budgetExclCents)}
      </span>
    </div>
  );
}

function DetailPanel({ a, data, onClose, onSave, saving }: {
  a: AccountRow; data: Payload; onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void; saving: boolean;
}) {
  const [xeroCode, setXeroCode] = useState(a.xeroAccountCode ?? "");
  const [gst, setGst] = useState<string>(a.gstTreatment ?? "");

  const actual = data.actuals.excl[a.code] ?? 0;
  const n = data.actuals.count[a.code] ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/30" />
      <div className="relative w-full max-w-md bg-background border-l h-full overflow-y-auto p-6 space-y-5"
           onClick={e => e.stopPropagation()}>
        <div>
          <code className="text-xs text-muted-foreground">{a.code}</code>
          <h2 className="text-lg font-semibold mt-0.5">{a.name}</h2>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Tag>{a.kind === "income" ? "Income" : "Expense"}</Tag>
            <Tag>{TREATMENT_LABEL[a.treatment]}</Tag>
            {!a.postable && <Tag tone="warn">Cannot receive a transaction</Tag>}
          </div>
        </div>

        {!a.postable && (
          <p className="text-xs text-muted-foreground border-l-2 border-amber-500/50 pl-3">
            {a.treatment === "subtotal"
              ? "This is a control row — it totals the codes beneath it. Coding a transaction here as well would count the money twice, so the database refuses it."
              : "Reserved for a future income stream. Not approved for use until the board signs it off."}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field label="Budget (excl. GST)" value={dollars(a.budgetExclCents)} />
          <Field label="Budget (incl. GST)" value={dollars(a.budgetInclCents)} />
          <Field label="Actual to date" value={n ? dollars(actual) : "—"} />
          <Field label="Transactions" value={n ? String(n) : "None yet"} />
        </div>

        {a.budgetExclCents == null && (
          <p className="text-xs text-muted-foreground">
            No budget figure of its own — this line rolls up from the codes beneath it.
            That is different from a budget of zero, which appears as $0.00.
          </p>
        )}

        <div className="space-y-3 border-t pt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggested in the workbook
          </div>
          <Field label="Xero account" value={a.xeroAccount ?? "—"} />
          <Field label="Tracking category" value={a.xeroTracking ?? "—"} />
          {a.note && <p className="text-xs text-muted-foreground italic">{a.note}</p>}
        </div>

        <div className="space-y-3 border-t pt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Confirmed in Xero
          </div>
          <label className="block">
            <span className="text-xs text-muted-foreground">Xero account code</span>
            <input
              value={xeroCode}
              onChange={e => setXeroCode(e.target.value)}
              placeholder="e.g. 200"
              className="mt-1 w-full h-9 px-3 rounded-md border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">GST treatment</span>
            <select
              value={gst}
              onChange={e => setGst(e.target.value)}
              className="mt-1 w-full h-9 px-3 rounded-md border bg-background text-sm"
            >
              <option value="">Not decided yet</option>
              {GST_TREATMENTS.map(g => (
                <option key={g} value={g}>{GST_LABELS[g]}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Leaving GST unset is a real answer — it means nobody has decided.
            Nothing here assumes 15%.
          </p>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            disabled={saving}
            onClick={() => onSave({
              xeroAccountCode: xeroCode.trim() || null,
              gstTreatment: gst || null,
            })}
            className="flex-1 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button onClick={onClose}
                  className="h-9 px-4 rounded-md border text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
      tone === "warn" ? "bg-amber-500/10 text-amber-700" : "bg-muted text-muted-foreground"
    }`}>{children}</span>
  );
}

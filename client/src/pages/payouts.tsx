import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatCurrency } from "@/lib/format";
import {
  Banknote, ArrowLeft, ChevronRight, Download, Search as SearchIcon,
  AlertTriangle, RefreshCcw, ArrowUp, ArrowDown, ChevronsUpDown, Hourglass,
} from "lucide-react";

// ── Types (mirror server/payout-routes.ts) ──────────────────────────────────
type AccountKey = "club" | "cugc";

interface PayoutRow {
  id: string;
  amountCents: number;
  currency: string;
  status: string; // paid | in_transit | pending | failed | canceled
  arrivalDate: string; // ISO yyyy-mm-dd — display via isoToNice, never a Date
  createdAt: string; // NZ-formatted server-side
  automatic: boolean;
  description: string | null;
}

interface ResolvedRef {
  source: "registration" | "membership" | "shop" | "invoice" | "split" | "facility" | "print" | "cugc" | "adspace" | "stripe";
  programme: string;
  player: string | null;
  parent: string | null;
  detail: string | null;
}

interface PayoutLine {
  id: string;
  kind: "charge" | "refund" | "other";
  when: string;
  grossCents: number;
  feeCents: number;
  netCents: number;
  description: string | null;
  payerName: string | null;
  payerEmail: string | null;
  resolved: ResolvedRef | null;
}

interface ListResponse {
  account: AccountKey;
  accounts: Array<{ key: AccountKey; label: string; available: boolean }>;
  payouts: PayoutRow[];
  hasMore: boolean;
}

interface UpcomingResponse {
  account: AccountKey;
  configured: boolean;
  /** Payouts Stripe HAS created that have not reached the bank yet. Facts. */
  inFlight: PayoutRow[];
  inFlightCents: number;
  /** Card money Stripe holds. Real, but NOT a payout and with no arrival date. */
  pending: { currency: string; amountCents: number }[];
  available: { currency: string; amountCents: number }[];
  schedule: { interval: string | null; delayDays: number | null; weeklyAnchor: string | null; monthlyAnchor: number | null } | null;
  payoutsEnabled?: boolean;
}

interface DetailResponse {
  account: AccountKey;
  truncated: boolean;
  payout: PayoutRow;
  negativeBalance?: {
    reason: string;
    windowFrom: string;
    causes: { when: string; type: string; amountCents: number; description: string | null }[];
    causeTotalCents: number;
  } | null;
  summary: {
    grossCents: number;
    feeCents: number;
    refundCents: number;
    otherCents: number;
    chargeCount: number;
    refundCount: number;
    otherCount: number;
    resolvedCount: number;
  };
  lines: PayoutLine[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-07-20" → "20 Jul 2026" without round-tripping through a JS Date. */
function isoToNice(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return iso;
  return `${Number(d)} ${MONTHS[mi]} ${y}`;
}

const PAYOUT_STATUS: Record<string, { label: string; color: string }> = {
  paid: { label: "Paid", color: "#22c55e" },
  in_transit: { label: "In transit", color: "#3b82f6" },
  pending: { label: "Pending", color: "#f59e0b" },
  failed: { label: "Failed", color: "#ef4444" },
  canceled: { label: "Cancelled", color: "#9ca3af" },
};

const SOURCE_LABEL: Record<ResolvedRef["source"], string> = {
  registration: "Registration",
  membership: "Membership",
  shop: "Store",
  invoice: "Invoice",
  split: "Player Pay",
  facility: "Facility hire",
  print: "United Print",
  cugc: "Gymnastics",
  adspace: "AdSpace",
  stripe: "Stripe",
};

function StatusBadge({ status }: { status: string }) {
  const s = PAYOUT_STATUS[status] ?? { label: status, color: "#9ca3af" };
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
      style={{ background: `${s.color}22`, color: s.color, border: `1px solid ${s.color}55` }}
    >
      {s.label}
    </span>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
      <div className="text-[11px] uppercase tracking-wide text-white/35">{label}</div>
      <div className="text-lg font-semibold mt-0.5" style={accent ? { color: accent } : undefined}>{value}</div>
      {sub ? <div className="text-[11px] text-white/35 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ── Column sorting (Olga's ask: click a header, the lines re-order) ─────────
type SortKey = "when" | "programme" | "player" | "parent" | "gross" | "fee" | "net";
type SortDir = "asc" | "desc";

// First click lands on the direction people actually want: amounts biggest
// first, names A→Z, When newest first.
const SORT_FIRST_DIR: Record<SortKey, SortDir> = {
  when: "desc", programme: "asc", player: "asc", parent: "asc",
  gross: "desc", fee: "desc", net: "desc",
};

function SortableTh({ label, k, sort, onSort, className = "", right = false }: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: SortDir } | null;
  onSort: (k: SortKey) => void;
  className?: string;
  right?: boolean;
}) {
  const dir: SortDir | null = sort && sort.key === k ? sort.dir : null;
  return (
    <th
      className={`px-4 py-2.5 font-medium ${className}`}
      aria-sort={dir ? (dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        data-testid={`button-sort-${k}`}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-white/70 ${right ? "w-full justify-end" : ""} ${dir ? "text-emerald-300" : ""}`}
      >
        {label}
        {dir ? (
          dir === "asc" ? <ArrowUp className="w-3 h-3 shrink-0" /> : <ArrowDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────
/** Plain English for Stripe's payout schedule object. */
function scheduleSentence(sch: UpcomingResponse["schedule"]): string | null {
  if (!sch) return null;
  const after =
    sch.delayDays === 0 ? "the same day" :
    sch.delayDays === 1 ? "the next day" :
    typeof sch.delayDays === "number" ? `${sch.delayDays} days later` : null;
  const how =
    sch.interval === "daily" ? "Stripe pays out every day" :
    sch.interval === "weekly" ? `Stripe pays out weekly${sch.weeklyAnchor ? ` on a ${sch.weeklyAnchor}` : ""}` :
    sch.interval === "monthly" ? `Stripe pays out monthly${sch.monthlyAnchor ? ` on the ${sch.monthlyAnchor}${sch.monthlyAnchor === 1 ? "st" : sch.monthlyAnchor === 2 ? "nd" : sch.monthlyAnchor === 3 ? "rd" : "th"}` : ""}` :
    sch.interval === "manual" ? "Payouts are triggered by hand, not on a schedule" : null;
  if (!how) return null;
  return after && sch.interval !== "manual" ? `${how}, ${after} than the payment` : how;
}

/** One currency line. Both club accounts are NZD-only today, but the balance
 *  comes back per currency and summing across currencies would be nonsense. */
function MoneyByCurrency({ rows, empty }: { rows: { currency: string; amountCents: number }[]; empty: string }) {
  const real = rows.filter((r) => r.amountCents !== 0);
  if (real.length === 0) return <div className="text-white/30 text-[13px]">{empty}</div>;
  return (
    <>
      {real.map((r) => (
        <div key={r.currency} className="text-2xl font-semibold text-white/90 tabular-nums">
          {formatCurrency(r.amountCents, { fromCents: true })}
          {r.currency !== "NZD" ? <span className="text-[12px] text-white/40 ml-1.5">{r.currency}</span> : null}
        </div>
      ))}
    </>
  );
}

/** What Stripe still owes the bank. Deliberately TWO figures that are never
 *  added together: payouts already on their way (a date you can trust), and card
 *  money Stripe has not scheduled yet (no date exists). */
function StillToCome({ data }: { data: UpcomingResponse | undefined }) {
  if (!data || !data.configured) return null;
  const sentence = scheduleSentence(data.schedule);

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 md:p-5 mb-4" data-testid="panel-upcoming">
      <div className="flex items-center gap-2 mb-3">
        <Hourglass className="w-4 h-4 text-amber-300/80" />
        <h2 className="text-[13px] font-semibold uppercase tracking-wide text-white/55">Still to come</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="text-[12px] text-white/45 mb-1">On its way to the bank</div>
          <div className="text-2xl font-semibold text-blue-300 tabular-nums" data-testid="text-inflight-total">
            {formatCurrency(data.inFlightCents, { fromCents: true })}
          </div>
          <div className="text-[12px] text-white/35 mt-1">
            {data.inFlight.length === 0
              ? "No payout in flight — everything Stripe has sent has landed."
              : `${data.inFlight.length} payout${data.inFlight.length === 1 ? "" : "s"} Stripe has already sent`}
          </div>
        </div>

        <div>
          <div className="text-[12px] text-white/45 mb-1">Taken, not scheduled yet</div>
          <div data-testid="text-balance-pending">
            <MoneyByCurrency rows={[...data.pending, ...data.available]} empty="Nothing waiting." />
          </div>
          {/* 🔴 This is NOT a payout and has no arrival date. Saying otherwise
              would put a promise on the page that Stripe never made. */}
          <div className="text-[12px] text-white/35 mt-1">
            Card payments Stripe is still holding. It has not turned these into a payout, so there is no arrival date yet.
          </div>
        </div>
      </div>

      {data.inFlight.length > 0 && (
        <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/[0.04] divide-y divide-white/[0.05]">
          {data.inFlight.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 px-3.5 py-2.5" data-testid={`row-upcoming-${p.id}`}>
              <div className="min-w-0">
                <div className="text-[13px] text-white/85">{isoToNice(p.arrivalDate)}</div>
                <div className="text-[11px] text-white/35 font-mono truncate">{p.id}</div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={p.status} />
                <span className="font-medium text-blue-300 tabular-nums">{formatCurrency(p.amountCents, { fromCents: true })}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {sentence ? <div className="text-[12px] text-white/30 mt-3">{sentence}.</div> : null}
      {data.payoutsEnabled === false ? (
        <div className="text-[12px] text-amber-300/80 mt-2">Stripe has payouts switched off on this account.</div>
      ) : null}
    </div>
  );
}

export default function GroupPayouts() {
  const [account, setAccount] = useState<AccountKey>(() =>
    new URLSearchParams(window.location.search).get("account") === "cugc" ? "cugc" : "club",
  );
  // Cursor stack for Older/Newer paging — current page cursor is the last entry.
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const cursor = cursorStack[cursorStack.length - 1];
  // ?payout=po_… deep-links straight into one payout's breakdown.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search).get("payout");
    return p && /^po_[A-Za-z0-9]+$/.test(p) ? p : null;
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const listUrl = `/api/admin/payouts?account=${account}${cursor ? `&starting_after=${cursor}` : ""}`;
  const { data: list, isLoading } = useQuery<ListResponse>({ queryKey: [listUrl] });
  const payouts = list?.payouts ?? [];
  const accounts = list?.accounts ?? [];
  const cugcAvailable = accounts.find((a) => a.key === "cugc")?.available ?? false;

  // What has not landed yet. Its own call so it stays put while you page the
  // history — "what is still coming" does not change because you looked at July.
  const { data: upcoming } = useQuery<UpcomingResponse>({
    queryKey: [`/api/admin/payouts/upcoming?account=${account}`],
  });

  const detailUrl = selectedId ? `/api/admin/payouts/${selectedId}?account=${account}` : null;
  const { data: detail, isLoading: detailLoading, error: detailError } = useQuery<DetailResponse>({
    queryKey: [detailUrl ?? "/api/admin/payouts/none"],
    enabled: selectedId != null,
  });

  const filteredLines = useMemo(() => {
    if (!detail) return [];
    const q = search.trim().toLowerCase();
    if (!q) return detail.lines;
    return detail.lines.filter((l) =>
      [l.resolved?.programme, l.resolved?.player, l.resolved?.parent, l.resolved?.detail, l.payerName, l.payerEmail, l.description]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [detail, search]);

  // Sort AFTER filtering, so search + sort compose. Stripe returns lines
  // newest-first, so "When" sorts by original position — the `when` string is
  // NZ display text ("20 Jul 2026, 9:36 pm") and must never be parsed/compared.
  const sortedLines = useMemo(() => {
    if (!sort) return filteredLines;
    const dir = sort.dir === "asc" ? 1 : -1;
    const isText = sort.key === "programme" || sort.key === "player" || sort.key === "parent";
    const text = (l: PayoutLine): string | null => {
      switch (sort.key) {
        case "programme": return l.resolved?.programme ?? l.description ?? null;
        case "player": return l.resolved?.player ?? l.payerName ?? null;
        case "parent": return l.resolved?.parent ?? l.payerEmail ?? null;
        default: return null;
      }
    };
    const num = (l: PayoutLine, i: number): number => {
      switch (sort.key) {
        case "gross": return l.grossCents;
        case "fee": return l.feeCents;
        case "net": return l.netCents;
        default: return -i; // when: bigger = newer
      }
    };
    return filteredLines
      .map((l, i) => ({ l, i }))
      .sort((a, b) => {
        let cmp: number;
        if (isText) {
          const av = text(a.l);
          const bv = text(b.l);
          if (av === null && bv === null) cmp = 0;
          else if (av === null) return 1; // blanks sink to the bottom either way
          else if (bv === null) return -1;
          else cmp = av.localeCompare(bv, undefined, { sensitivity: "base" }) * dir;
        } else {
          cmp = (num(a.l, a.i) - num(b.l, b.i)) * dir;
        }
        return cmp !== 0 ? cmp : a.i - b.i; // stable tie-break keeps time order
      })
      .map((x) => x.l);
  }, [filteredLines, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: SORT_FIRST_DIR[key] }));
  }

  function switchAccount(key: AccountKey) {
    setAccount(key);
    setCursorStack([]);
    setSelectedId(null);
    setSearch("");
    setSort(null);
  }

  function downloadCsv() {
    if (!detail) return;
    const header = ["When", "Type", "Programme", "Player", "Parent", "Detail", "Payer", "Payer email", "Gross", "Fee", "Net"];
    const rows = detail.lines.map((l) => [
      l.when,
      l.kind === "charge" ? (l.resolved ? SOURCE_LABEL[l.resolved.source] : "Payment") : l.kind === "refund" ? "Refund" : "Other",
      l.resolved?.programme ?? l.description ?? "",
      l.resolved?.player ?? "",
      l.resolved?.parent ?? "",
      l.resolved?.detail ?? "",
      l.payerName ?? "",
      l.payerEmail ?? "",
      (l.grossCents / 100).toFixed(2),
      (l.feeCents / 100).toFixed(2),
      (l.netCents / 100).toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.map((c) => csvEscape(String(c))).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `payout-${detail.payout.arrivalDate}-${detail.payout.id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── Detail view ───────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
        <button
          onClick={() => { setSelectedId(null); setSearch(""); setSort(null); }}
          data-testid="button-back-to-payouts"
          className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 transition-colors mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> All payouts
        </button>

        {detailLoading ? (
          <div className="text-white/30 text-sm py-16 text-center">Reading the payout from Stripe…</div>
        ) : detailError ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-5 text-sm text-red-300">
            Couldn't load this payout: {(detailError as Error).message}
          </div>
        ) : detail ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
              <div>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  <Banknote className="w-5 h-5 text-emerald-400" />
                  {formatCurrency(detail.payout.amountCents, { fromCents: true })} to the bank
                </h1>
                <p className="text-[13px] text-white/40 mt-1">
                  Arrived {isoToNice(detail.payout.arrivalDate)} · created {detail.payout.createdAt} ·{" "}
                  <span className="font-mono text-[12px]">{detail.payout.id}</span> <StatusBadge status={detail.payout.status} />
                </p>
              </div>
              <button
                onClick={downloadCsv}
                data-testid="button-payout-csv"
                className="inline-flex items-center gap-2 rounded-xl bg-white/[0.04] border border-white/10 text-white/70 px-4 py-2 text-sm font-medium hover:bg-white/[0.08] transition-colors"
              >
                <Download className="w-4 h-4" /> CSV
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-5">
              <Tile
                label="Payments"
                value={String(detail.summary.chargeCount)}
                sub={`${detail.summary.resolvedCount} matched to people`}
              />
              <Tile label="Gross" value={formatCurrency(detail.summary.grossCents, { fromCents: true })} />
              <Tile label="Stripe fees" value={`-${formatCurrency(detail.summary.feeCents, { fromCents: true })}`} accent="#f59e0b" />
              <Tile
                label={detail.summary.refundCount > 0 ? "Refunds" : "Banked"}
                value={
                  detail.summary.refundCount > 0
                    ? `-${formatCurrency(Math.abs(detail.summary.refundCents), { fromCents: true })}`
                    : formatCurrency(detail.payout.amountCents, { fromCents: true })
                }
                accent={detail.summary.refundCount > 0 ? "#ef4444" : "#22c55e"}
              />
            </div>

            {detail.truncated ? (
              <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-3.5 py-2.5 text-[13px] text-amber-300 mb-4">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                This payout has more than 1,000 transactions — showing the first 1,000. The CSV matches what's shown.
              </div>
            ) : null}

            <div className="relative mb-3">
              <SearchIcon className="w-4 h-4 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search player, parent, programme…"
                data-testid="input-payout-search"
                className="w-full rounded-xl bg-white/[0.03] border border-white/10 pl-9 pr-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-emerald-500/50"
              />
            </div>

            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              {detail.negativeBalance && (
              <div className="mb-4 px-4 py-3.5 rounded-xl bg-amber-500/[0.08] border border-amber-500/25" data-testid="panel-negative-payout">
                <p className="text-[13.5px] font-semibold text-foreground/90">
                  Money went OUT of the bank — {detail.negativeBalance.reason}
                </p>
                <p className="text-[12.5px] text-foreground/65 mt-1 leading-snug">
                  This isn't a deposit, so it has no payments inside it. Stripe took it back to cover a
                  balance that refunds had pushed below zero. What caused it, from{" "}
                  {detail.negativeBalance.windowFrom}:
                </p>
                {detail.negativeBalance.causes.length > 0 ? (
                  <>
                    <ul className="mt-2.5 space-y-1">
                      {detail.negativeBalance.causes.slice(0, 12).map((c, i) => (
                        <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                          <span className="text-foreground/70 min-w-0 truncate">
                            <span className="text-foreground/45">{c.when}</span>{" "}
                            {c.description || c.type.replace(/_/g, " ")}
                          </span>
                          <span className="text-red-500 font-medium whitespace-nowrap">
                            {formatCurrency(c.amountCents, { fromCents: true })}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="flex items-baseline justify-between gap-3 text-[12.5px] mt-2 pt-2 border-t border-amber-500/20">
                      <span className="text-foreground/70 font-medium">
                        Total refunded in that window
                      </span>
                      <span className="text-red-500 font-semibold">
                        {formatCurrency(detail.negativeBalance.causeTotalCents, { fromCents: true })}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-[12.5px] text-foreground/50 mt-2">
                    Stripe didn't return the surrounding transactions — check the Stripe dashboard for that week.
                  </p>
                )}
              </div>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-white/35 border-b border-white/[0.06]">
                      <SortableTh label="When" k="when" sort={sort} onSort={toggleSort} className="hidden sm:table-cell" />
                      <SortableTh label="Programme / what" k="programme" sort={sort} onSort={toggleSort} />
                      <SortableTh label="Player" k="player" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                      <SortableTh label="Parent" k="parent" sort={sort} onSort={toggleSort} className="hidden md:table-cell" />
                      <SortableTh label="Gross" k="gross" sort={sort} onSort={toggleSort} className="text-right hidden sm:table-cell" right />
                      <SortableTh label="Fee" k="fee" sort={sort} onSort={toggleSort} className="text-right hidden sm:table-cell" right />
                      <SortableTh label="Net" k="net" sort={sort} onSort={toggleSort} className="text-right" right />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLines.map((l) => (
                      <tr key={l.id} data-testid={`row-payout-line-${l.id}`} className="border-b border-white/[0.04] last:border-0">
                        <td className="px-4 py-2.5 whitespace-nowrap text-white/60 text-[13px] hidden sm:table-cell">{l.when}</td>
                        <td className="px-4 py-2.5 sm:min-w-[220px]">
                          {l.kind === "refund" ? (
                            <span className="inline-flex items-center gap-1.5 text-red-300">
                              <RefreshCcw className="w-3.5 h-3.5" /> Refund
                              {l.resolved ? <span className="text-white/70">— {l.resolved.programme}</span> : l.description ? <span className="text-white/50">— {l.description}</span> : null}
                            </span>
                          ) : l.resolved ? (
                            <div>
                              <div className="text-white/85">{l.resolved.programme}</div>
                              <div className="text-[11px] text-white/35 mt-0.5">
                                {SOURCE_LABEL[l.resolved.source]}
                                {l.resolved.detail ? ` · ${l.resolved.detail}` : ""}
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div className="text-white/60 italic">{l.description ?? "Card payment"}</div>
                              <div className="text-[11px] text-white/30 mt-0.5">Not matched to a ClubOS record</div>
                            </div>
                          )}
                          {/* Mobile: names + time collapse into this cell so a phone
                              never needs a sideways scroll to see who paid. */}
                          <div className="md:hidden text-[12px] text-white/55 mt-1">
                            {(l.resolved?.player ?? l.payerName) ?? null}
                            {l.resolved?.parent && l.resolved.parent !== l.resolved.player ? ` · ${l.resolved.parent}` : ""}
                            {!l.resolved?.player && !l.payerName && l.payerEmail ? l.payerEmail : ""}
                          </div>
                          <div className="sm:hidden text-[11px] text-white/30 mt-0.5">{l.when}</div>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap hidden md:table-cell">
                          {l.resolved?.player ?? l.payerName ?? <span className="text-white/25">—</span>}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap hidden md:table-cell">
                          {l.resolved?.parent ?? (l.resolved?.player ? <span className="text-white/25">—</span> : l.payerEmail ? <span className="text-white/40 text-[12px]">{l.payerEmail}</span> : <span className="text-white/25">—</span>)}
                        </td>
                        <td className={`px-4 py-2.5 text-right whitespace-nowrap hidden sm:table-cell ${l.grossCents < 0 ? "text-red-300" : ""}`}>
                          {formatCurrency(l.grossCents, { fromCents: true })}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap text-white/45 hidden sm:table-cell">
                          {l.feeCents ? `-${formatCurrency(l.feeCents, { fromCents: true })}` : "—"}
                        </td>
                        <td className={`px-4 py-2.5 text-right whitespace-nowrap font-medium ${l.netCents < 0 ? "text-red-300" : "text-emerald-300/90"}`}>
                          {formatCurrency(l.netCents, { fromCents: true })}
                        </td>
                      </tr>
                    ))}
                    {filteredLines.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-white/30 text-sm">
                          {search
                            ? "Nothing in this payout matches that search."
                            : detail.negativeBalance
                              ? "This one has no payments of its own — see the explanation above."
                              : "No transactions in this payout."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Banknote className="w-5 h-5 text-emerald-400" /> Stripe Payouts
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Every bulk deposit Stripe sends the bank — open one to see the payments inside it, matched to programme, player and parent.
          </p>
        </div>
        {cugcAvailable ? (
          <div className="flex items-center gap-1 rounded-xl bg-white/[0.03] border border-white/10 p-1">
            {accounts.filter((a) => a.available).map((a) => (
              <button
                key={a.key}
                onClick={() => switchAccount(a.key)}
                data-testid={`button-account-${a.key}`}
                className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                  account === a.key ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "text-white/50 hover:text-white/80 border border-transparent"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <StillToCome data={upcoming} />

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Reading payouts from Stripe…</div>
      ) : payouts.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <Banknote className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">No payouts on this account{cursor ? " past this point" : " yet"}.</div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-white/35 border-b border-white/[0.06]">
                  <th className="px-4 py-2.5 font-medium">Arrives</th>
                  <th className="px-4 py-2.5 font-medium text-right">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium hidden sm:table-cell">Created</th>
                  <th className="px-4 py-2.5 font-medium hidden md:table-cell">Payout id</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    data-testid={`row-payout-${p.id}`}
                    className="border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">{isoToNice(p.arrivalDate)}</td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap font-medium text-emerald-300/90">
                      {formatCurrency(p.amountCents, { fromCents: true })}
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={p.status} /></td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-white/50 text-[13px] hidden sm:table-cell">{p.createdAt}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-white/35 hidden md:table-cell">{p.id}</td>
                    <td className="px-4 py-2.5 text-right"><ChevronRight className="w-4 h-4 text-white/25 inline" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-4">
        <button
          onClick={() => setCursorStack((s) => s.slice(0, -1))}
          disabled={cursorStack.length === 0}
          data-testid="button-newer-payouts"
          className="inline-flex items-center gap-1.5 rounded-xl bg-white/[0.04] border border-white/10 text-white/60 px-4 py-2 text-sm font-medium hover:bg-white/[0.08] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="w-4 h-4" /> Newer
        </button>
        <button
          onClick={() => {
            const last = payouts[payouts.length - 1];
            if (last) setCursorStack((s) => [...s, last.id]);
          }}
          disabled={!list?.hasMore}
          data-testid="button-older-payouts"
          className="inline-flex items-center gap-1.5 rounded-xl bg-white/[0.04] border border-white/10 text-white/60 px-4 py-2 text-sm font-medium hover:bg-white/[0.08] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Older <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

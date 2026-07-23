// ─────────────────────────────────────────────────────────────────────────────
// SPORTY NRS — push CUFC's confirmed football registrations into NZ Football's
// National Registration System (Sporty). This is the staff cockpit: candidate
// discovery, per-player preflight (blockers/warnings), an exact payload
// preview (what WOULD be sent — no network call happens building it), a
// confirmed live push, and the blocked/error/excluded queues.
//
// Super-admin only ("sporty" tab — server/sporty-routes.ts::requireTab). All
// preflight/payload logic lives server-side (server/sporty-engine.ts +
// @shared/sporty); this page only renders what the engine already decided.
//
// House style copied from group-vehicles.tsx: react-query via
// useQuery/useMutation, apiRequest/queryClient from @/lib/queryClient (the
// query key IS the url), useToast, shadcn Dialog, dark-glass Tailwind, stat
// chips that double as filters, page-local types mirroring the server
// response. Dates are ISO strings split by hand for display — never
// `new Date(iso)` (see group-vehicles.tsx's header comment for why).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  CloudUpload, Wifi, RefreshCw, Search, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, AlertTriangle, Ban, Loader2, ShieldAlert, FileJson,
} from "lucide-react";

// ── Types (mirror server/sporty-routes.ts response shapes) ──────────────────

interface SportyIssue {
  severity: "blocker" | "warning";
  code: string;
  field?: string;
  message: string;
}

interface SportyCandidateRow {
  contactId: number;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  programs: string[];
  seasonYears: number[];
  lastRegisteredAt: string | null;
  displayStatus: string;
  isMinor: boolean | null;
  sportyId: number | null;
  personFifaId: string | null;
  blockReason: string | null;
  lastError: string | null;
  lastPushedAt: string | null;
  excludedReason: string | null;
  issues: SportyIssue[];
  payload: Record<string, unknown> | null;
}

interface SportyOverview {
  counts: {
    total: number; ready: number; needs_data: number; synced: number;
    changed: number; blocked: number; error: number; excluded: number; pending: number;
  };
  config: { installed: boolean; baseUrl: string | null; autosync: boolean };
  reference: { fetchedAt: string | null; countries: number; genders: string[]; ethnicityGroups: string[] };
  lastPushAt: string | null;
}

interface PushResultRow {
  contactId: number;
  name: string;
  outcome: string; // synced | blocked | error | skipped_needs_data | skipped_unchanged | skipped_excluded
  message?: string;
  sportyId?: number | null;
}

interface PushRunResult {
  results: PushResultRow[];
  aborted?: string;
}

interface SportyLogRow {
  id: number;
  endpoint: string;
  baseUrl: string;
  outcome: string;
  httpStatus: number | null;
  sportyId: number | null;
  message: string | null;
  requestPayload: unknown;
  responseBody: unknown;
  createdAt: string;
}

type Scope = "academy" | "all";

// ── Status colours — one place every pill/chip gets its colour ──────────────
const STATUS_META: Record<string, { label: string; color: string }> = {
  ready: { label: "Ready", color: "#10b981" },
  needs_data: { label: "Needs data", color: "#f59e0b" },
  synced: { label: "Synced", color: "#0ea5e9" },
  changed: { label: "Changed", color: "#8b5cf6" },
  blocked: { label: "Blocked", color: "#ef4444" },
  error: { label: "Error", color: "#ef4444" },
  excluded: { label: "Excluded", color: "#71717a" },
  pending: { label: "Pending", color: "#94a3b8" },
};

const CHIP_DEFS: { key: string; label: string; countKey: keyof SportyOverview["counts"]; color: string }[] = [
  { key: "all", label: "Total", countKey: "total", color: "#3b82f6" },
  { key: "ready", label: "Ready", countKey: "ready", color: STATUS_META.ready.color },
  { key: "needs_data", label: "Needs data", countKey: "needs_data", color: STATUS_META.needs_data.color },
  { key: "synced", label: "Synced", countKey: "synced", color: STATUS_META.synced.color },
  { key: "changed", label: "Changed", countKey: "changed", color: STATUS_META.changed.color },
  { key: "blocked", label: "Blocked", countKey: "blocked", color: STATUS_META.blocked.color },
  { key: "error", label: "Errors", countKey: "error", color: STATUS_META.error.color },
  { key: "excluded", label: "Excluded", countKey: "excluded", color: STATUS_META.excluded.color },
];

// Only these can be selected for a push — everything else needs a fix, is
// already in sync, or has been deliberately parked.
const SELECTABLE_STATUSES = new Set(["ready", "changed", "error"]);

function isProdBaseUrl(baseUrl: string | null | undefined): boolean {
  return !!baseUrl && baseUrl.includes("www.sporty.co.nz");
}

// ── Date helper — ISO string in, "17 Jul 2026" out. NEVER `new Date(iso)`. ──
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const datePart = iso.slice(0, 10);
  const parts = datePart.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return iso;
  return `${Number(d)} ${MONTHS_SHORT[mi]} ${y}`;
}

/** Best-effort extraction of the server's JSON `message` out of an apiRequest error. */
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

const inputCls = "rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";
const selectCls = "rounded-lg bg-white/[0.04] border border-white/10 px-2 py-1.5 text-[12px] text-white/80 focus:outline-none focus:border-blue-500/50 cursor-pointer";
const secondaryBtnCls = "inline-flex items-center gap-1.5 rounded-lg bg-white/[0.03] border border-white/10 text-white/60 px-3 py-1.5 text-[12px] font-medium hover:bg-white/[0.06] hover:text-white/85 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

const OVERVIEW_PREFIX = "/api/admin/sporty/overview";
const CANDIDATES_PREFIX = "/api/admin/sporty/candidates";

function invalidateSporty() {
  queryClient.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey[0];
      return typeof key === "string" && (key.startsWith(OVERVIEW_PREFIX) || key.startsWith(CANDIDATES_PREFIX));
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
export default function SportySync() {
  const { toast } = useToast();
  const [scope, setScope] = useState<Scope>("academy");
  const [search, setSearch] = useState("");
  const [chipFilter, setChipFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pushResults, setPushResults] = useState<PushRunResult | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [logContactId, setLogContactId] = useState<number | null>(null);
  const [excludeTarget, setExcludeTarget] = useState<{ contactId: number; name: string } | null>(null);

  const overviewKey = [`${OVERVIEW_PREFIX}?scope=${scope}`];
  const { data: overview } = useQuery<SportyOverview>({ queryKey: overviewKey });

  const candidatesKey = [`${CANDIDATES_PREFIX}?scope=${scope}`];
  const { data: candidatesData, isLoading } = useQuery<{ rows: SportyCandidateRow[] }>({ queryKey: candidatesKey });
  const rows = candidatesData?.rows ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (chipFilter !== "all" && r.displayStatus !== chipFilter) return false;
      if (q && !`${r.firstName ?? ""} ${r.lastName ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, chipFilter, search]);

  const handleScopeChange = (next: Scope) => {
    setScope(next);
    setSelected(new Set());
    setChipFilter("all");
  };

  const testConnMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/sporty/test-connection");
      return (await res.json()) as { installed: boolean; baseUrl?: string; ok?: boolean; genders?: string[]; error?: string };
    },
    onSuccess: (data) => {
      if (!data.installed) {
        toast({ title: "Not installed", description: data.error || "Sporty API credentials aren't in .env yet.", variant: "destructive" });
      } else if (data.ok) {
        toast({ title: "Connection OK", description: data.genders?.length ? `Genders: ${data.genders.join(", ")}` : "Sporty responded." });
      } else {
        toast({ title: "Connection failed", description: data.error || "Sporty didn't respond as expected.", variant: "destructive" });
      }
    },
    onError: (e: unknown) => toast({ title: "Test failed", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const refreshRefMut = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/sporty/refresh-reference");
      return (await res.json()) as { ok: boolean; countries: number; genders: number; ethnicityGroups: number };
    },
    onSuccess: (data) => {
      toast({ title: "Reference data refreshed", description: `${data.countries} countries · ${data.genders} genders · ${data.ethnicityGroups} ethnicity groups` });
      invalidateSporty();
    },
    onError: (e: unknown) => toast({ title: "Couldn't refresh reference data", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const pushMut = useMutation({
    mutationFn: async (contactIds: number[]) => {
      const res = await apiRequest("POST", "/api/admin/sporty/push", { contactIds, confirm: true, scope });
      return (await res.json()) as PushRunResult;
    },
    onSuccess: (data) => {
      setPushResults(data);
      setResultsOpen(true);
      setConfirmOpen(false);
      setSelected(new Set());
      invalidateSporty();
    },
    onError: (e: unknown) => {
      toast({ title: "Push failed", description: apiErrorMessage(e), variant: "destructive" });
      setConfirmOpen(false);
    },
  });

  const excludeMut = useMutation({
    mutationFn: async (body: { contactId: number; excluded: boolean; reason?: string }) => {
      await apiRequest("POST", "/api/admin/sporty/exclude", body);
      return body;
    },
    onSuccess: (vars) => {
      invalidateSporty();
      toast({ title: vars.excluded ? "Excluded" : "Included again" });
      setExcludeTarget(null);
    },
    onError: (e: unknown) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllReadyChanged = () => {
    const ids = rows.filter((r) => r.displayStatus === "ready" || r.displayStatus === "changed").map((r) => r.contactId);
    setSelected(new Set(ids));
  };

  const canPush = overview?.config.installed === true && selected.size > 0;
  const prod = isProdBaseUrl(overview?.config.baseUrl);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto text-white/90">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <CloudUpload className="w-5 h-5 text-blue-400" /> Sporty NRS
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Push confirmed registrations into NZ Football's National Registration System.
          </p>
          {overview?.config.installed && (
            <div className="flex items-center gap-2 mt-2 text-[11px] text-white/40">
              <span className="font-mono">{overview.config.baseUrl}</span>
              {prod ? <Pill label="PRODUCTION" color="#ef4444" /> : <Pill label="UAT" color="#94a3b8" />}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => testConnMut.mutate()}
            disabled={testConnMut.isPending}
            data-testid="button-test-connection"
            className={secondaryBtnCls}
          >
            {testConnMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
            Test connection
          </button>
          <button
            onClick={() => refreshRefMut.mutate()}
            disabled={refreshRefMut.isPending}
            data-testid="button-refresh-reference"
            className={secondaryBtnCls}
          >
            {refreshRefMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh reference data
          </button>
        </div>
      </div>

      {/* Setup banner */}
      {overview && !overview.config.installed && (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4 mb-5 flex items-start gap-3">
          <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-[13px] text-amber-200/80 leading-relaxed">
            UAT API keys not installed yet. NZ Football (Rodrigo Stephanou) provides UAT keys once development is
            confirmed complete — add <code className="text-amber-100/90">SPORTY_API_KEY</code> /{" "}
            <code className="text-amber-100/90">SPORTY_API_USERNAME</code> /{" "}
            <code className="text-amber-100/90">SPORTY_API_PASSWORD</code> to .env. Preview works now; pushing needs keys.
          </p>
        </div>
      )}

      {/* Stat chips — filters */}
      {overview && (
        <div className="flex flex-wrap gap-2 mb-4">
          {CHIP_DEFS.map((c) => {
            const active = chipFilter === c.key;
            const value = overview.counts[c.countKey];
            return (
              <button
                key={c.key}
                onClick={() => setChipFilter(active ? "all" : c.key)}
                data-testid={`filter-chip-${c.key}`}
                className="rounded-xl border px-3 py-2 text-left transition-colors"
                style={{
                  borderColor: active ? `${c.color}88` : "rgba(255,255,255,0.06)",
                  background: active ? `${c.color}18` : "rgba(255,255,255,0.02)",
                }}
              >
                <div className="text-[10px] font-medium" style={{ color: c.color }}>{c.label}</div>
                <div className="text-lg font-semibold mt-0.5">{value}</div>
              </button>
            );
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select
          value={scope}
          onChange={(e) => handleScopeChange(e.target.value as Scope)}
          data-testid="select-scope"
          className={selectCls}
        >
          <option value="academy">Academy</option>
          <option value="all">All football programmes</option>
        </select>
        <button onClick={selectAllReadyChanged} data-testid="button-select-ready-changed" className={secondaryBtnCls}>
          Select all ready + changed
        </button>
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search players…"
            data-testid="input-search-candidates"
            className={inputCls + " pl-8 pr-3 py-1.5 w-full sm:w-56"}
          />
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          disabled={!canPush}
          data-testid="button-push-selected"
          className="inline-flex items-center gap-2 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-300 px-4 py-2 text-sm font-medium hover:bg-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <CloudUpload className="w-4 h-4" /> Push selected ({selected.size})
        </button>
      </div>

      {/* Candidates table */}
      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !rows.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <CloudUpload className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm max-w-sm mx-auto">
            No confirmed football registrations found for this workspace yet.
          </div>
        </div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <div className="text-white/50 text-sm">Nothing matches your filters.</div>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] overflow-x-auto">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead>
              <tr className="bg-white/[0.03] text-left text-[11px] uppercase tracking-wide text-white/35">
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2 w-8"></th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">DOB</th>
                <th className="px-3 py-2">Programmes</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">SportyId</th>
                <th className="px-3 py-2">Last pushed</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <CandidateRows
                  key={r.contactId}
                  row={r}
                  selected={selected.has(r.contactId)}
                  onToggleSelect={() => toggleSelected(r.contactId)}
                  expanded={expanded.has(r.contactId)}
                  onToggleExpand={() => toggleExpanded(r.contactId)}
                  onViewLog={() => setLogContactId(r.contactId)}
                  onExclude={() => setExcludeTarget({ contactId: r.contactId, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() })}
                  onInclude={() => excludeMut.mutate({ contactId: r.contactId, excluded: false })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Confirm push dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md bg-[#0a0f1a] border border-white/10 text-white/90">
          <DialogHeader>
            <DialogTitle>Push {selected.size} player{selected.size === 1 ? "" : "s"} to Sporty?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[13px] text-white/60">
            <p>
              This sends {selected.size} player{selected.size === 1 ? "" : "s"} to{" "}
              <span className="font-mono text-white/80">{overview?.config.baseUrl ?? "—"}</span>.
            </p>
            {prod && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-200/90 text-[12px]">
                  This is the PRODUCTION Sporty environment. These players will be registered for real with NZ Football.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <button onClick={() => setConfirmOpen(false)} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">
              Cancel
            </button>
            <button
              onClick={() => pushMut.mutate(Array.from(selected))}
              disabled={pushMut.isPending}
              data-testid="button-confirm-push"
              className="inline-flex items-center gap-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-200 px-4 py-2 text-sm font-medium hover:bg-blue-500/30 disabled:opacity-50 transition-colors"
            >
              {pushMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CloudUpload className="w-4 h-4" />}
              {pushMut.isPending ? "Pushing…" : "Confirm push"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Push results dialog */}
      <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
        <DialogContent className="max-w-lg bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Push results</DialogTitle>
          </DialogHeader>
          {pushResults?.aborted && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 flex items-start gap-2 mb-2">
              <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <p className="text-red-200/90 text-[12px]">Run stopped early: {pushResults.aborted}</p>
            </div>
          )}
          <div className="space-y-1.5">
            {pushResults?.results.map((r) => (
              <PushResultLine key={r.contactId} result={r} />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <LogDialog contactId={logContactId} onClose={() => setLogContactId(null)} />

      <ExcludeDialog
        target={excludeTarget}
        saving={excludeMut.isPending}
        onCancel={() => setExcludeTarget(null)}
        onConfirm={(reason) => {
          if (!excludeTarget) return;
          excludeMut.mutate({ contactId: excludeTarget.contactId, excluded: true, reason });
        }}
      />
    </div>
  );
}

// ═══ CANDIDATE ROW (+ expanded detail) ════════════════════════════════════════
function CandidateRows({ row, selected, onToggleSelect, expanded, onToggleExpand, onViewLog, onExclude, onInclude }: {
  row: SportyCandidateRow;
  selected: boolean;
  onToggleSelect: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
  onViewLog: () => void;
  onExclude: () => void;
  onInclude: () => void;
}) {
  const meta = STATUS_META[row.displayStatus] ?? STATUS_META.pending;
  const canSelect = SELECTABLE_STATUSES.has(row.displayStatus);
  const name = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || `Contact ${row.contactId}`;
  const isExcluded = row.displayStatus === "excluded";

  return (
    <>
      <tr
        className="border-t border-white/[0.05] hover:bg-white/[0.02] cursor-pointer"
        onClick={onToggleExpand}
        data-testid={`row-candidate-${row.contactId}`}
      >
        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            disabled={!canSelect}
            onChange={onToggleSelect}
            className="accent-blue-500 disabled:opacity-30"
            title={canSelect ? undefined : "Only ready, changed or error players can be pushed"}
            data-testid={`checkbox-select-${row.contactId}`}
          />
        </td>
        <td className="px-3 py-2 text-white/30">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-white/90 font-medium">{name}</span>
            {row.isMinor && <Pill label="Minor" color="#94a3b8" />}
          </div>
        </td>
        <td className="px-3 py-2 text-white/50">{formatDate(row.dateOfBirth)}</td>
        <td className="px-3 py-2 text-white/50 max-w-[220px] truncate" title={row.programs.join(", ")}>
          {row.programs.join(", ") || "—"}
        </td>
        <td className="px-3 py-2"><Pill label={meta.label} color={meta.color} /></td>
        <td className="px-3 py-2 text-white/50 font-mono text-[12px]">{row.sportyId ?? "—"}</td>
        <td className="px-3 py-2 text-white/50">{formatDate(row.lastPushedAt)}</td>
      </tr>
      {expanded && (
        <tr className="border-t border-white/[0.05] bg-white/[0.015]">
          <td colSpan={8} className="px-4 py-4">
            {(row.blockReason || row.lastError) && (
              <div className="rounded-lg border border-red-500/25 bg-red-500/[0.06] px-3 py-2 mb-3 text-[12px] text-red-200/85">
                {row.blockReason && <div><span className="font-semibold">Blocked:</span> {row.blockReason}</div>}
                {row.lastError && <div className={row.blockReason ? "mt-1" : ""}><span className="font-semibold">Last error:</span> {row.lastError}</div>}
              </div>
            )}
            {isExcluded && row.excludedReason && (
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 mb-3 text-[12px] text-white/60">
                <span className="font-semibold">Excluded:</span> {row.excludedReason}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/35 font-semibold mb-2">Preflight</div>
                {row.issues.length === 0 ? (
                  <div className="flex items-center gap-1.5 text-[12px] text-emerald-300/80">
                    <CheckCircle2 className="w-3.5 h-3.5" /> No issues — ready to push
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {row.issues.map((issue, i) => (
                      <li
                        key={i}
                        className={`flex items-start gap-1.5 text-[12px] ${issue.severity === "blocker" ? "text-red-300/85" : "text-amber-300/85"}`}
                      >
                        {issue.severity === "blocker"
                          ? <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                        <span>{issue.message}{issue.field ? <span className="text-white/30"> ({issue.field})</span> : null}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wider text-white/35 font-semibold mb-2 flex items-center gap-1.5">
                  <FileJson className="w-3.5 h-3.5" /> Payload preview
                </div>
                {row.payload ? (
                  <pre className="text-[11px] text-white/60 bg-black/30 border border-white/10 rounded-lg p-2.5 max-h-64 overflow-auto">
                    {JSON.stringify(row.payload, null, 2)}
                  </pre>
                ) : (
                  <div className="text-[12px] text-white/35 italic">Payload can't be built until blockers are fixed.</div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <button onClick={onViewLog} data-testid={`button-view-log-${row.contactId}`} className={secondaryBtnCls}>
                View log
              </button>
              {isExcluded ? (
                <button onClick={onInclude} data-testid={`button-include-${row.contactId}`} className={secondaryBtnCls}>
                  Include
                </button>
              ) : (
                <button onClick={onExclude} data-testid={`button-exclude-${row.contactId}`} className={secondaryBtnCls}>
                  <Ban className="w-3.5 h-3.5" /> Exclude
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ═══ PUSH RESULT LINE ══════════════════════════════════════════════════════════
function PushResultLine({ result }: { result: PushResultRow }) {
  const cfg = result.outcome === "synced"
    ? { icon: CheckCircle2, color: "#10b981" }
    : result.outcome === "blocked" || result.outcome === "error"
      ? { icon: XCircle, color: "#ef4444" }
      : { icon: Ban, color: "#71717a" }; // skipped_needs_data | skipped_unchanged | skipped_excluded
  const Icon = cfg.icon;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <Icon className="w-4 h-4 shrink-0 mt-0.5" style={{ color: cfg.color }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-white/85 flex items-center gap-2">
          <span className="font-medium">{result.name}</span>
          <span className="text-[10px] uppercase tracking-wide" style={{ color: cfg.color }}>{result.outcome.replace(/_/g, " ")}</span>
        </div>
        {result.message && <div className="text-[12px] text-white/45 mt-0.5">{result.message}</div>}
        {result.sportyId != null && <div className="text-[11px] text-white/30 font-mono mt-0.5">SportyId {result.sportyId}</div>}
      </div>
    </div>
  );
}

// ═══ LOG DIALOG ════════════════════════════════════════════════════════════════
function LogDialog({ contactId, onClose }: { contactId: number | null; onClose: () => void }) {
  const logKey = [`/api/admin/sporty/log?contactId=${contactId}`];
  const { data, isLoading } = useQuery<{ rows: SportyLogRow[] }>({ queryKey: logKey, enabled: contactId != null });
  const rows = data?.rows ?? [];

  return (
    <Dialog open={contactId != null} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl bg-[#0a0f1a] border border-white/10 text-white/90 max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Push log</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="text-white/30 text-sm py-8 text-center">Loading…</div>
        ) : !rows.length ? (
          <div className="text-white/40 text-sm py-8 text-center">No push attempts recorded yet.</div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => (
              <div key={row.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px]">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-medium text-white/80">{row.outcome}</span>
                  <span className="text-white/35">{formatDate(row.createdAt)}</span>
                </div>
                <div className="text-white/40 text-[11px] mb-1">
                  {row.endpoint} · {row.baseUrl}
                  {row.httpStatus != null ? ` · HTTP ${row.httpStatus}` : ""}
                  {row.sportyId != null ? ` · SportyId ${row.sportyId}` : ""}
                </div>
                {row.message && <div className="text-white/55 mb-1">{row.message}</div>}
                <details className="text-white/40">
                  <summary className="cursor-pointer text-[11px] text-white/35">Raw request / response</summary>
                  <pre className="text-[10px] mt-1 bg-black/30 border border-white/10 rounded p-2 overflow-auto max-h-40">
                    {JSON.stringify({ request: row.requestPayload, response: row.responseBody }, null, 2)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ═══ EXCLUDE DIALOG ════════════════════════════════════════════════════════════
function ExcludeDialog({ target, saving, onCancel, onConfirm }: {
  target: { contactId: number; name: string } | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    setReason("");
  }, [target?.contactId]);

  return (
    <Dialog open={target != null} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-sm bg-[#0a0f1a] border border-white/10 text-white/90">
        <DialogHeader>
          <DialogTitle>Exclude {target?.name || "this player"}?</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-white/50 mb-2">
          Excluded players are skipped by every push until re-included.
        </p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          data-testid="input-exclude-reason"
          className={inputCls + " w-full min-h-[70px]"}
        />
        <DialogFooter>
          <button onClick={onCancel} className="rounded-xl px-4 py-2 text-sm text-white/50 hover:text-white/80">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason.trim())}
            disabled={saving}
            data-testid="button-confirm-exclude"
            className="inline-flex items-center gap-2 rounded-xl bg-red-500/15 border border-red-500/30 text-red-300 px-4 py-2 text-sm font-medium hover:bg-red-500/25 disabled:opacity-50 transition-colors"
          >
            {saving ? "Excluding…" : "Exclude"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

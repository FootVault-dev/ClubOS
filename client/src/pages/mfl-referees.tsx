// ─────────────────────────────────────────────────────────────────────────────
// MFL REFEREES — the staff-facing "Referees" admin page, Mini Football
// Leagues workspace. Cloned from client/src/pages/cic-referees.tsx. Manages
// referees who self-signed-up to score league nights on their phones
// (server/mfl-referee-routes.ts, a SEPARATE identity from ClubOS staff
// users — same reasoning as the CIC referees).
//
// Two views: APPROVALS (who signed up, approve/decline/suspend them) and
// ASSIGNMENTS (which games each approved referee is assigned to for a given
// Term — a soft default for their "My games" list; any approved ref can
// still score any MFL game, assignment is accountability not a hard lock).
//
// House style + react-query/apiRequest patterns copied 1:1 from
// cic-referees.tsx. Status list is kept LOCAL to this file (not imported
// from a shared module) since MFL referees are their own status enum,
// independent of shared/referees.ts (CIC-only).
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspace } from "@/lib/workspace-context";
import {
  ShieldCheck, UserCheck, CalendarCheck, Search, Trash2, Mail, Phone,
  Check, Ban, RotateCcw, XCircle, LogIn, MapPin, CalendarDays, Copy, Link2,
} from "lucide-react";
import type { LeagueCompetition, LeagueTeam } from "@shared/schema";

// ── Types (mirror server/mfl-referee-routes.ts response shapes) ────────────
const MFL_REFEREE_STATUSES = ["pending", "approved", "suspended", "declined"] as const;
type MflRefereeStatus = (typeof MFL_REFEREE_STATUSES)[number];

interface MflReferee {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  status: MflRefereeStatus;
  assignmentCount: number;
  approvedBy: number | null;
  decidedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  // Invoice/payment details — what the coordinator needs to fill the
  // fortnightly per-ref invoice. Null for refs who signed up before
  // 2026-07-13 (server/league-referee-routes.ts).
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  address: string | null;
  gstNumber: string | null;
}

interface MflRefereeAssignment {
  id: number;
  refereeId: number;
  gameId: number;
  assignedBy: number | null;
  createdAt: string;
}

// Mirror shared/schema.ts `leagueGames` — only the fields this page reads.
interface LeagueGameRow {
  id: number;
  competitionId: number;
  divisionId: number | null;
  homeTeamId: number | null;
  awayTeamId: number | null;
  gameNumber: number | null;
  gameDate: string | null;
  startTime: string | null;
  location: string | null;
  status: string;
}

// ── Config ───────────────────────────────────────────────────────────────────
const STATUS_META: Record<MflRefereeStatus, { label: string; color: string }> = {
  pending: { label: "Pending", color: "#3b82f6" },
  approved: { label: "Approved", color: "#22c55e" },
  suspended: { label: "Suspended", color: "#f97316" },
  declined: { label: "Declined", color: "#6b7280" },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// For real timestamps (createdAt / lastLoginAt / decidedAt) — these carry a
// real instant, so a Date-object round-trip is safe.
const fmtRelative = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
};

// For `gameDate` — a DATE-only column ("YYYY-MM-DD", no time). Parse the
// string directly rather than round-tripping through `new Date()`, which
// shifts a bare date by the browser's timezone offset.
function fmtDateOnly(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${parseInt(m[3], 10)} ${months[parseInt(m[2], 10) - 1]}`;
}

const inputCls = "w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 disabled:opacity-40 disabled:cursor-not-allowed";

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
export default function MflReferees() {
  const [view, setView] = useState<"approvals" | "assignments">("approvals");

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto text-white/90">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-blue-400" /> Referees
          </h1>
          <p className="text-[13px] text-white/40 mt-1 max-w-xl">
            Approve referee sign-ups and assign them to league nights for Mini Football Leagues.
          </p>
        </div>
        <div className="inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1">
          <button
            onClick={() => setView("approvals")}
            data-testid="tab-approvals"
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              view === "approvals" ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/70"
            }`}
          >
            <UserCheck className="w-3.5 h-3.5" /> Approvals
          </button>
          <button
            onClick={() => setView("assignments")}
            data-testid="tab-assignments"
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              view === "assignments" ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/70"
            }`}
          >
            <CalendarCheck className="w-3.5 h-3.5" /> Assignments
          </button>
        </div>
      </div>

      <div className="mb-5 rounded-xl border border-[#d1b96e]/25 bg-[#d1b96e]/[0.04] p-3">
        <div className="text-[12px] font-semibold text-[#d1b96e] mb-2 flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> Share these with new referees
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <ShareRow label="Sign-up — refs register here" url="https://app.usg.co.nz/mfl-ref/signup" />
          <ShareRow label="Login — for approved refs" url="https://app.usg.co.nz/mfl-ref" />
        </div>
        <p className="text-[11px] text-white/30 mt-2">ref.minifootball.co.nz coming — same clean /login /signup links once the domain is wired up.</p>
      </div>

      {view === "approvals" ? <ApprovalsView /> : <AssignmentsView />}
    </div>
  );
}

function ShareRow({ label, url }: { label: string; url: string }) {
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: url });
    } catch {
      toast({ title: "Couldn't copy", description: url, variant: "destructive" });
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-white/35">{label}</div>
        <a href={url} target="_blank" rel="noreferrer" className="block truncate text-[13px] text-white/80 hover:text-[#d1b96e]">{url}</a>
      </div>
      <button
        onClick={copy}
        className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[#d1b96e]/40 bg-[#d1b96e]/10 px-2.5 py-1.5 text-[12px] font-semibold text-[#d1b96e] hover:bg-[#d1b96e]/20"
      >
        <Copy className="w-3.5 h-3.5" /> Copy
      </button>
    </div>
  );
}

// ═══ APPROVALS ═══════════════════════════════════════════════════════════════
function ApprovalsView() {
  const { toast } = useToast();
  // Default to "pending" so new sign-ups are front-and-centre; clicking the
  // active chip (or "All") clears the filter.
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [search, setSearch] = useState("");

  const queryKey = ["/api/admin/mfl-referees"];
  const { data, isLoading } = useQuery<{ referees: MflReferee[] }>({ queryKey });
  const referees = data?.referees ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const updateMut = useMutation({
    mutationFn: ({ id, status }: { id: number; status: MflRefereeStatus }) =>
      apiRequest("PATCH", `/api/admin/mfl-referees/${id}`, { status }),
    onSuccess: () => invalidate(),
    onError: (e: unknown) => toast({ title: "Couldn't update status", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/mfl-referees/${id}`),
    onSuccess: () => {
      invalidate();
      // Assignments for this referee are cascade-deleted server-side.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mfl-referees/assignments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/mfl/approved-referees"] });
      toast({ title: "Referee removed" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't delete", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: referees.length };
    for (const st of MFL_REFEREE_STATUSES) c[st] = 0;
    for (const r of referees) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [referees]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return referees.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (q) {
        const hay = `${r.fullName} ${r.email} ${r.phone}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [referees, statusFilter, search]);

  return (
    <>
      {/* stat chips — filters, default "pending" */}
      <div className="flex flex-wrap gap-2 mb-4">
        <button
          onClick={() => setStatusFilter("all")}
          data-testid="filter-status-all"
          className="rounded-xl border px-3 py-2 text-left transition-colors"
          style={{
            borderColor: statusFilter === "all" ? "#3b82f688" : "rgba(255,255,255,0.06)",
            background: statusFilter === "all" ? "#3b82f618" : "rgba(255,255,255,0.02)",
          }}
        >
          <div className="text-[10px] font-medium text-white/50">All</div>
          <div className="text-lg font-semibold mt-0.5">{counts.all}</div>
        </button>
        {MFL_REFEREE_STATUSES.map((st) => {
          const meta = STATUS_META[st];
          const active = statusFilter === st;
          return (
            <button
              key={st}
              onClick={() => setStatusFilter(active ? "all" : st)}
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

      <div className="flex items-center gap-2 mb-4">
        <div className="relative ml-auto">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, phone…"
            data-testid="input-search-referees"
            className="rounded-lg bg-white/[0.03] border border-white/10 pl-8 pr-3 py-1.5 text-[13px] text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50 w-full sm:w-72"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading…</div>
      ) : !filtered.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <UserCheck className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">
            {referees.length ? "Nothing matches your filters." : "No referee sign-ups yet."}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((ref) => (
            <RefereeCard
              key={ref.id}
              referee={ref}
              onSetStatus={(status) => updateMut.mutate({ id: ref.id, status })}
              onDelete={() => {
                if (
                  confirm(
                    `Remove ${ref.fullName}'s referee account? This deletes their account and any game assignments — it can't be undone.`,
                  )
                ) {
                  deleteMut.mutate(ref.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

function RefereeCard({ referee, onSetStatus, onDelete }: {
  referee: MflReferee;
  onSetStatus: (status: MflRefereeStatus) => void;
  onDelete: () => void;
}) {
  const meta = STATUS_META[referee.status] ?? STATUS_META.pending;

  return (
    <div
      data-testid={`card-referee-${referee.id}`}
      className="rounded-2xl border border-white/[0.06] bg-white/[0.02] hover:border-white/10 transition-colors p-4"
    >
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-[14px] text-white/90">{referee.fullName}</span>
            <Pill label={meta.label} color={meta.color} />
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-1 text-[12px] text-white/45">
            <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{referee.email}</span>
            <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{referee.phone}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap mt-1.5 text-[11px] text-white/30">
            <span>Signed up {fmtRelative(referee.createdAt)}</span>
            <span className="flex items-center gap-1"><LogIn className="w-3 h-3" /> Last login {fmtRelative(referee.lastLoginAt)}</span>
            <span className="flex items-center gap-1">
              <CalendarCheck className="w-3 h-3" /> {referee.assignmentCount} game{referee.assignmentCount === 1 ? "" : "s"} assigned
            </span>
          </div>
          <InvoiceDetailsBlock referee={referee} />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {referee.status === "pending" && (
            <>
              <button
                onClick={() => onSetStatus("approved")}
                data-testid={`button-approve-${referee.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-500/25 transition-colors"
              >
                <Check className="w-3.5 h-3.5" /> Approve
              </button>
              <button
                onClick={() => onSetStatus("declined")}
                data-testid={`button-decline-${referee.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/50 px-3 py-1.5 text-[12px] font-medium hover:bg-white/[0.08] transition-colors"
              >
                <XCircle className="w-3.5 h-3.5" /> Decline
              </button>
            </>
          )}
          {referee.status === "approved" && (
            <button
              onClick={() => onSetStatus("suspended")}
              data-testid={`button-suspend-${referee.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500/15 border border-orange-500/30 text-orange-300 px-3 py-1.5 text-[12px] font-medium hover:bg-orange-500/25 transition-colors"
            >
              <Ban className="w-3.5 h-3.5" /> Suspend
            </button>
          )}
          {(referee.status === "suspended" || referee.status === "declined") && (
            <button
              onClick={() => onSetStatus("approved")}
              data-testid={`button-reapprove-${referee.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 px-3 py-1.5 text-[12px] font-medium hover:bg-emerald-500/25 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Re-approve
            </button>
          )}
          <button
            onClick={onDelete}
            data-testid={`button-delete-referee-${referee.id}`}
            className="w-7 h-7 rounded-lg text-white/30 hover:text-red-400 hover:bg-white/[0.06] flex items-center justify-center"
            title="Delete referee"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// Muted "invoice details" block on each referee card — what the coordinator
// needs to fill the fortnightly per-ref invoice, plus a Copy button that puts
// all lines on the clipboard as plain text ready to paste into the invoice
// template. Refs created before 2026-07-13 have no payment fields at all —
// shown plainly rather than as blank/zero values.
function InvoiceDetailsBlock({ referee }: { referee: MflReferee }) {
  const { toast } = useToast();
  const hasDetails = !!(referee.bankAccountName || referee.bankAccountNumber || referee.bankName || referee.address);

  if (!hasDetails) {
    return (
      <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2 text-[11px] text-white/30">
        No payment details yet (signed up before we collected them).
      </div>
    );
  }

  const rows: { label: string; value: string }[] = [
    { label: "Name", value: referee.bankAccountName || "—" },
    { label: "Bank", value: referee.bankName || "—" },
    { label: "Account", value: referee.bankAccountNumber || "—" },
    { label: "Address", value: referee.address || "—" },
    { label: "GST", value: referee.gstNumber || "—" },
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rows.map((r) => `${r.label}: ${r.value}`).join("\n"));
      toast({ title: "Copied", description: "Invoice details copied — paste into the invoice template." });
    } catch {
      toast({ title: "Couldn't copy", variant: "destructive" });
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.015] px-3 py-2">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-white/30">Invoice details</span>
        <button
          onClick={copy}
          data-testid={`button-copy-invoice-details-${referee.id}`}
          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] font-medium text-white/50 hover:text-white/80 hover:bg-white/[0.06] transition-colors"
        >
          <Copy className="w-3 h-3" /> Copy
        </button>
      </div>
      <div className="space-y-0.5 text-[12px] text-white/55">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-1.5">
            <span className="text-white/30 shrink-0">{r.label}</span>
            <span className="truncate">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══ ASSIGNMENTS ═════════════════════════════════════════════════════════════
function AssignmentsView() {
  const { toast } = useToast();
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const [selectedRefereeId, setSelectedRefereeId] = useState<number | null>(null);
  const [selectedCompetitionId, setSelectedCompetitionId] = useState<number | null>(null);

  // Pre-filtered to approved-only server-side (unlike the CIC page's
  // client-side filter) — GET /api/admin/mfl/approved-referees.
  const { data: refData } = useQuery<{ referees: MflReferee[] }>({ queryKey: ["/api/admin/mfl/approved-referees"] });
  const approvedReferees = refData?.referees ?? [];

  const { data: competitions = [], isLoading: competitionsLoading } = useQuery<LeagueCompetition[]>({
    queryKey: ["/api/admin/league/competitions", orgId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/league/competitions?orgId=${orgId}`);
      return res.json();
    },
    enabled: orgId != null,
  });

  const { data: games = [], isLoading: gamesLoading } = useQuery<LeagueGameRow[]>({
    queryKey: ["/api/admin/league/competitions", selectedCompetitionId, "games"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/league/competitions/${selectedCompetitionId}/games`);
      return res.json();
    },
    enabled: selectedCompetitionId != null,
  });

  const { data: teams = [] } = useQuery<LeagueTeam[]>({
    queryKey: ["/api/admin/league/teams", orgId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/league/teams?orgId=${orgId}`);
      return res.json();
    },
    enabled: orgId != null,
  });
  const teamName = (id: number | null): string | undefined =>
    id != null ? teams.find((t) => t.id === id)?.name : undefined;

  const assignmentsQueryKey = ["/api/admin/mfl-referees/assignments"];
  const { data: assignData } = useQuery<{ assignments: MflRefereeAssignment[] }>({ queryKey: assignmentsQueryKey });
  const assignments = assignData?.assignments ?? [];

  const invalidateAssignments = () => {
    queryClient.invalidateQueries({ queryKey: assignmentsQueryKey });
    // assignmentCount shown on the Approvals tab changes too.
    queryClient.invalidateQueries({ queryKey: ["/api/admin/mfl-referees"] });
  };

  const assignMut = useMutation({
    mutationFn: ({ refereeId, gameId }: { refereeId: number; gameId: number }) =>
      apiRequest("POST", "/api/admin/mfl-referees/assignments", { refereeId, gameId }),
    onSuccess: () => invalidateAssignments(),
    onError: (e: unknown) => toast({ title: "Couldn't assign", description: apiErrorMessage(e), variant: "destructive" }),
  });

  // DELETE with a JSON body — apiRequest(method, url, data) always attaches
  // Content-Type + a JSON body regardless of method, fetch() allows a body on
  // DELETE, and express.json() is mounted globally so it parses the body on
  // every method, not just POST/PATCH.
  const unassignMut = useMutation({
    mutationFn: ({ refereeId, gameId }: { refereeId: number; gameId: number }) =>
      apiRequest("DELETE", "/api/admin/mfl-referees/assignments", { refereeId, gameId }),
    onSuccess: () => invalidateAssignments(),
    onError: (e: unknown) => toast({ title: "Couldn't unassign", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const assignedGameIds = useMemo(
    () => new Set(assignments.filter((a) => a.refereeId === selectedRefereeId).map((a) => a.gameId)),
    [assignments, selectedRefereeId],
  );

  const sortedGames = useMemo(() => {
    return games.slice().sort((a, b) => {
      const ak = `${a.gameDate ?? "9999-99-99"}${a.startTime ?? "99:99"}`;
      const bk = `${b.gameDate ?? "9999-99-99"}${b.startTime ?? "99:99"}`;
      if (ak !== bk) return ak < bk ? -1 : 1;
      return (a.gameNumber ?? 0) - (b.gameNumber ?? 0);
    });
  }, [games]);

  const toggleGame = (gameId: number) => {
    if (selectedRefereeId == null) return;
    if (assignedGameIds.has(gameId)) unassignMut.mutate({ refereeId: selectedRefereeId, gameId });
    else assignMut.mutate({ refereeId: selectedRefereeId, gameId });
  };

  const pending = assignMut.isPending || unassignMut.isPending;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 mb-4">
        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Referee</label>
          <select
            value={selectedRefereeId ?? ""}
            onChange={(e) => setSelectedRefereeId(e.target.value ? Number(e.target.value) : null)}
            data-testid="select-assign-referee"
            className={inputCls + " cursor-pointer"}
          >
            <option value="">Choose an approved referee…</option>
            {approvedReferees.map((r) => (
              <option key={r.id} value={r.id}>{r.fullName} — {r.email}</option>
            ))}
          </select>
          {!approvedReferees.length && (
            <p className="text-[11px] text-white/25 mt-1">No approved referees yet — approve one in the Approvals tab first.</p>
          )}
        </div>
        <div>
          <label className="text-[11px] text-white/40 mb-1 block">Term</label>
          <select
            value={selectedCompetitionId ?? ""}
            onChange={(e) => setSelectedCompetitionId(e.target.value ? Number(e.target.value) : null)}
            data-testid="select-assign-competition"
            className={inputCls + " cursor-pointer"}
            disabled={competitionsLoading || !competitions.length}
          >
            <option value="">Choose a term…</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {!competitionsLoading && !competitions.length && (
            <p className="text-[11px] text-white/25 mt-1">No terms found for this workspace.</p>
          )}
        </div>
      </div>

      {selectedRefereeId == null || selectedCompetitionId == null ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <CalendarCheck className="w-8 h-8 text-white/20 mx-auto mb-3" />
          <div className="text-white/50 text-sm">Pick a referee and a term to see its games.</div>
        </div>
      ) : gamesLoading ? (
        <div className="text-white/30 text-sm py-16 text-center">Loading games…</div>
      ) : !sortedGames.length ? (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <div className="text-white/50 text-sm">This term has no games scheduled yet.</div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[11px] text-white/30 mb-1">
            {assignedGameIds.size} of {sortedGames.length} games assigned to this referee. Any approved referee can
            still score any game — this just sets their default "My games" list.
          </div>
          {sortedGames.map((game) => {
            const assigned = assignedGameIds.has(game.id);
            const home = teamName(game.homeTeamId) ?? "TBC";
            const away = teamName(game.awayTeamId) ?? "TBC";
            return (
              <label
                key={game.id}
                data-testid={`row-game-${game.id}`}
                className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                  assigned ? "border-blue-500/40 bg-blue-500/[0.08]" : "border-white/[0.06] bg-white/[0.02] hover:border-white/10"
                } ${pending ? "opacity-70" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={pending}
                  onChange={() => toggleGame(game.id)}
                  className="accent-blue-500 w-4 h-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-white/85 truncate">
                    {game.gameNumber != null ? `Game ${game.gameNumber} — ` : ""}{home} vs {away}
                  </div>
                  <div className="flex items-center gap-2.5 flex-wrap text-[11px] text-white/40 mt-0.5">
                    {game.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{game.location}</span>}
                    {(game.gameDate || game.startTime) && (
                      <span className="flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {fmtDateOnly(game.gameDate)}{game.startTime ? ` · ${game.startTime}` : ""}
                      </span>
                    )}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
    </>
  );
}

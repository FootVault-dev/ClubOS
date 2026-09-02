import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { UserCog, UserCheck, UserX, X, Search, Plus, Phone, ChevronDown } from "lucide-react";

/** Coaching roster for ONE session — the sibling of the player roll.
 *
 *  Zach's question is "who have I got on tonight, and did they turn up", and
 *  before this the roll answered only the children half of it. */

export const COACH_ROLES = ["lead", "coach", "assistant"] as const;
export type CoachRole = (typeof COACH_ROLES)[number];

export const ROLE_LABEL: Record<string, string> = {
  lead: "Lead",
  coach: "Coach",
  assistant: "Assistant",
};

export type SessionCoach = {
  id: number;
  contactId: number;
  role: string;
  status: string | null;
  markedAt: string | null;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday of a bare ISO date. Anchored at NOON on purpose: `new Date("2026-07-20")`
 *  is parsed as UTC midnight and reads as the 19th in New Zealand. */
export function weekdayOf(isoDate: string | undefined | null): string {
  if (!isoDate) return "";
  return WEEKDAY[new Date(`${isoDate}T12:00:00`).getDay()];
}

/* ── Add a coach ───────────────────────────────────────────────────────────
 * Rendered through a portal into <body>. The programme-detail tab content
 * sits inside `.animate-fade-in-up`, whose `forwards` fill leaves a computed
 * transform of matrix(1,0,0,1,0,0) — not `none` — which makes that ancestor a
 * containing block for `position: fixed`. A modal rendered in place would cover
 * only part of the screen and let a tap fall through to what's behind it. */
export function AddCoachModal({
  campId, campDateId, sessionDate, sessionTime, onClose,
}: {
  campId: number;
  campDateId: number;
  sessionDate?: string | null;
  sessionTime?: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ id: number; firstName: string; lastName: string } | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<CoachRole>("coach");
  const [applyTo, setApplyTo] = useState<"this" | "series">("this");
  const [showNew, setShowNew] = useState(false);

  const { data: coaches = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/coaches"],
    queryFn: async () => {
      const res = await fetch("/api/admin/coaches", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const filtered = q.trim()
    ? coaches.filter(c => `${c.firstName} ${c.lastName}`.toLowerCase().includes(q.trim().toLowerCase()))
    : coaches;

  const add = useMutation({
    mutationFn: async () => {
      const body: any = { campDateId, role, applyTo };
      if (picked) body.contactId = picked.id;
      else { body.firstName = firstName.trim(); body.lastName = lastName.trim(); }
      return apiRequest("POST", `/api/admin/camps/${campId}/session-coaches`, body);
    },
    onSuccess: async (res: any) => {
      let count = 1;
      try { count = (await res.json())?.sessions ?? 1; } catch { /* body already read */ }
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "session-coaches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "coach-overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/coaches"] });
      toast({ title: count > 1 ? `Added to ${count} sessions` : "Added to this session" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't add", description: e.message, variant: "destructive" }),
  });

  const named = picked ? true : firstName.trim() !== "" && lastName.trim() !== "";
  const dayName = weekdayOf(sessionDate);
  const timeLabel = sessionTime ? String(sessionTime).slice(0, 5) : "";

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" />
      {/* items-start on a phone: a centred sheet taller than the viewport clips
          its own top and can't be scrolled back to. */}
      <div
        className="relative rounded-2xl border border-blue-500/[0.12] p-5 sm:p-6 max-w-sm w-full space-y-5 my-8"
        style={{ background: "hsl(var(--card))" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-white/90">Add a coach</h3>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-white/[0.05] flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer" data-testid="button-close-add-coach">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>

        {picked ? (
          <div className="flex items-center justify-between rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-3 py-2.5">
            <span className="text-[13px] text-white/80 font-medium">{picked.firstName} {picked.lastName}</span>
            <button onClick={() => { setPicked(null); setQ(""); }} className="text-[11px] text-blue-300/70 hover:text-blue-200 cursor-pointer min-h-[32px] px-1">Change</button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search coaches…"
                /* 16px: iOS Safari zooms the page when a focused input is smaller. */
                className="w-full pl-10 pr-3 py-3 rounded-xl border border-blue-500/[0.1] bg-blue-500/[0.03] text-[16px] text-white/80 placeholder-white/25 outline-none focus:border-blue-500/25"
                data-testid="input-coach-search"
              />
            </div>
            <div className="rounded-xl border border-white/[0.07] divide-y divide-white/[0.05] max-h-56 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-3 py-4 text-[12px] text-white/25 text-center">No coach matches "{q}"</p>
              ) : filtered.map(c => (
                <button
                  key={c.id}
                  onClick={() => setPicked(c)}
                  className="w-full text-left px-3 min-h-[44px] py-2.5 hover:bg-white/[0.05] transition-colors cursor-pointer"
                  data-testid={`option-coach-${c.id}`}
                >
                  <span className="text-[13px] text-white/75">{c.firstName} {c.lastName}</span>
                </button>
              ))}
            </div>

            <button
              onClick={() => setShowNew(v => !v)}
              className="w-full flex items-center justify-between px-1 min-h-[40px] text-[11px] text-white/40 hover:text-white/60 transition-colors cursor-pointer"
              data-testid="button-toggle-new-coach"
            >
              <span className="uppercase tracking-wider font-semibold">Or add someone new</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showNew ? "rotate-180" : ""}`} />
            </button>
            {showNew && (
              <div className="grid grid-cols-2 gap-2">
                <input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="First name"
                  className="px-3 py-3 rounded-xl border border-blue-500/[0.1] bg-blue-500/[0.03] text-[16px] text-white/80 placeholder-white/25 outline-none focus:border-blue-500/25"
                  data-testid="input-coach-first" />
                <input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Last name"
                  className="px-3 py-3 rounded-xl border border-blue-500/[0.1] bg-blue-500/[0.03] text-[16px] text-white/80 placeholder-white/25 outline-none focus:border-blue-500/25"
                  data-testid="input-coach-last" />
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <label className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Role</label>
          <div className="grid grid-cols-3 gap-2">
            {COACH_ROLES.map(r => (
              <button
                key={r}
                onClick={() => setRole(r)}
                aria-pressed={role === r}
                className={`min-h-[44px] px-2 rounded-xl border text-[12px] font-semibold transition-colors cursor-pointer ${
                  role === r
                    ? "bg-blue-500/25 border-blue-400/50 text-blue-100"
                    : "bg-white/[0.03] border-white/10 text-white/45 hover:bg-white/[0.06]"
                }`}
                data-testid={`button-role-${r}`}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-[10px] text-white/40 uppercase tracking-wider font-semibold">Add them to</label>
          <div className="grid grid-cols-1 gap-2">
            <button
              onClick={() => setApplyTo("this")}
              aria-pressed={applyTo === "this"}
              className={`min-h-[48px] px-3 rounded-xl border text-[12px] font-semibold text-left transition-colors cursor-pointer ${
                applyTo === "this"
                  ? "bg-blue-500/25 border-blue-400/50 text-blue-100"
                  : "bg-white/[0.03] border-white/10 text-white/45 hover:bg-white/[0.06]"
              }`}
              data-testid="button-apply-this"
            >
              This session only
            </button>
            <button
              onClick={() => setApplyTo("series")}
              aria-pressed={applyTo === "series"}
              className={`min-h-[48px] px-3 py-2 rounded-xl border text-[12px] font-semibold text-left transition-colors cursor-pointer ${
                applyTo === "series"
                  ? "bg-blue-500/25 border-blue-400/50 text-blue-100"
                  : "bg-white/[0.03] border-white/10 text-white/45 hover:bg-white/[0.06]"
              }`}
              data-testid="button-apply-series"
            >
              Every {dayName || "week"}{timeLabel ? ` at ${timeLabel}` : ""} from here on
            </button>
          </div>
          {/* Says what it will and won't touch: a coach added to the series
              must not appear to rewrite the sessions already coached. */}
          <p className="text-[11px] text-white/25">
            The series option only adds them to sessions from this one onwards — earlier ones aren't changed.
          </p>
        </div>

        <button
          onClick={() => add.mutate()}
          disabled={!named || add.isPending}
          className={`w-full min-h-[48px] rounded-xl text-[13px] font-semibold transition-colors ${
            named && !add.isPending
              ? "bg-gradient-to-r from-blue-500 to-blue-600 text-white cursor-pointer"
              : "bg-white/[0.04] text-white/25 cursor-not-allowed"
          }`}
          data-testid="button-confirm-add-coach"
        >
          {add.isPending ? "Adding…" : applyTo === "series" ? "Add to every session" : "Add to this session"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

/* ── The card on a session roll ─────────────────────────────────────────── */
export function SessionCoachesCard({
  campId, campDateId, sessionDate, sessionTime,
}: {
  campId: number;
  campDateId: number;
  sessionDate?: string | null;
  sessionTime?: string | null;
}) {
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const key = ["/api/admin/camps", campId, "session-coaches", campDateId];

  const { data: roster = [], isLoading } = useQuery<SessionCoach[]>({
    queryKey: key,
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/session-coaches?campDateId=${campDateId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load coaches");
      return res.json();
    },
    enabled: campId > 0 && campDateId > 0,
  });

  // Optimistic, like the player roll: the tap must light up now, not after a
  // round-trip, and nothing is globally disabled while a save is in flight.
  const mark = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "present" | "absent" | null }) =>
      apiRequest("PATCH", `/api/admin/session-coaches/${id}`, { status }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SessionCoach[]>(key);
      queryClient.setQueryData<SessionCoach[]>(key, old =>
        (old ?? []).map(c => c.id === id ? { ...c, status, markedAt: status ? new Date().toISOString() : null } : c));
      return { previous };
    },
    onError: (e: Error, _v, ctx: any) => {
      if (ctx?.previous) queryClient.setQueryData(key, ctx.previous);
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "coach-overview"] });
    },
  });

  const remove = useMutation({
    mutationFn: async ({ id, scope }: { id: number; scope: "one" | "series" }) =>
      apiRequest("DELETE", `/api/admin/session-coaches/${id}${scope === "series" ? "?scope=series" : ""}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "coach-overview"] });
      toast({ title: "Coach removed" });
    },
    onError: (e: Error) => toast({ title: "Couldn't remove", description: e.message, variant: "destructive" }),
  });

  const here = roster.filter(c => c.status === "present").length;

  return (
    <div className="rounded-xl border border-blue-500/[0.08] bg-blue-500/[0.02] overflow-hidden" data-testid="card-session-coaches">
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-blue-500/[0.06] bg-blue-500/[0.03]">
        <div className="flex items-center gap-2 min-w-0">
          <UserCog className="w-3.5 h-3.5 text-blue-400/50 flex-shrink-0" />
          <span className="text-[10px] text-blue-300/40 uppercase tracking-wider font-semibold">Coaches</span>
          {roster.length > 0 && (
            <span className="text-[11px] text-white/35 truncate" data-testid="text-coach-count">
              {roster.length} on · <span className="text-emerald-400/70">{here} here</span>
            </span>
          )}
        </div>
        <button
          onClick={() => setAddOpen(true)}
          className="min-h-[36px] px-2.5 rounded-lg border border-blue-500/25 bg-blue-500/10 text-[11px] font-semibold text-blue-200/90 hover:bg-blue-500/20 transition-colors cursor-pointer flex items-center gap-1 flex-shrink-0"
          data-testid="button-add-coach"
        >
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
      </div>

      {isLoading ? (
        <div className="px-4 py-4 text-[12px] text-white/25">Loading…</div>
      ) : roster.length === 0 ? (
        /* Amber, not grey: an unstaffed session is a thing to fix, not a
           neutral empty state. */
        <div className="px-4 py-4 flex items-center gap-2">
          <span className="text-[12px] text-amber-300/60" data-testid="text-no-coaches">No coach assigned to this session yet.</span>
        </div>
      ) : (
        <div className="divide-y divide-blue-500/[0.05]">
          {roster.map(c => {
            const isHere = c.status === "present";
            const isAway = c.status === "absent";
            return (
              <div
                key={c.id}
                className={`flex items-center gap-2 px-3 sm:px-4 py-2.5 transition-colors ${isHere ? "bg-emerald-500/[0.07]" : ""}`}
                data-testid={`row-coach-${c.contactId}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-medium text-white/80 truncate">{c.firstName} {c.lastName}</span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider border text-blue-300/70 border-blue-500/25 bg-blue-500/10">
                      {ROLE_LABEL[c.role] ?? c.role}
                    </span>
                  </div>
                  {c.phone && (
                    /* Tap-to-call: Zach is standing on a field wondering where
                       his coach is. */
                    <a href={`tel:${c.phone}`} onClick={e => e.stopPropagation()}
                       className="inline-flex items-center gap-1 mt-0.5 text-[11px] text-blue-400/60 hover:text-blue-400 transition-colors"
                       data-testid={`link-coach-phone-${c.contactId}`}>
                      <Phone className="w-3 h-3" /> {c.phone}
                    </a>
                  )}
                </div>

                <button
                  onClick={() => mark.mutate({ id: c.id, status: isHere ? null : "present" })}
                  aria-pressed={isHere}
                  aria-label={`${c.firstName} present`}
                  className={`min-h-[44px] min-w-[44px] px-2 sm:px-3 rounded-lg border text-[12px] font-semibold transition-colors cursor-pointer flex-shrink-0 ${
                    isHere ? "bg-emerald-500/30 border-emerald-400/60 text-emerald-100"
                           : "bg-emerald-500/[0.06] border-emerald-500/15 text-emerald-400/55 hover:bg-emerald-500/15"
                  }`}
                  data-testid={`button-coach-present-${c.contactId}`}
                >
                  {/* Labelled from `sm` up so this reads the same as the player
                      roll directly below it; icon-only on a phone, where the
                      two buttons plus the name have to fit 390px. */}
                  <UserCheck className="w-4 h-4 inline-block sm:mr-1.5" />
                  <span className="hidden sm:inline">Present</span>
                </button>
                <button
                  onClick={() => mark.mutate({ id: c.id, status: isAway ? null : "absent" })}
                  aria-pressed={isAway}
                  aria-label={`${c.firstName} absent`}
                  className={`min-h-[44px] min-w-[44px] px-2 sm:px-3 rounded-lg border text-[12px] font-semibold transition-colors cursor-pointer flex-shrink-0 ${
                    isAway ? "bg-amber-500/30 border-amber-400/60 text-amber-100"
                           : "bg-amber-500/[0.06] border-amber-500/15 text-amber-400/55 hover:bg-amber-500/15"
                  }`}
                  data-testid={`button-coach-absent-${c.contactId}`}
                >
                  <UserX className="w-4 h-4 inline-block sm:mr-1.5" />
                  <span className="hidden sm:inline">Absent</span>
                </button>
                <button
                  onClick={() => {
                    const series = confirm(
                      `Remove ${c.firstName} ${c.lastName} from EVERY remaining ${weekdayOf(sessionDate)} session at this time?\n\nOK = every remaining one · Cancel = just this session.`,
                    );
                    remove.mutate({ id: c.id, scope: series ? "series" : "one" });
                  }}
                  aria-label={`Remove ${c.firstName}`}
                  className="min-h-[44px] min-w-[36px] rounded-lg text-white/25 hover:text-red-400/80 hover:bg-red-500/[0.08] transition-colors cursor-pointer flex-shrink-0"
                  data-testid={`button-remove-coach-${c.contactId}`}
                >
                  <X className="w-4 h-4 inline-block" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddCoachModal
          campId={campId}
          campDateId={campDateId}
          sessionDate={sessionDate}
          sessionTime={sessionTime}
          onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}

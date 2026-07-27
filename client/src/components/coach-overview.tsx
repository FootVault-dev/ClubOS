import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { UserCog, UserCheck, UserX, AlertTriangle, ChevronRight, CalendarDays, Phone } from "lucide-react";
import { ROLE_LABEL, weekdayOf } from "@/components/session-coaches";

/** The term-wide coaching picture — "what coaches have I got on what days and
 *  what sessions", tracked over the whole term.
 *
 *  Two views over one dataset: BY SESSION (the timetable, week by week, with
 *  unstaffed sessions flagged) and BY COACH (who has done how many, and how
 *  often they actually turned up). */

type OverviewCoach = {
  id: number; contactId: number; role: string;
  status: string | null; markedAt: string | null;
  firstName: string; lastName: string; phone?: string | null;
};
type OverviewSession = {
  campDateId: number; date: string;
  startTime: string | null; endTime: string | null; name: string | null;
  coaches: OverviewCoach[];
};
type Overview = {
  today: string;
  sessions: OverviewSession[];
  coaches: {
    contactId: number; firstName: string; lastName: string; phone?: string | null;
    assigned: number; present: number; absent: number; unmarked: number;
  }[];
};

/** Monday-anchored week key. Noon anchoring throughout — a bare ISO date
 *  parsed by `new Date()` is UTC midnight, which reads a day early in NZ. */
function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  const dow = (d.getDay() + 6) % 7;          // Mon = 0
  d.setDate(d.getDate() - dow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
}

function StatCard({ label, value, tone = "blue", icon: Icon, hint }: {
  label: string; value: string | number; tone?: "blue" | "emerald" | "amber"; icon: any; hint?: string;
}) {
  const tones = {
    blue: "border-blue-500/[0.08] bg-blue-500/[0.03] text-white/85",
    emerald: "border-emerald-500/[0.12] bg-emerald-500/[0.03] text-emerald-400/80",
    amber: "border-amber-500/[0.18] bg-amber-500/[0.05] text-amber-400/85",
  }[tone];
  const iconTone = { blue: "text-blue-400/40", emerald: "text-emerald-400/40", amber: "text-amber-400/50" }[tone];
  return (
    <div className={`rounded-xl border p-3 sm:p-4 ${tones}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${iconTone}`} />
        <span className="text-[9px] sm:text-[10px] text-white/30 uppercase tracking-wider font-semibold leading-tight">{label}</span>
      </div>
      <span className="text-xl sm:text-2xl font-bold">{value}</span>
      {hint && <p className="text-[10px] text-white/25 mt-0.5 leading-tight">{hint}</p>}
    </div>
  );
}

function CoachChip({ c }: { c: OverviewCoach }) {
  const tone = c.status === "present"
    ? "text-emerald-300/90 border-emerald-500/30 bg-emerald-500/10"
    : c.status === "absent"
      ? "text-amber-300/90 border-amber-500/30 bg-amber-500/10"
      : "text-white/50 border-white/10 bg-white/[0.03]";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border ${tone}`}
          data-testid={`chip-coach-${c.contactId}`}>
      {c.status === "present" && <UserCheck className="w-3 h-3" />}
      {c.status === "absent" && <UserX className="w-3 h-3" />}
      <span className="font-medium">{c.firstName} {c.lastName}</span>
      {c.role !== "coach" && <span className="opacity-60 uppercase text-[9px] tracking-wider">{ROLE_LABEL[c.role] ?? c.role}</span>}
    </span>
  );
}

export function CoachOverview({ campId, detailPath }: { campId: number; detailPath: string }) {
  const [, navigate] = useLocation();
  const [view, setView] = useState<"sessions" | "coaches">("sessions");

  const { data, isLoading } = useQuery<Overview>({
    queryKey: ["/api/admin/camps", campId, "coach-overview"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/coach-overview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load the coaching roster");
      return res.json();
    },
    enabled: campId > 0,
  });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />;
  if (!data || data.sessions.length === 0) {
    return (
      <p className="text-[13px] text-white/25 text-center py-8">
        No sessions yet — set the weekly timetable on the Schedule tab first, then assign coaches here.
      </p>
    );
  }

  const { today, sessions, coaches } = data;
  const staffed = sessions.filter(s => s.coaches.length > 0).length;
  // Only sessions that have ALREADY HAPPENED can be judged for turn-up; an
  // unstaffed session next month is a gap to fill, not a failure, so the two
  // numbers are counted over different windows on purpose.
  const upcomingUnstaffed = sessions.filter(s => s.coaches.length === 0 && s.date >= today).length;
  const pastCoachSlots = sessions.filter(s => s.date < today).flatMap(s => s.coaches);
  const pastMarked = pastCoachSlots.filter(c => c.status === "present" || c.status === "absent");
  const turnedUp = pastCoachSlots.filter(c => c.status === "present").length;
  const rate = pastMarked.length > 0 ? Math.round((turnedUp / pastMarked.length) * 100) : null;

  const weeks: Record<string, OverviewSession[]> = {};
  for (const s of sessions) {
    const wk = weekStart(s.date);
    (weeks[wk] ??= []).push(s);
  }

  return (
    <div className="space-y-5" data-testid="coach-overview">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
        <StatCard label="Coaches" value={coaches.length} icon={UserCog} />
        <StatCard label="Sessions staffed" value={`${staffed}/${sessions.length}`} icon={CalendarDays} />
        <StatCard
          label="Upcoming with no coach"
          value={upcomingUnstaffed}
          tone={upcomingUnstaffed > 0 ? "amber" : "blue"}
          icon={AlertTriangle}
        />
        {/* A rate over zero marked sessions is not 0%, it's unknown — printing
            0% would read as "nobody has ever turned up". */}
        <StatCard
          label="Turned up"
          value={rate === null ? "—" : `${rate}%`}
          tone={rate === null ? "blue" : "emerald"}
          icon={UserCheck}
          hint={rate === null ? "No roll taken yet" : `${turnedUp} of ${pastMarked.length} marked`}
        />
      </div>

      <div className="flex gap-1 p-1 rounded-xl bg-white/[0.02] border border-white/[0.04] w-max">
        {([["sessions", "By session"], ["coaches", "By coach"]] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
            className={`px-3 min-h-[40px] rounded-lg text-[12px] font-medium transition-all cursor-pointer ${
              view === k ? "bg-blue-500/15 text-blue-400 border border-blue-500/25" : "text-white/35 hover:text-white/55 border border-transparent"
            }`}
            data-testid={`tab-coach-${k}`}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "sessions" ? (
        <div className="space-y-4">
          {Object.entries(weeks).map(([wk, weekSessions]) => {
            const gaps = weekSessions.filter(s => s.coaches.length === 0).length;
            return (
              <div key={wk} className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
                <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06] flex items-center justify-between gap-3">
                  <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">
                    Week of {shortDate(wk)}
                  </span>
                  {gaps > 0 && (
                    <span className="text-[11px] text-amber-400/70 font-medium" data-testid={`text-week-gaps-${wk}`}>
                      {gaps} unstaffed
                    </span>
                  )}
                </div>
                <div className="divide-y divide-blue-500/[0.04]">
                  {weekSessions.map(s => {
                    const past = s.date < today;
                    return (
                      <button
                        key={s.campDateId}
                        onClick={() => navigate(`${detailPath}/session/${s.campDateId}/SESSION`)}
                        className="w-full text-left px-3 sm:px-4 py-3 hover:bg-blue-500/[0.04] transition-colors cursor-pointer flex items-start gap-3"
                        data-testid={`row-coach-session-${s.campDateId}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[13px] font-medium ${past ? "text-white/45" : "text-white/80"}`}>
                              {weekdayOf(s.date)} {shortDate(s.date)}
                            </span>
                            {s.startTime && (
                              <span className="text-[12px] text-white/40 font-mono">
                                {s.startTime.slice(0, 5)}–{(s.endTime ?? "").slice(0, 5)}
                              </span>
                            )}
                            {s.name && <span className="text-[11px] text-amber-400/60 font-medium">{s.name}</span>}
                          </div>
                          <div className="flex flex-wrap gap-1.5 mt-1.5">
                            {s.coaches.length === 0 ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-amber-300/70 px-2 py-1 rounded-lg border border-amber-500/25 bg-amber-500/[0.07]"
                                    data-testid={`badge-unstaffed-${s.campDateId}`}>
                                <AlertTriangle className="w-3 h-3" /> No coach assigned
                              </span>
                            ) : (
                              s.coaches.map(c => <CoachChip key={c.id} c={c} />)
                            )}
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-white/20 flex-shrink-0 mt-1" />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : coaches.length === 0 ? (
        <p className="text-[13px] text-white/25 text-center py-8">
          No coaches assigned yet. Open a session and add one — you can put them on every week in one tap.
        </p>
      ) : (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="table-coach-tally">
              <thead>
                <tr className="border-b border-blue-500/[0.06] bg-blue-500/[0.03]">
                  <th className="text-left px-3 sm:px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">Coach</th>
                  <th className="text-center px-2 sm:px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">On</th>
                  <th className="text-center px-2 sm:px-4 py-3 text-[10px] text-emerald-300/30 uppercase tracking-wider font-semibold">Here</th>
                  <th className="text-center px-2 sm:px-4 py-3 text-[10px] text-amber-300/30 uppercase tracking-wider font-semibold">Missed</th>
                  <th className="text-center px-2 sm:px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold hidden sm:table-cell">Not marked</th>
                </tr>
              </thead>
              <tbody>
                {coaches.map(c => (
                  <tr key={c.contactId} className="border-b border-blue-500/[0.04]" data-testid={`row-tally-${c.contactId}`}>
                    <td className="px-3 sm:px-4 py-3">
                      <p className="text-[13px] font-medium text-white/80">{c.firstName} {c.lastName}</p>
                      {c.phone && (
                        <a href={`tel:${c.phone}`} className="inline-flex items-center gap-1 mt-0.5 text-[11px] text-blue-400/60 hover:text-blue-400 transition-colors">
                          <Phone className="w-3 h-3" /> {c.phone}
                        </a>
                      )}
                    </td>
                    <td className="px-2 sm:px-4 py-3 text-center text-[13px] font-semibold text-white/75">{c.assigned}</td>
                    <td className="px-2 sm:px-4 py-3 text-center text-[13px] font-semibold text-emerald-400/80">{c.present}</td>
                    <td className="px-2 sm:px-4 py-3 text-center text-[13px] font-semibold text-amber-400/70">{c.absent}</td>
                    {/* Its own column, never folded into "missed" — an untaken
                        roll is not a no-show. */}
                    <td className="px-2 sm:px-4 py-3 text-center text-[13px] text-white/30 hidden sm:table-cell">{c.unmarked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

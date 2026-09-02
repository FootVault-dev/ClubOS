// CUGC — Free Trial Sessions.
// Lives in the Gymnastics workspace → Free Sessions tab. Lists free-session
// bookings from cugc.co.nz. Staff mark attendance, convert to enrolled,
// reschedule, and keep per-booking staff notes. Internal-only — session + tab
// permission.
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { CalendarCheck, CalendarClock, Mail, Phone, Inbox, X, Percent, Sparkles } from "lucide-react";

interface Touch {
  ts?: string;
  landing?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
}

interface Attribution {
  first: Touch;
  last: Touch;
  visits: number;
}

type FreeSessionStatus = "booked" | "attended" | "no_show" | "cancelled" | "enrolled";

interface FreeSession {
  id: number;
  programSlug: string;
  programName: string;
  sessionLabel: string;
  sessionDate: string;
  childName: string;
  childDob: string | null;
  childAge: number | null;
  parentName: string;
  email: string;
  phone: string | null;
  notes: string | null;
  staffNotes: string | null;
  status: FreeSessionStatus;
  attendedAt: string | null;
  sourceUrl: string | null;
  attribution: Attribution | null;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  booked: "text-blue-300 bg-blue-400/10 border-blue-400/25",
  attended: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  no_show: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  enrolled: "text-purple-300 bg-purple-400/10 border-purple-400/25",
  cancelled: "text-white/40 bg-white/[0.04] border-white/10",
};
const STATUS_LABEL: Record<string, string> = {
  booked: "Booked",
  attended: "Attended",
  no_show: "No-show",
  enrolled: "Enrolled",
  cancelled: "Cancelled",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

// "2021-04-12" → "12 Apr 2021". Read straight off the string parts: a date of
// birth is a calendar date, not an instant, and pushing one through `new Date()`
// renders the day before for anyone west of UTC.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDobNz(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.slice(0, 10));
  if (!m) return ymd;
  const month = MONTHS_SHORT[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : ymd;
}

// "2026-07-22" → "Wed 22 Jul" (NZ style, no comma).
function fmtSessionDate(ymd: string): string {
  try {
    const d = new Date(`${ymd}T00:00:00`);
    if (isNaN(d.getTime())) return ymd;
    return d.toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" }).replace(/,/g, "");
  } catch {
    return ymd;
  }
}

// Local YYYY-MM-DD (not toISOString — NZ is ahead of UTC).
function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const META_SOURCES = ["facebook", "fb", "meta", "ig", "instagram"];

// Source badge: "Meta ad" when last-or-first touch has fbclid or a Meta
// utm_source; else the utm_source; else the referrer host; else "Direct".
function sourceInfo(row: FreeSession): { label: string; campaign: string | null; meta: boolean } {
  const touches = [row.attribution?.last, row.attribution?.first].filter(Boolean) as Touch[];
  const campaign = touches.find((t) => t.utm_campaign)?.utm_campaign || null;
  for (const t of touches) {
    if (t.fbclid || (t.utm_source && META_SOURCES.includes(t.utm_source.toLowerCase()))) {
      return { label: "Meta ad", campaign, meta: true };
    }
  }
  for (const t of touches) {
    if (t.utm_source) return { label: t.utm_source, campaign, meta: false };
  }
  for (const t of touches) {
    if (t.referrer) {
      try {
        return { label: new URL(t.referrer).hostname.replace(/^www\./, ""), campaign, meta: false };
      } catch {
        /* unparseable referrer — fall through */
      }
    }
  }
  return { label: "Direct", campaign, meta: false };
}

export default function CugcFreeSessions() {
  const { data: sessions = [], isLoading } = useQuery<FreeSession[]>({ queryKey: ["/api/admin/cugc/free-sessions"] });
  const [filter, setFilter] = useState<"all" | FreeSessionStatus>("all");
  const [timeFilter, setTimeFilter] = useState<"upcoming" | "past" | "all">("all");
  const [selected, setSelected] = useState<FreeSession | null>(null);

  const today = localYmd(new Date());
  const weekAhead = localYmd(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

  // Stat cards.
  const upcoming = sessions.filter((s) => s.status === "booked" && s.sessionDate >= today).length;
  const thisWeek = sessions.filter((s) => s.status === "booked" && s.sessionDate >= today && s.sessionDate <= weekAhead).length;
  const attended = sessions.filter((s) => s.status === "attended").length;
  const noShows = sessions.filter((s) => s.status === "no_show").length;
  const enrolled = sessions.filter((s) => s.status === "enrolled").length;
  const attendanceRate = attended + noShows > 0 ? `${Math.round((attended / (attended + noShows)) * 100)}%` : "—";
  // Enrolled rows attended before converting, so they count in the attended pool.
  const attendedPool = attended + enrolled;
  const convertedPct = attendedPool > 0 ? `${Math.round((enrolled / attendedPool) * 100)}% of attended` : "";

  const cards = [
    { label: "Upcoming", value: String(upcoming), sub: "", icon: CalendarClock, accent: "bg-blue-500/15 text-blue-300" },
    { label: "This week", value: String(thisWeek), sub: "", icon: CalendarCheck, accent: "bg-emerald-500/15 text-emerald-300" },
    { label: "Attendance rate", value: attendanceRate, sub: "", icon: Percent, accent: "bg-amber-500/15 text-amber-300" },
    { label: "Converted", value: String(enrolled), sub: convertedPct, icon: Sparkles, accent: "bg-purple-500/15 text-purple-300" },
  ];

  const counts: Record<"all" | FreeSessionStatus, number> = {
    all: sessions.length,
    booked: sessions.filter((s) => s.status === "booked").length,
    attended,
    no_show: noShows,
    enrolled,
    cancelled: sessions.filter((s) => s.status === "cancelled").length,
  };

  const shown = sessions
    .filter((s) => (filter === "all" ? true : s.status === filter))
    .filter((s) => {
      if (timeFilter === "upcoming") return s.sessionDate >= today;
      if (timeFilter === "past") return s.sessionDate < today;
      return true;
    });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white/90 flex items-center gap-2.5">
            <CalendarCheck className="w-6 h-6 text-blue-400" />
            CUGC — Free Sessions
          </h1>
          <p className="text-sm text-white/40 mt-1">Free trial session bookings from cugc.co.nz. Mark attendance and convert to enrolments.</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {([
            ["upcoming", "Upcoming"],
            ["past", "Past"],
            ["all", "All dates"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTimeFilter(key)}
              className={`px-3 py-1.5 rounded-lg border transition-colors ${
                timeFilter === key ? "bg-blue-500/15 border-blue-400/40 text-blue-200" : "bg-white/[0.04] border-white/10 text-white/60 hover:text-white/90"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{c.label}</div>
              <div className="text-3xl font-bold text-white whitespace-nowrap">
                {c.value}
                {c.sub && <span className="ml-2 text-sm font-medium text-white/40">{c.sub}</span>}
              </div>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${c.accent}`}>
              <c.icon className="w-5 h-5" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs flex-wrap">
        {([
          ["all", "All"],
          ["booked", "Booked"],
          ["attended", "Attended"],
          ["no_show", "No-show"],
          ["enrolled", "Enrolled"],
          ["cancelled", "Cancelled"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-lg border transition-colors ${
              filter === key ? "bg-blue-500/15 border-blue-400/40 text-blue-200" : "bg-white/[0.04] border-white/10 text-white/60 hover:text-white/90"
            }`}
          >
            {label} · {counts[key]}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-16 text-center">Loading free sessions…</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Inbox className="w-10 h-10 text-white/20 mb-3" />
          <p className="text-white/60 font-medium">No free sessions {filter === "all" && timeFilter === "all" ? "yet" : "in this view"}</p>
          <p className="text-white/35 text-sm mt-1">New free-session bookings from cugc.co.nz will appear here.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-white/35 border-b border-white/[0.06]">
                <th className="px-4 py-3 font-semibold">Child</th>
                <th className="px-4 py-3 font-semibold">Program</th>
                <th className="px-4 py-3 font-semibold">Session</th>
                <th className="px-4 py-3 font-semibold">Parent</th>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Booked</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const src = sourceInfo(s);
                return (
                  <tr
                    key={s.id}
                    onClick={() => setSelected(s)}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors cursor-pointer"
                    data-testid={`row-free-session-${s.id}`}
                  >
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className="text-white/90 font-medium">{s.childName}</span>
                      {s.childAge != null && (
                        <span className="ml-2 px-1.5 py-0.5 rounded-md border border-white/10 bg-white/[0.04] text-white/50 text-[11px]">{s.childAge}y</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-white/70">{s.programName}</td>
                    <td className="px-4 py-3 text-white/60 whitespace-nowrap">
                      <div className="flex flex-col">
                        <span className="text-white/80">{fmtSessionDate(s.sessionDate)}</span>
                        <span className="text-white/40 text-xs">{s.sessionLabel}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-white/80">{s.parentName}</span>
                        <a href={`mailto:${s.email}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-white/50 hover:text-blue-300 transition-colors text-xs">
                          <Mail className="w-3 h-3 text-white/30" /> {s.email}
                        </a>
                        {s.phone && (
                          <a href={`tel:${s.phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-white/50 hover:text-blue-300 transition-colors text-xs">
                            <Phone className="w-3 h-3 text-white/30" /> {s.phone}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        title={src.campaign || undefined}
                        className={`px-2.5 py-1 rounded-md border text-xs font-medium ${
                          src.meta ? "text-sky-300 bg-sky-400/10 border-sky-400/25" : "text-white/60 bg-white/[0.04] border-white/10"
                        }`}
                      >
                        {src.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-md border text-xs font-medium ${STATUS_STYLE[s.status] || STATUS_STYLE.cancelled}`}>
                        {STATUS_LABEL[s.status] || s.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-white/45 whitespace-nowrap">{fmtDate(s.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailModal row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DetailModal({ row, onClose }: { row: FreeSession; onClose: () => void }) {
  const [staffNotes, setStaffNotes] = useState(row.staffNotes || "");
  const [showReschedule, setShowReschedule] = useState(false);
  const [newDate, setNewDate] = useState(row.sessionDate);
  const [newLabel, setNewLabel] = useState(row.sessionLabel);

  const patch = useMutation({
    mutationFn: (data: Partial<Pick<FreeSession, "status" | "sessionDate" | "sessionLabel" | "staffNotes">>) =>
      apiRequest("PATCH", `/api/admin/cugc/free-sessions/${row.id}`, data).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/cugc/free-sessions"] });
      onClose();
    },
  });

  const src = sourceInfo(row);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-white/35">{label}</p>
      <p className="text-sm text-white/85 mt-0.5">{value || <span className="text-white/25">—</span>}</p>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#0d1117] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white/90">{row.childName}</h2>
            <p className="text-xs text-white/40 mt-0.5">{row.programName} · {row.sessionLabel}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/90"><X className="w-5 h-5" /></button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            {field("Status", <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${STATUS_STYLE[row.status] || STATUS_STYLE.cancelled}`}>{STATUS_LABEL[row.status] || row.status}</span>)}
            {field("Session", `${fmtSessionDate(row.sessionDate)} · ${row.sessionLabel}`)}
            {field("Date of birth", row.childDob ? fmtDobNz(row.childDob) : null)}
            {field("Child age", row.childAge != null ? `${row.childAge} years` : null)}
            {field("Booked", fmtDate(row.createdAt))}
            {field("Attended at", row.attendedAt ? fmtDate(row.attendedAt) : null)}
            {field("Source", <span title={src.campaign || undefined}>{src.label}{src.campaign ? ` · ${src.campaign}` : ""}{row.attribution ? ` · ${row.attribution.visits} visit${row.attribution.visits === 1 ? "" : "s"}` : ""}</span>)}
          </div>

          <div className="border-t border-white/[0.06] pt-4 grid grid-cols-2 gap-4">
            {field("Parent / caregiver", row.parentName)}
            {field("Phone", row.phone ? <a href={`tel:${row.phone}`} className="hover:text-blue-300 flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-white/30" />{row.phone}</a> : null)}
            {field("Email", <a href={`mailto:${row.email}`} className="hover:text-blue-300 flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-white/30" />{row.email}</a>)}
            {field("Booked from", row.sourceUrl)}
          </div>

          <div className="border-t border-white/[0.06] pt-4 space-y-4">
            {field("Parent notes", row.notes)}
            <div>
              <p className="text-[11px] uppercase tracking-wider text-white/35">Staff notes</p>
              <textarea
                value={staffNotes}
                onChange={(e) => setStaffNotes(e.target.value)}
                rows={3}
                placeholder="Internal notes — attendance, follow-ups, conversion…"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:outline-none focus:border-blue-400/40"
              />
              {staffNotes !== (row.staffNotes || "") && (
                <button
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ staffNotes })}
                  className="mt-2 px-3 py-1.5 rounded-lg text-sm border border-blue-400/30 text-blue-300 hover:bg-blue-400/10 disabled:opacity-50"
                >
                  Save notes
                </button>
              )}
            </div>
          </div>

          {showReschedule && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <p className="text-[11px] uppercase tracking-wider text-white/35">Reschedule</p>
              <div className="flex items-center gap-2 flex-wrap">
                <DatePickerInput
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-blue-400/40 [color-scheme:dark]"
                />
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. Wednesday 4:00–4:45pm"
                  className="flex-1 min-w-[200px] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:outline-none focus:border-blue-400/40"
                />
                <button
                  disabled={patch.isPending || !newDate || !newLabel.trim()}
                  onClick={() => patch.mutate({ sessionDate: newDate, sessionLabel: newLabel.trim(), status: "booked" })}
                  className="px-3 py-1.5 rounded-lg text-sm border border-blue-400/30 text-blue-300 hover:bg-blue-400/10 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4 flex-wrap">
          <button
            onClick={() => setShowReschedule((v) => !v)}
            className="px-3 py-1.5 rounded-lg text-sm border border-white/15 text-white/60 hover:bg-white/[0.06] mr-auto"
          >
            {showReschedule ? "Hide reschedule" : "Reschedule"}
          </button>
          {row.status !== "attended" && (
            <button disabled={patch.isPending} onClick={() => patch.mutate({ status: "attended" })} className="px-3 py-1.5 rounded-lg text-sm border border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50">Mark attended</button>
          )}
          {row.status !== "no_show" && (
            <button disabled={patch.isPending} onClick={() => patch.mutate({ status: "no_show" })} className="px-3 py-1.5 rounded-lg text-sm border border-amber-400/30 text-amber-300 hover:bg-amber-400/10 disabled:opacity-50">No-show</button>
          )}
          {row.status !== "enrolled" && (
            <button disabled={patch.isPending} onClick={() => patch.mutate({ status: "enrolled" })} className="px-3 py-1.5 rounded-lg text-sm border border-purple-400/30 text-purple-300 hover:bg-purple-400/10 disabled:opacity-50">Mark enrolled</button>
          )}
          {row.status !== "cancelled" && (
            <button disabled={patch.isPending} onClick={() => patch.mutate({ status: "cancelled" })} className="px-3 py-1.5 rounded-lg text-sm border border-white/15 text-white/60 hover:bg-white/[0.06] disabled:opacity-50">Cancel</button>
          )}
        </div>
      </div>
    </div>
  );
}

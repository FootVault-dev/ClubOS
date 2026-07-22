// CUFC — Open Trainings.
// Lives in the Christchurch United workspace → Open Trainings tab. Lists free
// open-training requests from cufc.co.nz (the invite-only funnel for U9–U20,
// and the free-taster option for U4–U8). Staff review each request, approve it
// (which emails the family their session confirmation) or decline it, and keep
// per-request staff notes. Internal-only — session + tab permission.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { CalendarCheck, Mail, Phone, Inbox, X, Clock, CheckCircle2, XCircle } from "lucide-react";

type OpenTrainingStatus = "pending" | "approved" | "declined";
type AgeGroup = "u4-u8" | "u9-u12" | "u13-plus";

interface OpenTraining {
  id: number;
  ageGroup: AgeGroup;
  childFirstName: string;
  childLastName: string;
  childDob: string;
  ageGrade: number | null;
  guardianName: string;
  email: string;
  phone: string;
  currentClub: string | null;
  notes: string | null;
  status: OpenTrainingStatus;
  sessionDetails: string | null;
  staffNotes: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  source: string | null;
  sourceUrl: string | null;
  createdAt: string;
}

const GROUP_LABEL: Record<AgeGroup, string> = {
  "u4-u8": "U4–U8",
  "u9-u12": "U9–U12",
  "u13-plus": "U13+",
};
const GROUP_SUB: Record<AgeGroup, string> = {
  "u4-u8": "FUNiño",
  "u9-u12": "Juniors / Pre-Academy",
  "u13-plus": "Academy",
};

const STATUS_STYLE: Record<string, string> = {
  pending: "text-blue-300 bg-blue-400/10 border-blue-400/25",
  approved: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  declined: "text-white/40 bg-white/[0.04] border-white/10",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "Pending review",
  approved: "Approved",
  declined: "Declined",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function CufcOpenTrainings() {
  const { data: requests = [], isLoading } = useQuery<OpenTraining[]>({ queryKey: ["/api/admin/cufc/open-trainings"] });
  const [groupFilter, setGroupFilter] = useState<"all" | AgeGroup>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | OpenTrainingStatus>("all");
  const [selected, setSelected] = useState<OpenTraining | null>(null);

  const pending = requests.filter((r) => r.status === "pending").length;
  const approved = requests.filter((r) => r.status === "approved").length;
  const byGroup = (g: AgeGroup) => requests.filter((r) => r.ageGroup === g).length;

  const cards = [
    { label: "Pending review", value: String(pending), icon: Clock, accent: "bg-blue-500/15 text-blue-300" },
    { label: "Approved", value: String(approved), icon: CheckCircle2, accent: "bg-emerald-500/15 text-emerald-300" },
    { label: "U9–U12 requests", value: String(byGroup("u9-u12")), icon: CalendarCheck, accent: "bg-amber-500/15 text-amber-300" },
    { label: "U13+ requests", value: String(byGroup("u13-plus")), icon: CalendarCheck, accent: "bg-purple-500/15 text-purple-300" },
  ];

  const groupCounts: Record<"all" | AgeGroup, number> = {
    all: requests.length,
    "u4-u8": byGroup("u4-u8"),
    "u9-u12": byGroup("u9-u12"),
    "u13-plus": byGroup("u13-plus"),
  };
  const statusCounts: Record<"all" | OpenTrainingStatus, number> = {
    all: requests.length,
    pending,
    approved,
    declined: requests.filter((r) => r.status === "declined").length,
  };

  const shown = requests
    .filter((r) => (groupFilter === "all" ? true : r.ageGroup === groupFilter))
    .filter((r) => (statusFilter === "all" ? true : r.status === statusFilter));

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white/90 flex items-center gap-2.5">
            <CalendarCheck className="w-6 h-6 text-blue-400" />
            Open Trainings
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Free open-training requests from cufc.co.nz. Approve a request to email the family their session confirmation.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{c.label}</div>
              <div className="text-3xl font-bold text-white whitespace-nowrap">{c.value}</div>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${c.accent}`}>
              <c.icon className="w-5 h-5" />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 text-xs flex-wrap">
        {([
          ["all", "All ages"],
          ["u4-u8", "U4–U8"],
          ["u9-u12", "U9–U12"],
          ["u13-plus", "U13+"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setGroupFilter(key)}
            className={`px-3 py-1.5 rounded-lg border transition-colors ${
              groupFilter === key ? "bg-blue-500/15 border-blue-400/40 text-blue-200" : "bg-white/[0.04] border-white/10 text-white/60 hover:text-white/90"
            }`}
          >
            {label} · {groupCounts[key]}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/10" />
        {([
          ["all", "All"],
          ["pending", "Pending"],
          ["approved", "Approved"],
          ["declined", "Declined"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`px-3 py-1.5 rounded-lg border transition-colors ${
              statusFilter === key ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-200" : "bg-white/[0.04] border-white/10 text-white/60 hover:text-white/90"
            }`}
          >
            {label} · {statusCounts[key]}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-16 text-center">Loading open training requests…</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Inbox className="w-10 h-10 text-white/20 mb-3" />
          <p className="text-white/60 font-medium">No requests {groupFilter === "all" && statusFilter === "all" ? "yet" : "in this view"}</p>
          <p className="text-white/35 text-sm mt-1">New open-training requests from cufc.co.nz will appear here.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-white/35 border-b border-white/[0.06]">
                <th className="px-4 py-3 font-semibold">Player</th>
                <th className="px-4 py-3 font-semibold">Age group</th>
                <th className="px-4 py-3 font-semibold">Parent</th>
                <th className="px-4 py-3 font-semibold">Current club</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Requested</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors cursor-pointer"
                  data-testid={`row-open-training-${r.id}`}
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <span className="text-white/90 font-medium">{r.childFirstName} {r.childLastName}</span>
                    {r.ageGrade != null && (
                      <span className="ml-2 px-1.5 py-0.5 rounded-md border border-white/10 bg-white/[0.04] text-white/50 text-[11px]">U{r.ageGrade}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/70 whitespace-nowrap">
                    <div className="flex flex-col">
                      <span className="text-white/80">{GROUP_LABEL[r.ageGroup] || r.ageGroup}</span>
                      <span className="text-white/40 text-xs">{GROUP_SUB[r.ageGroup] || ""}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-white/80">{r.guardianName}</span>
                      <a href={`mailto:${r.email}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-white/50 hover:text-blue-300 transition-colors text-xs">
                        <Mail className="w-3 h-3 text-white/30" /> {r.email}
                      </a>
                      <a href={`tel:${r.phone}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5 text-white/50 hover:text-blue-300 transition-colors text-xs">
                        <Phone className="w-3 h-3 text-white/30" /> {r.phone}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white/60">{r.currentClub || <span className="text-white/25">—</span>}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-1 rounded-md border text-xs font-medium ${STATUS_STYLE[r.status] || STATUS_STYLE.declined}`}>
                      {STATUS_LABEL[r.status] || r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-white/45 whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailModal row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function DetailModal({ row, onClose }: { row: OpenTraining; onClose: () => void }) {
  const [staffNotes, setStaffNotes] = useState(row.staffNotes || "");
  const [sessionDetails, setSessionDetails] = useState(row.sessionDetails || "");
  const [showApprove, setShowApprove] = useState(false);

  const patch = useMutation({
    mutationFn: (data: Partial<Pick<OpenTraining, "status" | "staffNotes" | "sessionDetails">>) =>
      apiRequest("PATCH", `/api/admin/cufc/open-trainings/${row.id}`, data).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/cufc/open-trainings"] });
      onClose();
    },
  });

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
            <h2 className="text-lg font-semibold text-white/90">{row.childFirstName} {row.childLastName}</h2>
            <p className="text-xs text-white/40 mt-0.5">
              {GROUP_LABEL[row.ageGroup] || row.ageGroup} · {GROUP_SUB[row.ageGroup] || ""}{row.ageGrade != null ? ` · U${row.ageGrade}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/90"><X className="w-5 h-5" /></button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            {field("Status", <span className={`px-2 py-0.5 rounded-md border text-xs font-medium ${STATUS_STYLE[row.status] || STATUS_STYLE.declined}`}>{STATUS_LABEL[row.status] || row.status}</span>)}
            {field("Date of birth", row.childDob)}
            {field("Requested", fmtDate(row.createdAt))}
            {field("Decided", row.decidedAt ? `${fmtDate(row.decidedAt)}${row.decidedBy ? ` · ${row.decidedBy}` : ""}` : null)}
          </div>

          <div className="border-t border-white/[0.06] pt-4 grid grid-cols-2 gap-4">
            {field("Parent / guardian", row.guardianName)}
            {field("Phone", <a href={`tel:${row.phone}`} className="hover:text-blue-300 flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-white/30" />{row.phone}</a>)}
            {field("Email", <a href={`mailto:${row.email}`} className="hover:text-blue-300 flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-white/30" />{row.email}</a>)}
            {field("Current club", row.currentClub)}
          </div>

          <div className="border-t border-white/[0.06] pt-4 space-y-4">
            {field("Parent notes", row.notes)}
            {row.status === "approved" && field("Session details sent", row.sessionDetails)}
            <div>
              <p className="text-[11px] uppercase tracking-wider text-white/35">Staff notes</p>
              <textarea
                value={staffNotes}
                onChange={(e) => setStaffNotes(e.target.value)}
                rows={3}
                placeholder="Internal notes — review outcome, coach feedback, follow-ups…"
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

          {showApprove && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <p className="text-[11px] uppercase tracking-wider text-white/35">Approve — session details for the confirmation email</p>
              <textarea
                value={sessionDetails}
                onChange={(e) => setSessionDetails(e.target.value)}
                rows={3}
                placeholder={"e.g. Wednesday 30 July, 4:30–5:30pm\nUnited Sports Centre, 155 Aidanfield Drive\nBring boots and a drink bottle"}
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:outline-none focus:border-emerald-400/40"
              />
              <p className="text-xs text-white/35">
                Sent verbatim in the approval email. Leave blank to send a confirmation that says staff will follow up with details.
              </p>
              <button
                disabled={patch.isPending}
                onClick={() => patch.mutate({ status: "approved", sessionDetails: sessionDetails.trim() || null } as any)}
                className="px-3 py-1.5 rounded-lg text-sm border border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10 disabled:opacity-50 flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-4 h-4" /> Approve &amp; send confirmation
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4 flex-wrap">
          {row.status !== "approved" && (
            <button
              onClick={() => setShowApprove((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-sm border border-emerald-400/30 text-emerald-300 hover:bg-emerald-400/10"
            >
              {showApprove ? "Hide approve" : "Approve…"}
            </button>
          )}
          {row.status !== "declined" && (
            <button
              disabled={patch.isPending}
              onClick={() => patch.mutate({ status: "declined" })}
              className="px-3 py-1.5 rounded-lg text-sm border border-white/15 text-white/60 hover:bg-white/[0.06] disabled:opacity-50 flex items-center gap-1.5"
            >
              <XCircle className="w-4 h-4" /> Decline
            </button>
          )}
          {row.status !== "pending" && (
            <button
              disabled={patch.isPending}
              onClick={() => patch.mutate({ status: "pending" })}
              className="px-3 py-1.5 rounded-lg text-sm border border-blue-400/30 text-blue-300 hover:bg-blue-400/10 disabled:opacity-50"
            >
              Back to pending
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

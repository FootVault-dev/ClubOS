// Christchurch Ethnic Cup — Registrations of Interest.
// Lives in the CIC workspace under the "Ethnic" view (the Youth / 7's / Ethnic
// switcher in the sidebar). Lists submissions from the ethniccup.com form.
// Internal-only — session + tab permission.
//
// Entries and payment are not here. The Cup takes no money until the venue is
// confirmed (Daniel, 2026-08-20), so this board is the whole pipeline for now:
// a community says they want in, and someone works down the list.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Mail, Phone, Users, Inbox, StickyNote } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface Registration {
  id: number;
  firstName: string;
  lastName: string | null;
  email: string;
  phone: string | null;
  community: string | null;
  grade: string | null;
  message: string | null;
  sourceUrl: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
}
interface Payload {
  rows: Registration[];
  counts: Record<string, number>;
  statuses: string[];
}

const STATUS_STYLE: Record<string, string> = {
  new: "text-sky-300 bg-sky-400/10 border-sky-400/25",
  contacted: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  entered: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
  declined: "text-white/40 bg-white/5 border-white/10",
  archived: "text-white/40 bg-white/5 border-white/10",
};

const GRADE_STYLE: Record<string, string> = {
  "Men's": "text-sky-300 bg-sky-400/10 border-sky-400/25",
  "Women's": "text-fuchsia-300 bg-fuchsia-400/10 border-fuchsia-400/25",
  Both: "text-violet-300 bg-violet-400/10 border-violet-400/25",
  Unsure: "text-white/45 bg-white/5 border-white/10",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function EthnicCupRegistrations() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("all");
  const { data, isLoading } = useQuery<Payload>({ queryKey: ["/api/admin/ethnic-cup/registrations"] });

  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiRequest("PATCH", `/api/admin/ethnic-cup/registrations/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/admin/ethnic-cup/registrations"] }),
  });

  const rows = data?.rows ?? [];
  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);
  const statuses = data?.statuses ?? [];

  return (
    <div className="p-6 space-y-6" data-testid="page-ethnic-cup-registrations">
      <div>
        <h1 className="text-2xl font-semibold text-white flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6 text-amber-300" />
          Ethnic Cup — Registrations of Interest
        </h1>
        <p className="mt-1 text-sm text-white/50">
          From ethniccup.com. 14–15 November 2026 · $800 per team. Registering is free and is not an
          entry — entries and payment open once the venue is confirmed.
        </p>
      </div>

      {/* counts are derived server-side from the rows, never stored */}
      <div className="flex flex-wrap gap-2">
        {["all", ...statuses].map((s) => {
          const n = s === "all" ? (data?.counts?.total ?? 0) : (data?.counts?.[s] ?? 0);
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              data-testid={`filter-${s}`}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition ${
                filter === s
                  ? "border-amber-400/40 bg-amber-400/15 text-amber-200"
                  : "border-white/10 bg-white/[0.03] text-white/50 hover:text-white/70"
              }`}
            >
              {s} <span className="ml-1 opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p className="text-sm text-white/40">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-10 text-center">
          <Inbox className="mx-auto h-8 w-8 text-white/25" />
          <p className="mt-3 text-sm text-white/50">
            {rows.length === 0
              ? "No registrations yet. They arrive here the moment someone submits the form on ethniccup.com."
              : "Nothing with that status."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <div key={r.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-4" data-testid={`row-${r.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex items-center gap-1.5 font-semibold text-white">
                      <Users className="h-4 w-4 text-amber-300" />
                      {r.community || "—"}
                    </span>
                    {r.grade && (
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${GRADE_STYLE[r.grade] ?? GRADE_STYLE.Unsure}`}>
                        {r.grade}
                      </span>
                    )}
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase ${STATUS_STYLE[r.status] ?? STATUS_STYLE.new}`}>
                      {r.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-white/70">
                    {r.firstName} {r.lastName ?? ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
                    <a href={`mailto:${r.email}`} className="flex items-center gap-1.5 hover:text-white/80">
                      <Mail className="h-3.5 w-3.5" /> {r.email}
                    </a>
                    {r.phone && (
                      <a href={`tel:${r.phone}`} className="flex items-center gap-1.5 hover:text-white/80">
                        <Phone className="h-3.5 w-3.5" /> {r.phone}
                      </a>
                    )}
                    <span>{fmtDate(r.createdAt)}</span>
                  </div>
                  {r.message && <p className="mt-3 max-w-2xl text-sm text-white/60">{r.message}</p>}
                </div>

                <select
                  value={r.status}
                  disabled={patch.isPending}
                  onChange={(e) => patch.mutate({ id: r.id, body: { status: e.target.value } })}
                  data-testid={`status-${r.id}`}
                  className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-white/40 hover:text-white/60 flex items-center gap-1.5">
                  <StickyNote className="h-3.5 w-3.5" /> Staff notes{r.notes ? "" : " — none yet"}
                </summary>
                <textarea
                  defaultValue={r.notes ?? ""}
                  placeholder="Internal only — never shown to the registrant."
                  onBlur={(e) => {
                    if (e.target.value !== (r.notes ?? "")) patch.mutate({ id: r.id, body: { notes: e.target.value } });
                  }}
                  className="mt-2 w-full rounded-lg border border-white/10 bg-white/[0.04] p-2.5 text-sm text-white/80"
                  rows={3}
                />
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

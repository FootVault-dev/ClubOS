// CIC 7's — Registrations of Interest.
// Lives in the Tournament workspace under the "CIC 7's" view (toggled via the
// Youth/7's switcher in the sidebar). Lists submissions from the cic7s.com
// "Register Your Interest" form. Internal-only — session + tab permission.
import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Mail, Phone, MapPin, Inbox } from "lucide-react";

interface Registration {
  id: number;
  firstName: string;
  lastName: string | null;
  email: string;
  location: string | null;
  phone: string | null;
  category: string | null;
  sourceUrl: string | null;
  status: string;
  /** Set when the sales page on cic7s.com turned this interest into a Team Pay entry. */
  teampayEntryId: number | null;
  createdAt: string;
}

const CATEGORY_STYLE: Record<string, string> = {
  Mens: "text-sky-300 bg-sky-400/10 border-sky-400/25",
  Masters: "text-amber-300 bg-amber-400/10 border-amber-400/25",
  Social: "text-emerald-300 bg-emerald-400/10 border-emerald-400/25",
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function Cic7sRegistrations() {
  const { data: regos = [], isLoading } = useQuery<Registration[]>({ queryKey: ["/api/admin/cic7s/registrations"] });

  const counts = regos.reduce(
    (acc, r) => {
      if (r.category && acc[r.category] !== undefined) acc[r.category] += 1;
      return acc;
    },
    { Mens: 0, Masters: 0, Social: 0 } as Record<string, number>,
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-white/90 flex items-center gap-2.5">
            <ClipboardCheck className="w-6 h-6 text-blue-400" />
            CIC 7's — Registrations of Interest
          </h1>
          <p className="text-sm text-white/40 mt-1">Submissions from the cic7s.com “Register Your Interest” form.</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/10 text-white/70">
            {regos.length} total
          </span>
          <span className="px-3 py-1.5 rounded-lg border text-lime-300 bg-lime-400/10 border-lime-400/25">
            {regos.filter((r) => r.teampayEntryId).length} entered a team
          </span>
          {(["Mens", "Masters", "Social"] as const).map((c) => (
            <span key={c} className={`px-3 py-1.5 rounded-lg border ${CATEGORY_STYLE[c]}`}>
              {counts[c]} {c}
            </span>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-16 text-center">Loading registrations…</div>
      ) : regos.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Inbox className="w-10 h-10 text-white/20 mb-3" />
          <p className="text-white/60 font-medium">No registrations yet</p>
          <p className="text-white/35 text-sm mt-1">New interest submissions from cic7s.com will appear here.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/[0.06]">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-white/35 border-b border-white/[0.06]">
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Contact</th>
                <th className="px-4 py-3 font-semibold">Location</th>
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold">Team entry</th>
                <th className="px-4 py-3 font-semibold">Received</th>
              </tr>
            </thead>
            <tbody>
              {regos.map((r) => (
                <tr key={r.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors" data-testid={`row-rego-${r.id}`}>
                  <td className="px-4 py-3 text-white/90 font-medium whitespace-nowrap">
                    {r.firstName}{r.lastName ? ` ${r.lastName}` : ""}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <a href={`mailto:${r.email}`} className="flex items-center gap-1.5 text-white/70 hover:text-blue-300 transition-colors">
                        <Mail className="w-3.5 h-3.5 text-white/30" /> {r.email}
                      </a>
                      {r.phone && (
                        <a href={`tel:${r.phone}`} className="flex items-center gap-1.5 text-white/50 hover:text-blue-300 transition-colors">
                          <Phone className="w-3.5 h-3.5 text-white/30" /> {r.phone}
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-white/60">
                    {r.location ? (
                      <span className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-white/30" /> {r.location}</span>
                    ) : (
                      <span className="text-white/25">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.category ? (
                      <span className={`px-2.5 py-1 rounded-md border text-xs font-medium ${CATEGORY_STYLE[r.category] || "text-white/60 bg-white/5 border-white/10"}`}>
                        {r.category}
                      </span>
                    ) : (
                      <span className="text-white/25">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {r.teampayEntryId ? (
                      <a href="/admin/team-entries" className="px-2.5 py-1 rounded-md border text-xs font-medium text-lime-300 bg-lime-400/10 border-lime-400/25 hover:bg-lime-400/20 transition-colors">
                        Entry #{r.teampayEntryId}
                      </a>
                    ) : (
                      <span className="text-white/25">interest only</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/45 whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

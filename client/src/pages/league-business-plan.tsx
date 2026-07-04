import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ShieldCheck, Eye, Users, Clock } from "lucide-react";

const PLAN_URL = "https://business.minifootball.co.nz";

interface Viewer {
  name: string | null;
  email: string;
  opens: number;
  firstSeen: string;
  lastSeen: string;
}
interface AccessEvent {
  name: string | null;
  email: string | null;
  event: string;
  ip: string | null;
  created_at: string;
}
interface AccessLog {
  slug: string;
  title: string;
  tier: string;
  viewers: Viewer[];
  events: AccessEvent[];
  generatedAt: string;
}

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-NZ", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Pacific/Auckland",
    });
  } catch {
    return iso;
  }
}

const EVENT_STYLE: Record<string, string> = {
  view: "bg-blue-500/15 text-blue-300",
  granted: "bg-green-500/15 text-green-400",
  code_sent: "bg-white/5 text-white/40",
  denied: "bg-red-500/15 text-red-400",
};
const EVENT_LABEL: Record<string, string> = {
  view: "Opened",
  granted: "Verified",
  code_sent: "Code sent",
  denied: "Wrong code",
};

export default function LeagueBusinessPlan() {
  const { data, isLoading, isError } = useQuery<AccessLog>({
    queryKey: ["/api/admin/league/business-plan/access-log"],
    refetchInterval: 30000,
  });

  const viewers = data?.viewers ?? [];
  const events = data?.events ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" data-testid="text-business-plan-title">
          Business Plan
        </h1>
        <p className="text-sm text-white/40 mt-1">
          The Mini Football Leagues 2026–2029 business plan — and who has opened it.
        </p>
      </div>

      {/* Link + access control */}
      <div className="rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-white/50">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-300" />
              Invited only · email-verified · every open logged
            </div>
            <p className="mt-2 text-sm text-white/80">
              Share <span className="font-mono text-white">business.minifootball.co.nz</span> with the
              leadership team. Each person verifies their own email to get in.
            </p>
          </div>
          <a
            href={PLAN_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-open-business-plan"
            className="inline-flex items-center gap-2 rounded-xl bg-blue-500/90 hover:bg-blue-500 px-4 py-2.5 text-sm font-semibold text-white transition-colors"
          >
            Open the plan <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="rounded-2xl border border-blue-500/15 bg-white/[0.02] p-5" data-testid="stat-viewers">
          <Users className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{viewers.length}</p>
          <p className="text-xs text-white/40 mt-1">People who've opened it</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-white/[0.02] p-5" data-testid="stat-opens">
          <Eye className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-2xl font-bold text-white">{viewers.reduce((n, v) => n + v.opens, 0)}</p>
          <p className="text-xs text-white/40 mt-1">Total opens</p>
        </div>
        <div className="rounded-2xl border border-blue-500/15 bg-white/[0.02] p-5" data-testid="stat-last">
          <Clock className="w-5 h-5 text-white/50 mb-3" />
          <p className="text-sm font-semibold text-white">
            {viewers[0] ? when(viewers[0].lastSeen) : "—"}
          </p>
          <p className="text-xs text-white/40 mt-1">Last opened</p>
        </div>
      </div>

      {/* Who has opened it */}
      <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-white/40" />
          <h3 className="text-sm font-semibold text-white">Who has opened it</h3>
        </div>
        {isLoading ? (
          <p className="text-sm text-white/30 py-6 text-center">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-red-400/70 py-6 text-center">
            Couldn't load the access log. Check the connection to the documents service.
          </p>
        ) : viewers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-white/20">
            <Eye className="w-10 h-10 mb-2" />
            <p className="text-sm">No one has opened it yet</p>
            <p className="text-xs mt-1">Opens will appear here the moment someone verifies</p>
          </div>
        ) : (
          <div className="space-y-2">
            {viewers.map((v) => (
              <div
                key={v.email}
                className="flex items-center justify-between py-3 border-b border-white/5 last:border-0"
                data-testid={`viewer-${v.email}`}
              >
                <div>
                  <p className="text-sm font-medium text-white/80">{v.name || v.email}</p>
                  <p className="text-xs text-white/30">{v.email}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-white/70">
                    {v.opens} open{v.opens === 1 ? "" : "s"}
                  </p>
                  <p className="text-xs text-white/30">last {when(v.lastSeen)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Full activity feed */}
      {events.length > 0 && (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex items-center gap-2 mb-4">
            <Clock className="w-4 h-4 text-white/40" />
            <h3 className="text-sm font-semibold text-white">Activity</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="text-white/30 text-xs uppercase tracking-wide">
                  <th className="text-left font-medium pb-2">When</th>
                  <th className="text-left font-medium pb-2">Who</th>
                  <th className="text-left font-medium pb-2">Event</th>
                  <th className="text-left font-medium pb-2">IP</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 100).map((e, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="py-2.5 text-white/50 whitespace-nowrap">{when(e.created_at)}</td>
                    <td className="py-2.5 text-white/70">{e.name || e.email || "—"}</td>
                    <td className="py-2.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          EVENT_STYLE[e.event] || "bg-white/5 text-white/40"
                        }`}
                      >
                        {EVENT_LABEL[e.event] || e.event}
                      </span>
                    </td>
                    <td className="py-2.5 text-white/30 font-mono text-xs">{e.ip || "—"}</td>
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

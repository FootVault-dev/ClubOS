// VIEW AS — the banner, and the picker behind it.
//
// Born 2026-08-13 after two staff reported working features as broken and
// neither could be reproduced by a super admin, because super_admin
// short-circuits the permission checks everyone else runs. See
// server/view-as-routes.ts for the rules; this is the visible half.
//
// 🔴 The banner is deliberately loud and always on screen. The failure mode of
// every impersonation feature is forgetting you are in one — and here that
// means reading a staff member's blank tab as your own broken software, which
// is the exact confusion this was built to end.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { Eye, X, Search, Loader2 } from "lucide-react";

type Ws = { slug: string; name: string; role: string; tabs: string[] | null };
type StaffUser = {
  id: number; email: string; firstName: string; lastName: string;
  role: string; workspaces: Ws[];
};

/** What a workspace membership actually grants, in words. */
function accessLabel(w: Ws): string {
  if (w.role === "admin" || w.role === "manager") return "every tab";
  if (w.tabs === null) return "every tab";
  if (w.tabs.length === 0) return "no tabs";
  return `${w.tabs.length} tab${w.tabs.length === 1 ? "" : "s"}`;
}

export function ViewAsBar() {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");

  const { data: me } = useQuery<any>({ queryKey: ["/api/auth/me"] });
  const viewingAs = me?.viewingAs;
  const isSuperAdmin = me?.role === "super_admin";

  const { data: staff, isLoading } = useQuery<{ users: StaffUser[] }>({
    queryKey: ["/api/admin/view-as/users"],
    queryFn: async () => {
      const r = await workspaceFetch("/api/admin/view-as/users");
      if (!r.ok) throw new Error("Failed to load staff");
      return r.json();
    },
    enabled: picking && isSuperAdmin,
  });

  const start = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/view-as/${id}`),
    onSuccess: () => {
      // Everything on screen belongs to the previous identity. Drop the whole
      // cache rather than trying to decide what survives.
      queryClient.clear();
      window.location.href = "/admin";
    },
  });

  const stop = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/view-as/stop"),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = "/admin";
    },
  });

  if (viewingAs) {
    return (
      <div
        className="sticky top-0 z-[60] w-full bg-amber-500/[0.14] border-b border-amber-400/30 backdrop-blur"
        data-testid="banner-view-as"
      >
        <div className="max-w-[1600px] mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
          <Eye className="w-4 h-4 text-amber-300/80 flex-shrink-0" />
          <span className="text-[13px] text-amber-100/90">
            Viewing as <strong>{viewingAs.target.firstName} {viewingAs.target.lastName}</strong>
            <span className="text-amber-200/50"> — this is exactly what they see. Read-only.</span>
          </span>
          <button
            onClick={() => stop.mutate()}
            disabled={stop.isPending}
            data-testid="button-stop-view-as"
            className="ml-auto text-[12px] px-3 py-1.5 rounded-lg bg-amber-400/20 hover:bg-amber-400/30 text-amber-50 border border-amber-300/30 min-h-[32px] flex items-center gap-1.5"
          >
            {stop.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
            Back to my account
          </button>
        </div>
      </div>
    );
  }

  if (!isSuperAdmin) return null;

  const users = (staff?.users || []).filter(u => {
    if (!q.trim()) return true;
    const s = `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase();
    return s.includes(q.trim().toLowerCase());
  });

  return (
    <>
      <button
        onClick={() => setPicking(true)}
        data-testid="button-open-view-as"
        title="See ClubOS as a member of staff sees it"
        className="w-9 h-9 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] flex items-center justify-center hover:bg-white/[0.08] transition-colors"
      >
        <Eye className="w-4 h-4 text-white/40" />
      </button>

      {picking && (
        <div
          className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 sm:p-10 overflow-y-auto"
          onClick={() => setPicking(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-blue-500/[0.12] bg-[#070C16] overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
              <Eye className="w-4 h-4 text-white/40" />
              <span className="text-[13px] text-white/80 font-semibold">View ClubOS as…</span>
              <button onClick={() => setPicking(false)} className="ml-auto text-white/30 hover:text-white/70">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-4 py-3 border-b border-blue-500/[0.06]">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  autoFocus
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Search staff by name or email"
                  data-testid="input-view-as-search"
                  className="w-full bg-white/[0.04] border border-blue-500/[0.08] rounded-xl pl-9 pr-3 py-2.5 text-[13px] text-white/90 placeholder:text-white/25 outline-none focus:border-blue-500/25"
                />
              </div>
              <p className="text-[11px] text-white/30 mt-2 leading-relaxed">
                You'll see their exact tabs, workspaces and data. It's read-only — nothing can be
                changed or sent while you're in there, and every session is logged.
              </p>
            </div>

            <div className="max-h-[50vh] overflow-y-auto p-2">
              {isLoading && <p className="text-[13px] text-white/30 p-3">Loading staff…</p>}
              {!isLoading && users.length === 0 && (
                <p className="text-[13px] text-white/30 p-3">No staff match that.</p>
              )}
              {users.map(u => (
                <button
                  key={u.id}
                  onClick={() => start.mutate(u.id)}
                  disabled={start.isPending}
                  data-testid={`button-view-as-${u.id}`}
                  className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/[0.05] transition-colors disabled:opacity-50"
                >
                  <div className="text-[13px] text-white/85">{u.firstName} {u.lastName}</div>
                  <div className="text-[11px] text-white/35">{u.email}</div>
                  <div className="text-[10.5px] text-white/30 mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {u.workspaces.length === 0
                      ? <span className="text-amber-300/50">no workspaces — they see nothing</span>
                      : u.workspaces.map(w => (
                          <span key={w.slug}>{w.name} <span className="text-white/20">({accessLabel(w)})</span></span>
                        ))}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

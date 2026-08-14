// VIEW AS — the header control, and the staff picker behind it.
//
// Born 2026-08-13 after two staff reported working features as broken and
// neither could be reproduced by a super admin (super_admin short-circuits the
// permission checks everyone else runs). See server/view-as-routes.ts for the
// rules; this is the visible half.
//
// 🔴 THE PICKER MUST BE PORTALLED TO document.body. The ClubOS header is
// `h-14 backdrop-blur-2xl`, and a backdrop-filter makes an element a CONTAINING
// BLOCK for its `position: fixed` descendants. Rendered in place, a full-screen
// `fixed inset-0` overlay was clipped to the 56px header strip — the dialog
// appeared as an unreadable sliver. Same trap as the coaching app's exercise
// picker. Never render a modal inline from inside this header.
//
// 🔴 The viewing state must stay visible at all times. The failure mode of every
// impersonation feature is forgetting you are in one — and here that means
// reading a staff member's empty tab as your own broken software, which is the
// exact confusion this was built to end. Hence an amber pill that never leaves
// the header, not a banner that can scroll away.
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
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

  // Esc closes the picker — a modal you can only leave with the mouse is a trap
  // on a laptop, and this one opens over whatever you were already reading.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPicking(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

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

  // ── Viewing as someone: a compact amber pill, top right ────────────────────
  if (viewingAs) {
    return (
      <div
        className="flex items-center gap-1.5 rounded-xl bg-amber-500/15 border border-amber-400/30 pl-2.5 pr-1 py-1"
        data-testid="banner-view-as"
        title={`You are viewing ClubOS as ${viewingAs.target.firstName} ${viewingAs.target.lastName}. Read-only.`}
      >
        <Eye className="w-3.5 h-3.5 text-amber-300/90 flex-shrink-0" />
        <span className="text-[12px] text-amber-100/90 whitespace-nowrap">
          <span className="hidden sm:inline text-amber-200/60">Viewing as </span>
          <strong className="font-semibold">{viewingAs.target.firstName} {viewingAs.target.lastName}</strong>
        </span>
        <button
          onClick={() => stop.mutate()}
          disabled={stop.isPending}
          data-testid="button-stop-view-as"
          title="Back to my account"
          className="w-6 h-6 rounded-lg hover:bg-amber-400/25 flex items-center justify-center text-amber-100/80 flex-shrink-0"
        >
          {stop.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
        </button>
      </div>
    );
  }

  if (!isSuperAdmin) return null;

  const users = (staff?.users || []).filter(u => {
    if (!q.trim()) return true;
    return `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase());
  });

  const picker = (
    <div
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-start justify-center px-4 pt-[12vh] pb-8"
      onClick={() => setPicking(false)}
      data-testid="overlay-view-as"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-blue-500/[0.14] bg-[#070C16] shadow-2xl shadow-black/60 overflow-hidden flex flex-col max-h-[70vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-3 border-b border-blue-500/[0.08] flex-shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="View ClubOS as… search staff"
              data-testid="input-view-as-search"
              className="w-full bg-white/[0.05] border border-blue-500/[0.1] rounded-xl pl-9 pr-9 py-2.5 text-[13px] text-white/90 placeholder:text-white/30 outline-none focus:border-blue-500/30"
            />
            <button
              onClick={() => setPicking(false)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/70"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-2 flex-1">
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
              className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-white/[0.06] transition-colors disabled:opacity-50"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-white/85">{u.firstName} {u.lastName}</span>
                {start.isPending && <Loader2 className="w-3 h-3 animate-spin text-white/40" />}
              </div>
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

        <p className="text-[10.5px] text-white/25 px-4 py-2.5 border-t border-blue-500/[0.06] leading-relaxed flex-shrink-0">
          You'll see their exact tabs, workspaces and data. Read-only — nothing can be changed
          or sent while you're in there, and every session is logged.
        </p>
      </div>
    </div>
  );

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
      {/* 🔴 Portalled: the header's backdrop-filter would otherwise contain this
          fixed overlay and clip it to a 56px strip. */}
      {picking && createPortal(picker, document.body)}
    </>
  );
}

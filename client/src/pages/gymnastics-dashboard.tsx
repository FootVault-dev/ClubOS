import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useWorkspace } from "@/lib/workspace-context";
import { Dumbbell, GraduationCap, Users, DollarSign, Plus, FileEdit, Globe } from "lucide-react";
import type { Program } from "@shared/schema";

export default function GymnasticsDashboard() {
  const { currentOrg } = useWorkspace();
  const [, setLocation] = useLocation();
  const orgId = currentOrg?.id;

  const { data: programs = [] } = useQuery<Program[]>({
    queryKey: ["/api/admin/programs", { orgId }],
    queryFn: () => fetch(`/api/admin/programs?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId,
  });

  const activePrograms = programs.filter(p => p.isActive).length;

  // Registrations + revenue stay at 0 until we have a per-org stats endpoint.
  // The shared /api/admin/stats was org-blind and bled CUFC numbers in here.
  const cards = [
    { label: "Programs", value: programs.length, icon: GraduationCap, accent: "blue" },
    { label: "Active Now", value: activePrograms, icon: Dumbbell, accent: "green" },
    { label: "Registrations", value: 0, icon: Users, accent: "amber" },
    { label: "Revenue", value: "$0.00", icon: DollarSign, accent: "purple" },
  ];

  const accentClass = (accent: string) => {
    switch (accent) {
      case "blue": return "bg-blue-500/10 text-blue-400";
      case "green": return "bg-green-500/10 text-green-400";
      case "amber": return "bg-amber-500/10 text-amber-400";
      case "purple": return "bg-purple-500/10 text-purple-400";
      default: return "bg-white/5 text-white/40";
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white" data-testid="text-gymnastics-dashboard-title">Dashboard</h1>
        <p className="text-sm text-white/40 mt-1">United Gymnastics management overview</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map(c => (
          <div key={c.label} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 flex items-center justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1">{c.label}</div>
              <div className="text-3xl font-bold text-white">{c.value}</div>
            </div>
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${accentClass(c.accent)}`}>
              <c.icon className="w-5 h-5" />
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-white/70">Active Programs</h2>
            <button onClick={() => setLocation("/admin/programs")} className="text-xs text-blue-400/70 hover:text-blue-400">View all</button>
          </div>
          {programs.filter(p => p.isActive).length === 0 ? (
            <div className="py-10 text-center">
              <Dumbbell className="w-8 h-8 text-white/15 mx-auto mb-2" />
              <p className="text-sm text-white/40">No active programs yet.</p>
              <button
                onClick={() => setLocation("/admin/programs")}
                className="mt-3 inline-flex items-center gap-1 text-xs text-blue-400/70 hover:text-blue-400"
              >
                <Plus className="w-3 h-3" /> Create your first program
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {programs.filter(p => p.isActive).slice(0, 5).map(p => (
                <button
                  key={p.id}
                  onClick={() => setLocation(`/admin/programs/${p.id}`)}
                  className="w-full flex items-center justify-between p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 text-left"
                >
                  <div>
                    <div className="text-sm text-white">{p.name}</div>
                    <div className="text-xs text-white/30">/{p.slug}</div>
                  </div>
                  <span className="text-[10px] text-green-400/80 px-2 py-0.5 rounded bg-green-500/10">Active</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <h2 className="text-sm font-semibold text-white/70 mb-3">Quick Actions</h2>
          <div className="space-y-2">
            <button
              onClick={() => setLocation("/admin/programs")}
              className="w-full flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 text-left"
            >
              <Plus className="w-4 h-4 text-blue-400/80" />
              <div>
                <div className="text-sm text-white">Create Program</div>
                <div className="text-xs text-white/30">New class, camp, or workshop</div>
              </div>
            </button>
            <button
              onClick={() => setLocation("/admin/programs")}
              className="w-full flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 text-left"
            >
              <FileEdit className="w-4 h-4 text-purple-400/80" />
              <div>
                <div className="text-sm text-white">Edit Landing Pages</div>
                <div className="text-xs text-white/30">Adjust copy + visuals per program</div>
              </div>
            </button>
            <button
              onClick={() => setLocation("/admin/domains")}
              className="w-full flex items-center gap-3 p-3 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] border border-white/5 text-left"
            >
              <Globe className="w-4 h-4 text-amber-400/80" />
              <div>
                <div className="text-sm text-white">Configure Domain</div>
                <div className="text-xs text-white/30">Set up a custom subdomain</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

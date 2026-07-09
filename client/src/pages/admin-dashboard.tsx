import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tent, Users, ClipboardCheck, DollarSign, ArrowRight, CalendarPlus, ClipboardList, Download, GraduationCap, UserCog , Shield} from "lucide-react";
import { Link } from "wouter";
import { formatCurrency } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace-context";

export default function AdminDashboard() {
  const { currentOrg } = useWorkspace();
  // Christchurch United now runs its whole club through ClubOS — academy,
  // squads, contacts, payments — not just holiday camps. Every other
  // workspace (SIU camps, CUGC, etc.) keeps the original camps-only view.
  const isCUFC = currentOrg?.slug === "christchurch-united";

  const { data: stats, isLoading } = useQuery<{
    totalParents: number;
    activeCamps: number;
    totalRegistrations: number;
    paidRegistrations: number;
    totalRevenueCents: number;
    registeredPlayers?: number;
  }>({ queryKey: ["/api/admin/stats"] });

  const { data: camps } = useQuery<any[]>({ queryKey: ["/api/admin/camps"] });

  // Academy programmes — CUFC only. `/api/admin/camps` only ever returns
  // holiday_camp-type programs, so the club-wide "Programmes" panel reads
  // from the real academy endpoint instead.
  const { data: academyPrograms } = useQuery<any[]>({
    queryKey: ["/api/admin/academy"],
    enabled: isCUFC,
  });

  const openProgrammes = (academyPrograms ?? []).filter((p: any) => p.isActive && p.registrationOpen);
  const activeCamps = (camps ?? []).filter((c: any) => c.isActive);

  const statCards = isCUFC
    ? [
        { title: "Registered Players", value: stats?.registeredPlayers ?? stats?.totalParents ?? 0, icon: Users, color: "blue", delay: 50 },
        { title: "Programmes Open", value: openProgrammes.length, icon: GraduationCap, color: "emerald", delay: 100 },
        { title: "Registrations", value: stats?.totalRegistrations ?? 0, icon: ClipboardCheck, color: "amber", delay: 150 },
        { title: "Revenue", value: formatCurrency((stats?.totalRevenueCents ?? 0), { fromCents: true }), icon: DollarSign, color: "violet", delay: 200 },
      ]
    : [
        { title: "Total Parents", value: stats?.totalParents ?? 0, icon: Users, color: "blue", delay: 50 },
        { title: "Active Camps", value: stats?.activeCamps ?? 0, icon: Tent, color: "emerald", delay: 100 },
        { title: "Registrations", value: stats?.totalRegistrations ?? 0, icon: ClipboardCheck, color: "amber", delay: 150 },
        { title: "Revenue", value: formatCurrency((stats?.totalRevenueCents ?? 0), { fromCents: true }), icon: DollarSign, color: "violet", delay: 200 },
      ];

  const colorMap: Record<string, string> = {
    blue: "from-blue-500/15 to-blue-600/5 border-blue-500/20 shadow-[0_0_20px_rgba(3,86,197,0.08)]",
    emerald: "from-emerald-500/12 to-emerald-600/3 border-emerald-500/15 shadow-[0_0_20px_rgba(16,185,129,0.06)]",
    amber: "from-amber-500/12 to-amber-600/3 border-amber-500/15 shadow-[0_0_20px_rgba(245,158,11,0.06)]",
    violet: "from-violet-500/12 to-violet-600/3 border-violet-500/15 shadow-[0_0_20px_rgba(139,92,246,0.06)]",
  };
  const iconColorMap: Record<string, string> = {
    blue: "text-blue-400 bg-blue-500/10 border-blue-500/20",
    emerald: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
    amber: "text-amber-400 bg-amber-500/10 border-amber-500/20",
    violet: "text-violet-400 bg-violet-500/10 border-violet-500/20",
  };

  const quickActions = isCUFC
    ? [
        { title: "New Academy Programme", desc: "Set up a new academy programme", icon: GraduationCap, href: "/admin/academy?action=new" },
        { title: "Registrations", desc: "View every registration", icon: ClipboardList, href: "/admin/registrations" },
        { title: "Squads", desc: "Teams and rosters, U9 → First Team", icon: Shield, href: "/admin/squads" },
      ]
    : [
        { title: "Create Camp", desc: "Set up a new holiday camp", icon: CalendarPlus, href: "/admin/camps?action=new" },
        { title: "View Attendance", desc: "Check in/out for today", icon: ClipboardList, href: "/admin/attendance" },
        { title: "Export Emails", desc: "Download parent contact lists", icon: Download, href: "/admin/crm" },
      ];

  return (
    <div className="p-4 sm:p-8 space-y-6 sm:space-y-8 max-w-7xl mx-auto">
      <div className="animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Dashboard</h1>
        <p className="text-blue-400/35 text-[13px] mt-1">{isCUFC ? "Club Management" : "Holiday Camps Management"}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          [1, 2, 3, 4].map(i => (
            <div key={i} className="rounded-2xl glass-card p-5">
              <Skeleton className="h-20 w-full bg-blue-500/[0.04]" />
            </div>
          ))
        ) : (
          statCards.map((card) => (
            <div
              key={card.title}
              className={`stat-glow relative rounded-2xl border bg-gradient-to-br p-5 animate-fade-in-up transition-all duration-500 hover:scale-[1.02] ${colorMap[card.color]}`}
              style={{ animationDelay: `${card.delay}ms`, opacity: 0 }}
              data-testid={`stat-${card.title.toLowerCase().replace(/\s/g, '-')}`}
            >
              <div className="flex items-center justify-between mb-4">
                <span className="text-[12px] text-white/45 font-medium uppercase tracking-wider">{card.title}</span>
                <div className={`w-9 h-9 rounded-xl border flex items-center justify-center ${iconColorMap[card.color]}`}>
                  <card.icon className="w-4 h-4" />
                </div>
              </div>
              <span className="text-3xl font-bold text-white tracking-tight">{card.value}</span>
            </div>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {isCUFC ? (
          <div className="lg:col-span-2 rounded-2xl glass-card overflow-hidden animate-fade-in-up" style={{ animationDelay: '250ms', opacity: 0 }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
              <h3 className="text-[14px] font-semibold text-white/75">Programmes</h3>
              <Button variant="ghost" size="sm" asChild className="text-blue-400/60 hover:text-blue-400 text-[12px] h-7">
                <Link href="/admin/academy">View all</Link>
              </Button>
            </div>
            <div>
              {academyPrograms && academyPrograms.length > 0 ? (
                <div className="divide-y divide-blue-500/[0.04]">
                  {academyPrograms.map((program: any) => {
                    const open = program.isActive && program.registrationOpen;
                    const ageBand = program.ageMin && program.ageMax
                      ? `U${program.ageMin}–U${program.ageMax}`
                      : program.ageMin
                        ? `U${program.ageMin}+`
                        : null;
                    return (
                      <Link key={program.id} href={`/admin/camps/${program.id}`}>
                        <div className="flex items-center gap-3 px-5 py-3 row-hover cursor-pointer" data-testid={`row-programme-${program.id}`}>
                          <div className="w-8 h-8 rounded-xl bg-blue-500/8 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
                            <GraduationCap className="w-4 h-4 text-blue-400/70" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-medium text-white/75 truncate">{program.name}</p>
                            {ageBand && <p className="text-[11px] text-white/25">{ageBand}</p>}
                          </div>
                          {open ? (
                            <Badge variant="outline" className="flex-shrink-0 text-[9px] text-emerald-400/70 border-emerald-500/15 bg-emerald-500/10 uppercase tracking-wider no-default-hover-elevate no-default-active-elevate">
                              Open
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="flex-shrink-0 text-[9px] text-amber-400/60 border-amber-500/15 bg-amber-500/10 uppercase tracking-wider no-default-hover-elevate no-default-active-elevate">
                              Waitlist
                            </Badge>
                          )}
                          <ArrowRight className="w-4 h-4 text-white/15" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <GraduationCap className="w-10 h-10 text-blue-400/10 mb-3" />
                  <p className="text-[13px] text-white/25">No academy programmes yet</p>
                  <Button asChild className="mt-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-8 text-[12px] glow-btn">
                    <Link href="/admin/academy?action=new">New Programme</Link>
                  </Button>
                </div>
              )}
              {activeCamps.length > 0 && (
                <div className="px-5 py-3 border-t border-blue-500/[0.08] flex items-center justify-between">
                  <span className="text-[12px] text-white/30">{activeCamps.length} active {activeCamps.length === 1 ? "camp" : "camps"}</span>
                  <Link href="/admin/camps" className="text-[12px] text-blue-400/60 hover:text-blue-400">View camps</Link>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="lg:col-span-2 rounded-2xl glass-card overflow-hidden animate-fade-in-up" style={{ animationDelay: '250ms', opacity: 0 }}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
              <h3 className="text-[14px] font-semibold text-white/75">Active Camps</h3>
              <Button variant="ghost" size="sm" asChild className="text-blue-400/60 hover:text-blue-400 text-[12px] h-7">
                <Link href="/admin/camps">View all</Link>
              </Button>
            </div>
            <div>
              {camps && camps.length > 0 ? (
                <div className="divide-y divide-blue-500/[0.04]">
                  {camps.filter((c: any) => c.isActive).map((camp: any) => (
                    <Link key={camp.id} href={`/admin/camps/${camp.id}`}>
                      <div className="flex items-center gap-3 px-5 py-3 row-hover cursor-pointer" data-testid={`row-camp-${camp.id}`}>
                        <div className="w-8 h-8 rounded-xl bg-emerald-500/8 border border-emerald-500/15 flex items-center justify-center flex-shrink-0">
                          <Tent className="w-4 h-4 text-emerald-400/70" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-white/75 truncate">{camp.name}</p>
                          <p className="text-[11px] text-white/25">
                            {camp.startDate && camp.endDate ? `${camp.startDate} — ${camp.endDate}` : "Dates TBD"}
                            {camp.location && ` · ${camp.location}`}
                          </p>
                        </div>
                        <ArrowRight className="w-4 h-4 text-white/15" />
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <Tent className="w-10 h-10 text-blue-400/10 mb-3" />
                  <p className="text-[13px] text-white/25">No camps yet</p>
                  <Button asChild className="mt-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-8 text-[12px] glow-btn">
                    <Link href="/admin/camps?action=new">Create Camp</Link>
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="rounded-2xl glass-card overflow-hidden animate-fade-in-up" style={{ animationDelay: '300ms', opacity: 0 }}>
          <div className="px-5 py-4 border-b border-blue-500/[0.08]">
            <h3 className="text-[14px] font-semibold text-white/75">Quick Actions</h3>
          </div>
          <div className="p-3 space-y-2">
            {quickActions.map((action) => (
              <Link key={action.title} href={action.href}>
                <div className="flex items-center gap-4 p-3.5 rounded-xl cursor-pointer glass-card hover:border-blue-500/25 transition-all duration-300 group" data-testid={`action-${action.title.toLowerCase().replace(/\s/g, '-')}`}>
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center group-hover:shadow-[0_0_12px_rgba(3,86,197,0.15)] transition-shadow duration-300">
                    <action.icon className="w-4 h-4 text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[13px] text-white/75">{action.title}</p>
                    <p className="text-[11px] text-white/30">{action.desc}</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-white/15 group-hover:text-blue-400/50 group-hover:translate-x-0.5 transition-all duration-300" />
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

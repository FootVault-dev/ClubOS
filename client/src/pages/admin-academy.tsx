import { useState, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, X, ChevronRight, Users, UserPlus, GraduationCap, Sparkles } from "lucide-react";
import { useSearch, useLocation } from "wouter";
import { programDetailPath } from "@/lib/program-path";
import type { Program } from "@shared/schema";
import { RegisterPlayerModal } from "./admin-register-player";

type AcademyProgram = Program & { academySection?: string };

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return "Ongoing";
  const start = new Date(startDate + "T00:00:00");
  const end = new Date(endDate + "T00:00:00");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startDay = String(start.getDate()).padStart(2, "0");
  const endDay = String(end.getDate()).padStart(2, "0");
  const startMonth = months[start.getMonth()];
  const endMonth = months[end.getMonth()];
  const endYear = end.getFullYear();
  if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
    return `${startDay} – ${endDay} ${endMonth} ${endYear}`;
  }
  return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`;
}

function CreateAcademyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("Christchurch Football Centre, 250 Westminster St");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [ageMin, setAgeMin] = useState("");
  const [ageMax, setAgeMax] = useState("");
  const [academySection, setAcademySection] = useState("core");

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/academy", {
        name, slug, description, location,
        startDate: startDate || null,
        endDate: endDate || null,
        ageMin: ageMin ? parseInt(ageMin) : null,
        ageMax: ageMax ? parseInt(ageMax) : null,
        isActive: true,
        academySection,
      });
      return res.json();
    },
    onSuccess: (program: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/academy"] });
      toast({ title: "Program created" });
      onClose();
      window.location.href = programDetailPath({ id: program.id, type: "academy" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden animate-fade-in-up" style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.06) 0%, #02060E 100%)", animationDelay: "0ms", opacity: 0 }} data-testid="modal-create-academy">
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <h3 className="text-[14px] font-semibold text-white/80">Create Academy Program</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Program Section</label>
            <Select value={academySection} onValueChange={setAcademySection}>
              <SelectTrigger className="premium-input text-white/80 rounded-xl" data-testid="select-academy-section">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="core">
                  <div className="flex items-center gap-2">
                    <GraduationCap className="w-3.5 h-3.5" />
                    Core Academy Program
                  </div>
                </SelectItem>
                <SelectItem value="additional">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5" />
                    Additional Program
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-white/20">
              {academySection === "core"
                ? "Core programs: Under 4, Under 8, Under 9, Under 12, Under 13, Under 20, etc."
                : "Additional programs: Technification, Goalkeeper Training, etc."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Program Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Under 13 Academy" className="premium-input text-white/80 rounded-xl" data-testid="input-academy-name" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">URL Slug</label>
              <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="under-13-academy" className="premium-input text-white/80 rounded-xl" data-testid="input-academy-slug" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Academy program description..." className="w-full h-20 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-academy-description" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Location</label>
              <Input value={location} onChange={e => setLocation(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-academy-location" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Start Date</label>
              <DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-academy-start" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">End Date</label>
              <DatePickerInput value={endDate} onChange={e => setEndDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-academy-end" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Min Age</label>
              <Input type="number" value={ageMin} onChange={e => setAgeMin(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-academy-age-min" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Max Age</label>
              <Input type="number" value={ageMax} onChange={e => setAgeMax(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-academy-age-max" />
            </div>
          </div>
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !name || !slug} className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] glow-btn" data-testid="button-create-academy">
            {createMutation.isPending ? "Creating..." : "Create Program"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProgramTable({ programs, regCounts, navigate, emptyMessage }: {
  programs: AcademyProgram[];
  regCounts: Record<number, number>;
  navigate: (path: string) => void;
  emptyMessage: string;
}) {
  if (programs.length === 0) {
    return (
      <div className="py-6 text-center">
        <p className="text-[12px] text-white/20">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[500px]" data-testid="table-academy">
        <thead>
          <tr className="border-b border-blue-500/[0.08]">
            <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Program</th>
            <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold hidden md:table-cell">Period</th>
            <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold hidden lg:table-cell">Ages</th>
            <th className="text-center px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Status</th>
            <th className="text-center px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Registrations</th>
            <th className="w-10 px-3 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {programs.map((program, idx) => {
            const count = regCounts[program.id] ?? 0;
            return (
              <tr
                key={program.id}
                onClick={() => navigate(programDetailPath(program))}
                className={`group cursor-pointer transition-colors duration-200 hover:bg-blue-500/[0.04] ${idx < programs.length - 1 ? "border-b border-blue-500/[0.05]" : ""}`}
                data-testid={`row-academy-${program.id}`}
              >
                <td className="px-5 py-3.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-medium text-white/80" data-testid={`text-academy-name-${program.id}`}>{program.name}</span>
                    {program.slug && <span className="text-[11px] text-blue-400/30">/{program.slug}</span>}
                  </div>
                </td>
                <td className="px-5 py-3.5 hidden md:table-cell">
                  <span className="text-[12px] text-white/40">
                    {formatDateRange(program.startDate, program.endDate)}
                  </span>
                </td>
                <td className="px-5 py-3.5 hidden lg:table-cell">
                  <span className="text-[12px] text-white/40">
                    {program.ageMin && program.ageMax ? `${program.ageMin}–${program.ageMax} yrs` : program.ageMin ? `${program.ageMin}+ yrs` : "—"}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-center">
                  {program.isActive ? (
                    <Badge variant="outline" className="text-[9px] text-emerald-400/70 border-emerald-500/15 bg-emerald-500/10 uppercase tracking-wider no-default-hover-elevate no-default-active-elevate">
                      Active
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] text-white/30 border-white/10 bg-white/[0.03] uppercase tracking-wider no-default-hover-elevate no-default-active-elevate">
                      Inactive
                    </Badge>
                  )}
                </td>
                <td className="px-5 py-3.5 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-blue-400/30" />
                    <span className="text-[13px] text-white/60 font-medium">{count}</span>
                  </div>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <ChevronRight className="w-4 h-4 text-white/15 group-hover:text-blue-400/50 transition-colors duration-200" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminAcademy() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const [showCreate, setShowCreate] = useState(search.includes("action=new"));
  const [showRegister, setShowRegister] = useState(false);
  const [filter, setFilter] = useState("");
  const { data: programs, isLoading } = useQuery<AcademyProgram[]>({ queryKey: ["/api/admin/academy"] });
  const { data: regCounts } = useQuery<Record<number, number>>({ queryKey: ["/api/admin/academy/registration-counts"] });

  const filtered = programs?.filter(p =>
    p.name.toLowerCase().includes(filter.toLowerCase()) ||
    p.slug?.toLowerCase().includes(filter.toLowerCase())
  );

  const corePrograms = filtered?.filter(p => (p.academySection || "core") === "core") || [];
  const additionalPrograms = filtered?.filter(p => p.academySection === "additional") || [];

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Academy</h1>
          <p className="text-blue-400/35 text-[13px] mt-1">Manage academy programs and registrations</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowRegister(true)} variant="outline" className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10 rounded-xl h-9 text-[13px] font-medium" data-testid="button-register-player">
            <UserPlus className="w-4 h-4 mr-1.5" /> Register Player
          </Button>
          <Button onClick={() => setShowCreate(true)} className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-9 text-[13px] font-medium glow-btn" data-testid="button-new-academy">
            <Plus className="w-4 h-4 mr-1.5" /> New Program
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-white/5 animate-fade-in-up" style={{ animationDelay: '90ms', opacity: 0 }}>
        <button
          className="px-4 py-2.5 text-sm font-medium text-white border-b-2 border-blue-500 -mb-px"
        >
          Programs
        </button>
        <button
          onClick={() => navigate("/admin/terms")}
          className="px-4 py-2.5 text-sm font-medium text-white/50 hover:text-white/80 border-b-2 border-transparent -mb-px"
          data-testid="tab-academy-term-dates"
        >
          Term Dates
        </button>
      </div>

      <div className="relative animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search programs..." className="pl-10 premium-input text-white/80 rounded-xl h-10" data-testid="input-search-academy" />
      </div>

      <div className="space-y-6 animate-fade-in-up" style={{ animationDelay: '150ms', opacity: 0 }}>
        {isLoading ? (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full rounded-xl bg-blue-500/[0.04]" />)}
            </div>
          </div>
        ) : (
          <Fragment>
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
                <GraduationCap className="w-4 h-4 text-blue-400/40" />
                <h2 className="text-[13px] font-semibold text-white/60">Core Academy Programs</h2>
                <Badge variant="outline" className="text-[9px] text-blue-400/50 border-blue-500/15 bg-blue-500/5 ml-auto no-default-hover-elevate no-default-active-elevate">
                  {corePrograms.length}
                </Badge>
              </div>
              <ProgramTable
                programs={corePrograms}
                regCounts={regCounts || {}}
                navigate={navigate}
                emptyMessage="No core academy programs yet. Create one to get started."
              />
            </div>

            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400/40" />
                <h2 className="text-[13px] font-semibold text-white/60">Additional Programs</h2>
                <Badge variant="outline" className="text-[9px] text-amber-400/50 border-amber-500/15 bg-amber-500/5 ml-auto no-default-hover-elevate no-default-active-elevate">
                  {additionalPrograms.length}
                </Badge>
              </div>
              <ProgramTable
                programs={additionalPrograms}
                regCounts={regCounts || {}}
                navigate={navigate}
                emptyMessage="No additional programs yet. Add technification, goalkeeper training, etc."
              />
            </div>
          </Fragment>
        )}
      </div>

      <CreateAcademyModal open={showCreate} onClose={() => setShowCreate(false)} />
      <RegisterPlayerModal open={showRegister} onClose={() => setShowRegister(false)} />
    </div>
  );
}

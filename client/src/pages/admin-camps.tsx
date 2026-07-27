import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, X, ChevronRight, Users, UserPlus } from "lucide-react";
import { useSearch, useLocation } from "wouter";
import type { Program } from "@shared/schema";
import { RegisterPlayerModal } from "./admin-register-player";

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return "No dates set";
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

type CampMode = "holiday" | "term";

function CreateCampModal({
  open,
  onClose,
  prefill,
}: {
  open: boolean;
  onClose: () => void;
  prefill?: { name?: string; startDate?: string; endDate?: string };
}) {
  const { toast } = useToast();
  const [mode, setMode] = useState<CampMode>("holiday");
  const [name, setName] = useState(prefill?.name ?? "");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("Christchurch Football Centre, 250 Westminster St");
  const [startDate, setStartDate] = useState(prefill?.startDate ?? "");
  const [endDate, setEndDate] = useState(prefill?.endDate ?? "");
  const [ageMin, setAgeMin] = useState("3");
  const [ageMax, setAgeMax] = useState("12");

  // Term-mode fields
  const [termId, setTermId] = useState<string>("");
  const [termPrice, setTermPrice] = useState<string>("");

  // Org context — needed to scope the term picker to the right workspace.
  const { data: me } = useQuery<{ user: { organizationId: number } }>({
    queryKey: ["/api/auth/me"],
  });
  const orgId = me?.user?.organizationId;

  const { data: termsList } = useQuery<{ id: number; name: string; year: number; termNumber: number; startDate: string; endDate: string }[]>({
    queryKey: ["/api/admin/terms", { orgId }],
    enabled: mode === "term" && !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const isTerm = mode === "term";
      const body: Record<string, unknown> = {
        name, slug, description, location,
        startDate: startDate || null,
        endDate: endDate || null,
        ageMin: parseInt(ageMin) || null,
        ageMax: parseInt(ageMax) || null,
        isActive: true,
      };
      if (isTerm) {
        body.scheduleType = "term";
        body.termId = termId ? parseInt(termId) : null;
        body.pricingModel = "term_prorated";
        body.termPriceCents = termPrice ? Math.round(parseFloat(termPrice) * 100) : null;
        body.organizationId = orgId;
      }
      const res = await apiRequest("POST", "/api/admin/camps", body);
      return res.json();
    },
    onSuccess: (camp: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps"] });
      toast({ title: mode === "term" ? "Term program created" : "Camp created" });
      onClose();
      window.location.href = `/admin/camps/${camp.id}`;
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden animate-fade-in-up" style={{ background: "linear-gradient(135deg, rgba(3,86,197,0.06) 0%, #02060E 100%)", animationDelay: "0ms", opacity: 0 }} data-testid="modal-create-camp">
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <h3 className="text-[14px] font-semibold text-white/80">{mode === "term" ? "Create Term Program" : "Create Holiday Camp"}</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {/* Mode selector */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-1 grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => setMode("holiday")}
              className={`text-[12px] font-semibold py-2 rounded-lg transition-colors ${mode === "holiday" ? "bg-blue-500/20 text-blue-200 border border-blue-500/40" : "text-white/40 hover:text-white/60"}`}
              data-testid="mode-holiday"
            >
              Holiday Camp
            </button>
            <button
              type="button"
              onClick={() => setMode("term")}
              className={`text-[12px] font-semibold py-2 rounded-lg transition-colors ${mode === "term" ? "bg-blue-500/20 text-blue-200 border border-blue-500/40" : "text-white/40 hover:text-white/60"}`}
              data-testid="mode-term"
            >
              Term Program
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Camp Name</label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="FUNdamentals Holiday Camp" className="premium-input text-white/80 rounded-xl" data-testid="input-camp-name" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">URL Slug</label>
              <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="fundamentals" className="premium-input text-white/80 rounded-xl" data-testid="input-camp-slug" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Description</label>
              <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Fun holiday camp for young players..." className="w-full h-20 px-3 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/80 placeholder:text-white/20 focus:outline-none focus:border-blue-500/30 resize-none" data-testid="input-camp-description" />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Location</label>
              <Input value={location} onChange={e => setLocation(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-location" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Start Date</label>
              <DatePickerInput value={startDate} onChange={e => setStartDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-start" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">End Date</label>
              <DatePickerInput value={endDate} onChange={e => setEndDate(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-end" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Min Age</label>
              <Input type="number" value={ageMin} onChange={e => setAgeMin(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-age-min" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Max Age</label>
              <Input type="number" value={ageMax} onChange={e => setAgeMax(e.target.value)} className="premium-input text-white/80 rounded-xl" data-testid="input-camp-age-max" />
            </div>

            {mode === "term" && (
              <>
                <div className="col-span-2 space-y-1.5">
                  <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Term</label>
                  <select
                    value={termId}
                    onChange={e => setTermId(e.target.value)}
                    className="premium-input text-white/80 rounded-xl w-full"
                    data-testid="select-term"
                  >
                    <option value="">Select a term…</option>
                    {(termsList ?? []).map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.year} T{t.termNumber}) — {t.startDate} → {t.endDate}
                      </option>
                    ))}
                  </select>
                  <div className="text-[10px] text-white/30">
                    Sessions will be auto-generated from the weekly schedule once you set it on the next screen.
                    {(!termsList || termsList.length === 0) && (
                      <span className="block mt-1 text-amber-300/70">No terms yet — set them up in <span className="font-mono">/admin/terms</span> first.</span>
                    )}
                  </div>
                </div>
                <div className="col-span-2 space-y-1.5">
                  <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Term Price (full term, $NZD)</label>
                  <Input type="number" step="0.01" value={termPrice} onChange={e => setTermPrice(e.target.value)} placeholder="e.g. 195.00" className="premium-input text-white/80 rounded-xl" data-testid="input-term-price" />
                  <div className="text-[10px] text-white/30">Pro-rated automatically for parents who sign up mid-term.</div>
                </div>
              </>
            )}
          </div>
          <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending || !name || !slug || (mode === "term" && (!termId || !termPrice))} className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] glow-btn" data-testid="button-create-camp">
            {createMutation.isPending ? "Creating..." : (mode === "term" ? "Create Term Program" : "Create Camp")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AdminCamps() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const [showCreate, setShowCreate] = useState(search.includes("action=new"));
  const [showRegister, setShowRegister] = useState(false);
  const [filter, setFilter] = useState("");
  const { data: camps, isLoading } = useQuery<Program[]>({ queryKey: ["/api/admin/camps"] });
  const { data: regCounts } = useQuery<Record<number, number>>({ queryKey: ["/api/admin/camps/registration-counts"] });

  // Read prefill values from the URL (set by the "Plan a holiday camp here"
  // button on the Term Dates page) so the create modal opens with the
  // dates and a sensible default name pre-populated.
  const prefill = useMemo(() => {
    const params = new URLSearchParams(search);
    if (!params.has("action")) return undefined;
    return {
      name: params.get("name") ?? undefined,
      startDate: params.get("startDate") ?? undefined,
      endDate: params.get("endDate") ?? undefined,
    };
  }, [search]);

  const filtered = camps?.filter(c =>
    c.name.toLowerCase().includes(filter.toLowerCase()) ||
    c.slug?.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Camps</h1>
          <p className="text-blue-400/35 text-[13px] mt-1">Manage your holiday camps</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowRegister(true)} variant="outline" className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10 rounded-xl h-9 text-[13px] font-medium" data-testid="button-register-player">
            <UserPlus className="w-4 h-4 mr-1.5" /> Register Player
          </Button>
          <Button onClick={() => setShowCreate(true)} className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-9 text-[13px] font-medium glow-btn" data-testid="button-new-camp">
            <Plus className="w-4 h-4 mr-1.5" /> New Camp
          </Button>
        </div>
      </div>

      <div className="relative animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Search camps..." className="pl-10 premium-input text-white/80 rounded-xl h-10" data-testid="input-search-camps" />
      </div>

      <div className="animate-fade-in-up" style={{ animationDelay: '150ms', opacity: 0 }}>
        {isLoading ? (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="p-4 space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full rounded-xl bg-blue-500/[0.04]" />)}
            </div>
          </div>
        ) : filtered && filtered.length > 0 ? (
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
            <table className="w-full min-w-[500px]" data-testid="table-camps">
              <thead>
                <tr className="border-b border-blue-500/[0.08]">
                  <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Name</th>
                  <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold hidden md:table-cell">Dates</th>
                  <th className="text-left px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold hidden lg:table-cell">Location</th>
                  <th className="text-center px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Status</th>
                  <th className="text-center px-5 py-3 text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Registrations</th>
                  <th className="w-10 px-3 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((camp, idx) => {
                  const count = regCounts?.[camp.id] ?? 0;
                  return (
                      <tr
                        key={camp.id}
                        onClick={() => navigate(`/admin/camps/${camp.id}`)}
                        className={`group cursor-pointer transition-colors duration-200 hover:bg-blue-500/[0.04] ${idx < filtered.length - 1 ? "border-b border-blue-500/[0.05]" : ""}`}
                        data-testid={`row-camp-${camp.id}`}
                      >
                        <td className="px-5 py-3.5">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[13px] font-medium text-white/80" data-testid={`text-camp-name-${camp.id}`}>{camp.name}</span>
                            {camp.slug && <span className="text-[11px] text-blue-400/30">/{camp.slug}</span>}
                          </div>
                        </td>
                        <td className="px-5 py-3.5 hidden md:table-cell">
                          <span className="text-[12px] text-white/40" data-testid={`text-camp-dates-${camp.id}`}>
                            {formatDateRange(camp.startDate, camp.endDate)}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 hidden lg:table-cell">
                          <span className="text-[12px] text-white/40 truncate block max-w-[200px]" data-testid={`text-camp-location-${camp.id}`}>
                            {camp.location || "—"}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-center">
                          {camp.isActive ? (
                            <Badge variant="outline" className="text-[9px] text-emerald-400/70 border-emerald-500/15 bg-emerald-500/10 uppercase tracking-wider no-default-hover-elevate no-default-active-elevate" data-testid={`badge-status-${camp.id}`}>
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] text-white/30 border-white/10 bg-white/[0.03] uppercase tracking-wider no-default-hover-elevate no-default-active-elevate" data-testid={`badge-status-${camp.id}`}>
                              Inactive
                            </Badge>
                          )}
                        </td>
                        <td className="px-5 py-3.5 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <Users className="w-3.5 h-3.5 text-blue-400/30" />
                            <span className="text-[13px] text-white/60 font-medium" data-testid={`text-camp-regs-${camp.id}`}>{count}</span>
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
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center glass-card rounded-2xl">
            <Users className="w-12 h-12 text-blue-400/10 mb-4" />
            <h3 className="text-[15px] font-medium text-white/40 mb-1">No camps found</h3>
            <p className="text-[12px] text-white/20 mb-4">Create your first holiday camp to get started</p>
          </div>
        )}
      </div>

      <CreateCampModal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          // Strip the prefill query string so re-opening the modal manually
          // doesn't keep auto-filling the previous holiday's dates.
          if (search.includes("action=new")) navigate("/admin/camps");
        }}
        prefill={prefill}
        key={prefill ? `${prefill.startDate}-${prefill.name}` : "blank"}
      />
      <RegisterPlayerModal open={showRegister} onClose={() => setShowRegister(false)} scope="camp" />
    </div>
  );
}

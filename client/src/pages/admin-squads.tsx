import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Plus, Search, X, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Users, Users2,
  UserPlus, Shield, Trophy, GraduationCap, Baby, Pencil, Trash2, LogOut, AlertTriangle,
  Info, Clock, Check,
} from "lucide-react";
import {
  SQUAD_ROLE_LABELS,
  STAFF_ROLES,
  POSITIONS,
  POSITION_LABELS,
  SQUAD_BANDS,
  SQUAD_BAND_LABELS,
  bandForAgeGrade,
  isSquadRole,
  type SquadRole,
  type Position,
  type SquadBand,
} from "@shared/squads";

// ── Types — client-local mirrors of the /api/admin/squads JSON shapes ───────

type Squad = {
  id: number;
  name: string;
  slug: string | null;
  ageGrade: number | null;
  seasonYear: number;
  competition: string | null;
  band: string | null;
  displayOrder: number;
  notes: string | null;
  isActive: boolean;
  players: number;
  staff: number;
};

type Eligibility = { eligible: boolean; grade: number | null; reason: string };

type Member = {
  id: number;
  role: string;
  squadNumber: number | null;
  position: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  notes: string | null;
  contactId: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  email: string | null;
  phone: string | null;
  eligibility: Eligibility | null;
};

type Candidate = {
  id: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  type: string;
  email: string | null;
  eligibility: Eligibility | null;
};

function formatShortDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
}

// ── New / edit squad ─────────────────────────────────────────────────────────

function SquadFormModal({
  open,
  onClose,
  squad,
  defaultSeason,
}: {
  open: boolean;
  onClose: () => void;
  squad?: Squad | null;
  defaultSeason: number;
}) {
  const { toast } = useToast();
  const isEdit = !!squad;
  const [name, setName] = useState("");
  const [seasonYear, setSeasonYear] = useState(String(defaultSeason));
  const [ageGrade, setAgeGrade] = useState("");
  const [competition, setCompetition] = useState("");
  const [band, setBand] = useState<SquadBand>("senior");
  const [notes, setNotes] = useState("");
  const [bandTouched, setBandTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(squad?.name ?? "");
    setSeasonYear(String(squad?.seasonYear ?? defaultSeason));
    setAgeGrade(squad?.ageGrade != null ? String(squad.ageGrade) : "");
    setCompetition(squad?.competition ?? "");
    setBand(((squad?.band as SquadBand) || bandForAgeGrade(squad?.ageGrade ?? null)) as SquadBand);
    setNotes(squad?.notes ?? "");
    setBandTouched(false);
  }, [open, squad, defaultSeason]);

  const handleAgeGradeChange = (v: string) => {
    setAgeGrade(v);
    if (!bandTouched) {
      const g = v === "" ? null : Number(v);
      setBand(bandForAgeGrade(g));
    }
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        seasonYear: Number(seasonYear),
        ageGrade: ageGrade === "" ? null : Number(ageGrade),
        competition: competition.trim() || null,
        band,
        notes: notes.trim() || null,
      };
      if (isEdit && squad) {
        return apiRequest("PATCH", `/api/admin/squads/${squad.id}`, payload);
      }
      return apiRequest("POST", "/api/admin/squads", payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      if (isEdit && squad) queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "detail", squad.id] });
      toast({ title: isEdit ? "Squad updated" : "Squad created" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden"
        style={{ background: "linear-gradient(135deg, hsl(214 60% 97%) 0%, hsl(var(--card)) 100%)" }}
        data-testid="modal-squad-form"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08]">
          <h3 className="text-[14px] font-semibold text-white/80">{isEdit ? "Edit Squad" : "New Squad"}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer"
            data-testid="button-close-squad-form"
          >
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Squad Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. First Team, U14 Boys"
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-squad-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Season Year</label>
              <Input
                type="number"
                value={seasonYear}
                onChange={(e) => setSeasonYear(e.target.value)}
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-squad-season"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Age Grade</label>
              <Input
                type="number"
                min={4}
                max={23}
                value={ageGrade}
                onChange={(e) => handleAgeGradeChange(e.target.value)}
                placeholder="Blank = Senior"
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-squad-age-grade"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Competition</label>
              <Input
                value={competition}
                onChange={(e) => setCompetition(e.target.value)}
                placeholder="e.g. NZ National League"
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-squad-competition"
              />
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Band</label>
              <Select
                value={band}
                onValueChange={(v) => {
                  setBand(v as SquadBand);
                  setBandTouched(true);
                }}
              >
                <SelectTrigger className="premium-input text-white/80 rounded-xl" data-testid="select-squad-band">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SQUAD_BANDS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {SQUAD_BAND_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Notes</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Internal notes..."
                className="bg-white/[0.03] border-white/[0.08] text-white/80 resize-none text-[13px]"
                data-testid="input-squad-notes"
              />
            </div>
          </div>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim() || !seasonYear}
            className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] glow-btn"
            data-testid="button-save-squad"
          >
            {mutation.isPending ? "Saving..." : isEdit ? "Save Changes" : "Create Squad"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Mark as left ──────────────────────────────────────────────────────────

function MarkLeftDialog({ squadId, member, onClose }: { squadId: number; member: Member; onClose: () => void }) {
  const { toast } = useToast();
  const [leftAt, setLeftAt] = useState(format(new Date(), "yyyy-MM-dd"));

  const mutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/squad-members/${member.id}`, { leftAt }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "detail", squadId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      toast({ title: "Marked as left" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm mx-4 rounded-2xl border border-amber-500/[0.2] overflow-hidden bg-[#0a0e1a]" data-testid="modal-mark-left">
        <div className="flex items-center justify-between px-5 py-4 border-b border-amber-500/[0.1]">
          <h3 className="text-[14px] font-semibold text-white/80 flex items-center gap-2">
            <LogOut className="w-4 h-4 text-amber-400" /> Mark as Left
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer"
            data-testid="button-close-mark-left"
          >
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-white/50">
            {member.firstName} {member.lastName} moves to Former Members. Their history on this squad stays on record.
          </p>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Left On</label>
            <DatePickerInput
              value={leftAt}
              onChange={(e) => setLeftAt(e.target.value)}
              className="premium-input text-white/80 rounded-xl"
              data-testid="input-left-at"
            />
          </div>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !leftAt}
            className="w-full bg-amber-500/90 hover:bg-amber-500 text-white border-0 rounded-xl h-10 text-[13px]"
            data-testid="button-confirm-mark-left"
          >
            {mutation.isPending ? "Saving..." : "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Remove (destructive, mistaken-entry only) ────────────────────────────────

function RemoveMemberDialog({ squadId, member, onClose }: { squadId: number; member: Member; onClose: () => void }) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/squad-members/${member.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "detail", squadId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "candidates", squadId] });
      toast({ title: "Removed" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <AlertDialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent className="bg-[#0a0e1a] border border-red-500/20 text-white/80 max-w-sm" data-testid="dialog-remove-member">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-white/90">
            <Trash2 className="w-5 h-5 text-red-400" /> Remove {member.firstName} {member.lastName}?
          </AlertDialogTitle>
          <AlertDialogDescription className="text-white/50">
            This deletes the entry entirely — no record stays. If they left the squad, use "Mark as left" instead so
            the roster keeps its history.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            className="bg-white/[0.04] border-white/10 text-white/70 hover:bg-white/[0.08] hover:text-white/90"
            data-testid="button-cancel-remove-member"
          >
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => { e.preventDefault(); mutation.mutate(); }}
            disabled={mutation.isPending}
            className="bg-red-500/90 hover:bg-red-500 text-white border-0"
            data-testid="button-confirm-remove-member"
          >
            {mutation.isPending ? "Removing..." : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Add person ────────────────────────────────────────────────────────────

function AddPersonDialog({ squadId, squad, onClose }: { squadId: number; squad: Squad; onClose: () => void }) {
  const { toast } = useToast();
  const [tab, setTab] = useState<"player" | "staff">("player");
  const [q, setQ] = useState("");
  const [pickedId, setPickedId] = useState<number | null>(null);
  const [role, setRole] = useState<SquadRole>("head_coach");
  const [squadNumber, setSquadNumber] = useState("");
  const [position, setPosition] = useState("");
  const [joinedAt, setJoinedAt] = useState(format(new Date(), "yyyy-MM-dd"));

  const { data: candidates, isLoading } = useQuery<Candidate[]>({
    queryKey: ["/api/admin/squads", "candidates", squadId, tab, q],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (tab === "staff") params.set("staff", "1");
      const res = await apiRequest("GET", `/api/admin/squads/${squadId}/candidates?${params.toString()}`);
      return res.json();
    },
  });

  const picked = candidates?.find((c) => c.id === pickedId) ?? null;

  const mutation = useMutation({
    mutationFn: () => {
      if (!pickedId) throw new Error("Pick a person first");
      const payload: Record<string, unknown> = {
        contactId: pickedId,
        role: tab === "player" ? "player" : role,
        joinedAt: joinedAt || null,
      };
      if (tab === "player") {
        payload.squadNumber = squadNumber ? Number(squadNumber) : null;
        payload.position = position || null;
      }
      return apiRequest("POST", `/api/admin/squads/${squadId}/members`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "detail", squadId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "candidates", squadId] });
      toast({ title: "Added to squad" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-lg mx-4 rounded-2xl border border-blue-500/[0.15] overflow-hidden bg-[#02060E] max-h-[85vh] flex flex-col"
        data-testid="modal-add-person"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-blue-500/[0.08] flex-shrink-0">
          <h3 className="text-[14px] font-semibold text-white/80 truncate">Add Person — {squad.name}</h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg bg-white/[0.04] border border-white/[0.06] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer flex-shrink-0"
            data-testid="button-close-add-person"
          >
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>

        <div className="px-5 pt-3 flex items-center gap-1 border-b border-white/5 flex-shrink-0">
          {(["player", "staff"] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setPickedId(null); }}
              className={`px-4 py-2 text-[13px] font-medium -mb-px border-b-2 transition-colors cursor-pointer ${
                tab === t ? "text-white border-blue-500" : "text-white/50 hover:text-white/80 border-transparent"
              }`}
              data-testid={`tab-add-${t}`}
            >
              {t === "player" ? "Player" : "Staff"}
            </button>
          ))}
        </div>

        <div className="p-5 space-y-3 overflow-y-auto flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/20" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name..."
              className="pl-10 premium-input text-white/80 rounded-xl h-9"
              data-testid="input-search-candidates"
            />
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] max-h-[240px] overflow-y-auto divide-y divide-white/[0.04]">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full rounded-lg bg-white/[0.04]" />)}
              </div>
            ) : !candidates || candidates.length === 0 ? (
              <div className="p-4 text-center text-[12px] text-white/30">
                {q
                  ? "No matches."
                  : tab === "player"
                  ? "No available players — everyone's already on this squad, or add them as a contact first."
                  : "No available staff contacts."}
              </div>
            ) : (
              candidates.map((c) => {
                const ineligible = c.eligibility && c.eligibility.eligible === false;
                const isPicked = pickedId === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setPickedId(isPicked ? null : c.id)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2.5 transition-colors cursor-pointer ${
                      isPicked ? "bg-blue-500/10" : "hover:bg-white/[0.03]"
                    }`}
                    data-testid={`candidate-${c.id}`}
                  >
                    <div className="w-7 h-7 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-[10px] text-blue-400 font-semibold">
                        {c.firstName[0]}
                        {c.lastName[0]}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] text-white/75 font-medium truncate">
                          {c.firstName} {c.lastName}
                        </span>
                        {c.eligibility?.grade != null && <span className="text-[11px] text-white/30">U{c.eligibility.grade}</span>}
                        {ineligible && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-amber-500/30 text-amber-400 bg-amber-500/10">
                            Over age
                          </Badge>
                        )}
                      </div>
                    </div>
                    {isPicked && <Check className="w-4 h-4 text-blue-400 flex-shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          {picked && (
            <div className="rounded-xl bg-blue-500/[0.04] border border-blue-500/15 p-4 space-y-3">
              {picked.eligibility && picked.eligibility.eligible === false && (
                <div className="flex items-start gap-2 text-[11px] text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-2.5 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span>{picked.eligibility.reason}</span>
                </div>
              )}
              {tab === "staff" ? (
                <div className="space-y-1.5">
                  <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Role</label>
                  <Select value={role} onValueChange={(v) => setRole(v as SquadRole)}>
                    <SelectTrigger className="premium-input text-white/80 rounded-xl" data-testid="select-add-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STAFF_ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {SQUAD_ROLE_LABELS[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Squad Number</label>
                    <Input
                      type="number"
                      min={1}
                      max={99}
                      value={squadNumber}
                      onChange={(e) => setSquadNumber(e.target.value)}
                      placeholder="Optional"
                      className="premium-input text-white/80 rounded-xl"
                      data-testid="input-add-squad-number"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Position</label>
                    <Select value={position || "none"} onValueChange={(v) => setPosition(v === "none" ? "" : v)}>
                      <SelectTrigger className="premium-input text-white/80 rounded-xl" data-testid="select-add-position">
                        <SelectValue placeholder="Optional" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">—</SelectItem>
                        {POSITIONS.map((p) => (
                          <SelectItem key={p} value={p}>
                            {POSITION_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Joined</label>
                <DatePickerInput
                  value={joinedAt}
                  onChange={(e) => setJoinedAt(e.target.value)}
                  className="premium-input text-white/80 rounded-xl"
                  data-testid="input-add-joined-at"
                />
              </div>
            </div>
          )}
        </div>

        <div className="p-5 pt-0 flex-shrink-0">
          <Button
            onClick={() => mutation.mutate()}
            disabled={!pickedId || mutation.isPending}
            className="w-full bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-10 text-[13px] glow-btn"
            data-testid="button-confirm-add-person"
          >
            {mutation.isPending ? "Adding..." : "Add to Squad"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Roster row ────────────────────────────────────────────────────────────

function MemberRow({
  member,
  isPlayer,
  onMarkLeft,
  onReinstate,
  onRemove,
  departed,
}: {
  member: Member;
  isPlayer: boolean;
  onMarkLeft?: () => void;
  onReinstate?: () => void;
  onRemove: () => void;
  departed?: boolean;
}) {
  const roleLabel = isSquadRole(member.role) ? SQUAD_ROLE_LABELS[member.role] : member.role;
  const ineligible = member.eligibility && member.eligibility.eligible === false;
  const playingUp =
    member.eligibility && member.eligibility.eligible && member.eligibility.reason.toLowerCase().startsWith("playing up");

  return (
    <div className="flex items-center gap-3 px-5 py-3 row-hover" data-testid={`row-member-${member.id}`}>
      {isPlayer && (
        <div className="w-8 h-8 rounded-lg bg-blue-500/8 border border-blue-500/15 flex items-center justify-center flex-shrink-0 text-[12px] font-semibold text-blue-400/70">
          {member.squadNumber ?? "—"}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[13px] font-medium ${departed ? "text-white/40 line-through" : "text-white/75"}`} data-testid={`text-member-name-${member.id}`}>
            {member.firstName} {member.lastName}
          </span>
          {!isPlayer && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-blue-500/20 text-blue-400/60 bg-blue-500/5">
              {roleLabel}
            </Badge>
          )}
          {isPlayer && member.position && (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-white/10 text-white/40 bg-white/[0.03]">
              {POSITION_LABELS[member.position as Position] ?? member.position}
            </Badge>
          )}
          {ineligible && !departed && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-4 border-amber-500/30 text-amber-400 bg-amber-500/10 flex items-center gap-1"
              data-testid={`badge-over-age-${member.id}`}
            >
              <AlertTriangle className="w-2.5 h-2.5" /> Over age
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-white/25 mt-0.5 flex-wrap">
          {member.eligibility?.grade != null && <span>U{member.eligibility.grade}</span>}
          {member.email && <span className="truncate">{member.email}</span>}
          {member.phone && <span>{member.phone}</span>}
          {member.joinedAt && !departed && <span>Joined {formatShortDate(member.joinedAt)}</span>}
          {departed && member.leftAt && <span className="text-white/30">Left {formatShortDate(member.leftAt)}</span>}
        </div>
        {ineligible && !departed && (
          <p className="text-[11px] text-amber-400/80 mt-1">{member.eligibility!.reason}</p>
        )}
        {playingUp && !departed && (
          <p className="text-[11px] text-blue-400/40 mt-1 flex items-center gap-1">
            <Info className="w-3 h-3" />
            {member.eligibility!.reason}
          </p>
        )}
      </div>
      {!departed ? (
        <div className="flex items-center gap-1 flex-shrink-0">
          {onMarkLeft && (
            <button
              onClick={onMarkLeft}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-amber-400 transition-colors cursor-pointer px-2 py-1 rounded-lg hover:bg-amber-500/10"
              data-testid={`button-mark-left-${member.id}`}
            >
              <LogOut className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Mark as left</span>
            </button>
          )}
          <button
            onClick={onRemove}
            className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer flex-shrink-0"
            data-testid={`button-remove-member-${member.id}`}
          >
            <Trash2 className="w-3.5 h-3.5 text-white/20 hover:text-red-400" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* A player who left in August can be re-signed in September. */}
          {onReinstate && (
            <button
              onClick={onReinstate}
              className="text-[10px] text-white/25 hover:text-emerald-400 transition-colors cursor-pointer min-h-[32px] px-1"
              data-testid={`button-reinstate-member-${member.id}`}
            >
              Reinstate
            </button>
          )}
          <button
            onClick={onRemove}
            className="text-[10px] text-white/15 hover:text-red-400/60 transition-colors cursor-pointer min-h-[32px] px-1"
            data-testid={`button-remove-member-${member.id}`}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

// ── Roster view ───────────────────────────────────────────────────────────

function SquadRoster({ squadId, onBack }: { squadId: number; onBack: () => void }) {
  const { toast } = useToast();
  const [showEdit, setShowEdit] = useState(false);
  const [showAddPerson, setShowAddPerson] = useState(false);
  const [showFormer, setShowFormer] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [markLeftMember, setMarkLeftMember] = useState<Member | null>(null);
  const [removeMember, setRemoveMember] = useState<Member | null>(null);

  const { data, isLoading } = useQuery<{ squad: Squad; members: Member[] }>({
    queryKey: ["/api/admin/squads", "detail", squadId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/squads/${squadId}`);
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/squads/${squadId}`),
    onSuccess: async (res) => {
      const result = await res.json().catch(() => ({}));
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      toast({ title: result.archived ? "Squad archived" : "Squad deleted", description: result.message });
      onBack();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Clearing leftAt puts a former member back on the roster. Their history —
  // squad number, join date, notes — is still on the same row.
  const reinstate = useMutation({
    mutationFn: (memberId: number) => apiRequest("PATCH", `/api/admin/squad-members/${memberId}`, { leftAt: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "detail", squadId] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/squads", "season"] });
      toast({ title: "Back in the squad" });
    },
    onError: (e: any) => toast({ title: "Couldn't reinstate", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !data) {
    return (
      <div className="p-4 sm:p-8 space-y-6 max-w-5xl mx-auto">
        <Skeleton className="h-6 w-24 rounded-lg bg-blue-500/[0.04]" />
        <div className="glass-card rounded-2xl p-6 space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full rounded-xl bg-blue-500/[0.04]" />)}
        </div>
      </div>
    );
  }

  const { squad, members } = data;
  const active = members.filter((m) => !m.leftAt);
  const former = members.filter((m) => m.leftAt);
  const players = active.filter((m) => m.role === "player").sort((a, b) => (a.squadNumber ?? 999) - (b.squadNumber ?? 999));
  const staff = active.filter((m) => m.role !== "player");

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-5xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-[12px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
        data-testid="button-back-to-squads"
      >
        <ChevronLeft className="w-4 h-4" /> Squads
      </button>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-semibold text-white tracking-tight truncate" data-testid="text-squad-name">
              {squad.name}
            </h1>
            {!squad.isActive && (
              <Badge variant="outline" className="text-[9px] border-white/10 text-white/30 bg-white/[0.03]">
                Archived
              </Badge>
            )}
          </div>
          <p className="text-blue-400/35 text-[13px] mt-1">
            {squad.ageGrade != null ? `U${squad.ageGrade}` : "Senior"}
            {squad.competition ? ` · ${squad.competition}` : ""}
            {` · ${squad.seasonYear}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            onClick={() => setShowAddPerson(true)}
            className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-9 text-[13px] font-medium glow-btn"
            data-testid="button-add-person"
          >
            <UserPlus className="w-4 h-4 mr-1.5" /> Add Person
          </Button>
          <Button
            onClick={() => setShowEdit(true)}
            variant="outline"
            className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10 rounded-xl h-9 w-9 p-0"
            data-testid="button-edit-squad"
          >
            <Pencil className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {squad.notes && <p className="text-[12px] text-white/30 italic">{squad.notes}</p>}

      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
          <Users className="w-4 h-4 text-blue-400/40" />
          <h2 className="text-[13px] font-semibold text-white/60">Players</h2>
          <Badge variant="outline" className="text-[9px] text-blue-400/50 border-blue-500/15 bg-blue-500/5 ml-auto no-default-hover-elevate no-default-active-elevate">
            {players.length}
          </Badge>
        </div>
        {players.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[12px] text-white/20">No players yet. Add one to get started.</p>
          </div>
        ) : (
          <div className="divide-y divide-blue-500/[0.04]">
            {players.map((m) => (
              <MemberRow key={m.id} member={m} isPlayer onMarkLeft={() => setMarkLeftMember(m)} onRemove={() => setRemoveMember(m)} />
            ))}
          </div>
        )}
      </div>

      <div className="glass-card rounded-2xl overflow-hidden">
        <div className="px-5 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
          <Users2 className="w-4 h-4 text-blue-400/40" />
          <h2 className="text-[13px] font-semibold text-white/60">Staff</h2>
          <Badge variant="outline" className="text-[9px] text-blue-400/50 border-blue-500/15 bg-blue-500/5 ml-auto no-default-hover-elevate no-default-active-elevate">
            {staff.length}
          </Badge>
        </div>
        {staff.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-[12px] text-white/20">No staff assigned yet.</p>
          </div>
        ) : (
          <div className="divide-y divide-blue-500/[0.04]">
            {staff.map((m) => (
              <MemberRow key={m.id} member={m} isPlayer={false} onMarkLeft={() => setMarkLeftMember(m)} onRemove={() => setRemoveMember(m)} />
            ))}
          </div>
        )}
      </div>

      {former.length > 0 && (
        <div className="glass-card rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowFormer((v) => !v)}
            className="w-full px-5 py-3 flex items-center gap-2 cursor-pointer"
            data-testid="button-toggle-former"
          >
            <Clock className="w-4 h-4 text-white/20" />
            <h2 className="text-[13px] font-semibold text-white/40">Former members</h2>
            <Badge variant="outline" className="text-[9px] text-white/30 border-white/10 bg-white/[0.03] ml-auto no-default-hover-elevate no-default-active-elevate">
              {former.length}
            </Badge>
            {showFormer ? <ChevronUp className="w-4 h-4 text-white/20" /> : <ChevronDown className="w-4 h-4 text-white/20" />}
          </button>
          {showFormer && (
            <div className="divide-y divide-white/[0.03] border-t border-white/[0.04] opacity-50">
              {former.map((m) => (
                <MemberRow key={m.id} member={m} isPlayer={m.role === "player"} onReinstate={() => reinstate.mutate(m.id)} onRemove={() => setRemoveMember(m)} departed />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end pt-1">
        {deleteConfirm ? (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <span className="text-[11px] text-red-400/70">
              {members.length > 0 ? "Archive this squad? Members stay on record." : "Delete this squad? This can't be undone."}
            </span>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirm(false)}
              className="rounded-xl h-7 text-[11px] border-white/10 text-white/50 hover:bg-white/5 px-3"
              data-testid="button-cancel-delete-squad"
            >
              Cancel
            </Button>
            <Button
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-xl h-7 text-[11px] bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 px-3"
              data-testid="button-confirm-delete-squad"
            >
              {deleteMutation.isPending ? "Working..." : members.length > 0 ? "Yes, Archive" : "Yes, Delete"}
            </Button>
          </div>
        ) : (
          <button
            onClick={() => setDeleteConfirm(true)}
            className="flex items-center gap-1 text-[11px] text-red-400/50 hover:text-red-400 transition-colors cursor-pointer"
            data-testid="button-delete-squad"
          >
            <Trash2 className="w-3 h-3" /> {members.length > 0 ? "Archive Squad" : "Delete Squad"}
          </button>
        )}
      </div>

      <SquadFormModal open={showEdit} onClose={() => setShowEdit(false)} squad={squad} defaultSeason={squad.seasonYear} />
      {showAddPerson && <AddPersonDialog squadId={squadId} squad={squad} onClose={() => setShowAddPerson(false)} />}
      {markLeftMember && <MarkLeftDialog squadId={squadId} member={markLeftMember} onClose={() => setMarkLeftMember(null)} />}
      {removeMember && <RemoveMemberDialog squadId={squadId} member={removeMember} onClose={() => setRemoveMember(null)} />}
    </div>
  );
}

// ── Squad list ────────────────────────────────────────────────────────────

const BAND_ICONS: Record<SquadBand, typeof Trophy> = {
  senior: Trophy,
  academy: GraduationCap,
  youth: Baby,
};

/**
 * Split a band's squads into one column per age grade.
 *
 * Pre-Academy reads U9 · U10 · U11 · U12 and Academy reads U13 · U14 · U15 · U17,
 * which is how the club's own team sheets are laid out. Returns null when columns
 * would be meaningless — the senior band has no grades to speak of, and a single
 * grade is just a list.
 *
 * Squads keep the order the server sent (display order), so within a grade the
 * teams stay in the club's own sequence. A squad with no grade in a graded band
 * still gets a home rather than vanishing.
 */
function gradeColumnsFor(band: SquadBand, list: Squad[]) {
  if (band === "senior") return null;
  const grades = Array.from(new Set(list.map((s) => s.ageGrade).filter((g): g is number => g != null))).sort((a, b) => a - b);
  const ungraded = list.filter((s) => s.ageGrade == null);
  if (grades.length < 2 && !ungraded.length) return null;
  const cols = grades.map((g) => {
    const squads = list.filter((s) => s.ageGrade === g);
    return { key: `u${g}`, label: `U${g}`, squads, players: squads.reduce((n, s) => n + s.players, 0) };
  });
  if (ungraded.length) {
    cols.push({ key: "ungraded", label: "No grade", squads: ungraded, players: ungraded.reduce((n, s) => n + s.players, 0) });
  }
  return cols;
}

function SquadCard({ sq, onOpen }: { sq: Squad; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left rounded-xl border p-4 transition-colors cursor-pointer ${
        sq.isActive
          ? "border-blue-500/10 bg-white/[0.02] hover:bg-blue-500/[0.05] hover:border-blue-500/20"
          : "border-white/[0.05] bg-white/[0.01] opacity-60"
      }`}
      data-testid={`card-squad-${sq.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-white/80 truncate">{sq.name}</p>
          <p className="text-[11px] text-white/30 mt-0.5 truncate">
            {sq.ageGrade != null ? `U${sq.ageGrade}` : "Senior"}
            {sq.competition ? ` · ${sq.competition}` : ""}
          </p>
        </div>
        {!sq.isActive && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-white/10 text-white/30 bg-white/[0.03] flex-shrink-0">
            Archived
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-3 mt-3">
        <span className="flex items-center gap-1 text-[12px] text-white/50">
          <Users className="w-3.5 h-3.5 text-blue-400/30" />
          {sq.players}
        </span>
        <span className="flex items-center gap-1 text-[12px] text-white/50">
          <Users2 className="w-3.5 h-3.5 text-blue-400/30" />
          {sq.staff}
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-white/15 ml-auto" />
      </div>
    </button>
  );
}

export default function AdminSquads() {
  const currentYear = new Date().getFullYear();
  const [season, setSeason] = useState(currentYear);
  const [seasonDefaulted, setSeasonDefaulted] = useState(false);
  const [selectedSquadId, setSelectedSquadId] = useState<number | null>(null);
  const [showNewSquad, setShowNewSquad] = useState(false);

  const { data, isLoading } = useQuery<{ seasons: number[]; squads: Squad[] }>({
    queryKey: ["/api/admin/squads", "season", season],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/admin/squads?season=${season}`);
      return res.json();
    },
  });

  // Default the season picker to the newest season the club has actually
  // fielded a squad in, once we know what that is. Only happens once.
  useEffect(() => {
    if (!seasonDefaulted && data?.seasons?.length) {
      setSeasonDefaulted(true);
      if (!data.seasons.includes(season)) setSeason(data.seasons[0]);
    }
  }, [data, seasonDefaulted, season]);

  if (selectedSquadId != null) {
    return <SquadRoster squadId={selectedSquadId} onBack={() => setSelectedSquadId(null)} />;
  }

  const seasons = data?.seasons?.length ? data.seasons : [currentYear];
  const squads = data?.squads ?? [];
  const byBand = (b: SquadBand) => squads.filter((s) => ((s.band as SquadBand) || "senior") === b);

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-fade-in-up" style={{ animationDelay: "0ms", opacity: 0 }}>
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Squads</h1>
          <p className="text-blue-400/35 text-[13px] mt-1">Christchurch United's own teams and who's in them</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(season)} onValueChange={(v) => setSeason(parseInt(v, 10))}>
            <SelectTrigger className="premium-input text-white/80 rounded-xl h-9 w-[100px]" data-testid="select-season">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {seasons.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => setShowNewSquad(true)}
            className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-400 hover:to-blue-500 text-white border-0 rounded-xl h-9 text-[13px] font-medium glow-btn"
            data-testid="button-new-squad"
          >
            <Plus className="w-4 h-4 mr-1.5" /> New Squad
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="glass-card rounded-2xl p-6 space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />)}
        </div>
      ) : squads.length === 0 ? (
        <div className="glass-card rounded-2xl flex flex-col items-center justify-center py-16 text-center">
          <Shield className="w-12 h-12 text-blue-400/10 mb-4" />
          <h3 className="text-[15px] font-medium text-white/40 mb-1">No squads for {season}</h3>
          <p className="text-[12px] text-white/20 mb-4">Add Christchurch United's first team for this season to get started.</p>
          <Button
            onClick={() => setShowNewSquad(true)}
            variant="outline"
            className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10 rounded-xl h-9 text-[13px]"
            data-testid="button-new-squad-empty"
          >
            <Plus className="w-4 h-4 mr-1.5" /> New Squad
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {SQUAD_BANDS.map((band) => {
            const list = byBand(band);
            if (list.length === 0) return null;
            const Icon = BAND_ICONS[band];
            const gradeColumns = gradeColumnsFor(band, list);
            return (
              <div key={band} className="glass-card rounded-2xl overflow-hidden animate-fade-in-up" style={{ animationDelay: "50ms", opacity: 0 }}>
                <div className="px-5 py-3 border-b border-blue-500/[0.08] flex items-center gap-2">
                  <Icon className="w-4 h-4 text-blue-400/40" />
                  <h2 className="text-[13px] font-semibold text-white/60">{SQUAD_BAND_LABELS[band]}</h2>
                  <Badge variant="outline" className="text-[9px] text-blue-400/50 border-blue-500/15 bg-blue-500/5 ml-auto no-default-hover-elevate no-default-active-elevate">
                    {list.length}
                  </Badge>
                </div>
                {gradeColumns ? (
                  // One column per age grade — U9 U10 U11 U12 for Pre-Academy,
                  // U13 U14 U15 U17 for Academy — with that grade's teams stacked
                  // beneath it. This is how the coaches read a team sheet, and it
                  // keeps the mixed sides (U9/10 Gold, U10/11 Gold) in the column
                  // of the older grade they play at.
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-3 gap-y-5 items-start">
                    {gradeColumns.map((col) => (
                      <div key={col.key} className="min-w-0 space-y-2.5">
                        <div className="flex items-baseline gap-2 px-1 pb-1 border-b border-blue-500/[0.08]">
                          <h3 className="text-[12px] font-semibold text-blue-300/60">{col.label}</h3>
                          <span className="text-[10px] text-white/25 truncate">
                            {col.squads.length} {col.squads.length === 1 ? "team" : "teams"} · {col.players} players
                          </span>
                        </div>
                        {col.squads.map((sq) => (
                          <SquadCard key={sq.id} sq={sq} onOpen={() => setSelectedSquadId(sq.id)} />
                        ))}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {list.map((sq) => (
                      <SquadCard key={sq.id} sq={sq} onOpen={() => setSelectedSquadId(sq.id)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SquadFormModal open={showNewSquad} onClose={() => setShowNewSquad(false)} defaultSeason={season} />
    </div>
  );
}

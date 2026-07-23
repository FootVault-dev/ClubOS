import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useRoute, Link } from "wouter";
import { useProgramRoute } from "@/lib/program-path";
import { ArrowLeft, UserCheck, UserX, AlertTriangle, Clock, Users, Phone, Mail, User, X, Search, Info } from "lucide-react";

type RollPlayer = {
  child: { id: number; firstName: string; lastName: string; dateOfBirth?: string | null; gender?: string | null; parentId: number; medical?: { allergies?: string | null; epiPen?: boolean; notes?: string | null } };
  parent: { id: number; firstName: string; lastName: string; email?: string | null; phone?: string | null } | null;
  attendance?: { id: number; checkedInAt?: string | null; checkedOutAt?: string | null; note?: string | null; status?: string | null; markedAt?: string | null };
  productType: string;
};

function hasRealAllergies(allergies: string | null | undefined): boolean {
  if (!allergies) return false;
  const cleaned = allergies.trim().toLowerCase();
  return cleaned !== "" && cleaned !== "none" && cleaned !== "n/a" && cleaned !== "nil" && cleaned !== "no" && cleaned !== "-" && cleaned !== "na";
}

function formatAge(dob: string | null | undefined): string {
  if (!dob) return "—";
  const birth = new Date(dob + "T00:00:00");
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return `${age}y`;
}

function formatTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleTimeString("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true });
}

function PlayerProfileModal({ player, onClose }: { player: RollPlayer; onClose: () => void }) {
  const hasMedical = hasRealAllergies(player.child.medical?.allergies) || player.child.medical?.epiPen;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative rounded-2xl border border-blue-500/[0.12] p-6 max-w-sm w-full space-y-5"
        style={{ background: '#0a0f1a' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-[15px] font-bold text-white/90">Player Profile</h3>
          <button onClick={onClose} className="w-7 h-7 rounded-lg bg-white/[0.05] flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer" data-testid="button-close-modal">
            <X className="w-3.5 h-3.5 text-white/40" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-blue-500/10 border border-blue-500/15 flex items-center justify-center">
            <span className="text-[14px] font-bold text-blue-400/70">
              {player.child.firstName[0]}{player.child.lastName[0]}
            </span>
          </div>
          <div>
            <p className="text-[15px] font-semibold text-white/85">{player.child.firstName} {player.child.lastName}</p>
            <p className="text-[12px] text-white/35">{formatAge(player.child.dateOfBirth)} old</p>
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center gap-2.5 text-[12px]">
            <User className="w-3.5 h-3.5 text-white/25" />
            <span className="text-white/50">Parent:</span>
            <span className="text-white/70 font-medium">
              {player.parent ? `${player.parent.firstName} ${player.parent.lastName}` : "Not on file"}
            </span>
          </div>
          {player.parent?.email && (
            <div className="flex items-center gap-2.5 text-[12px]">
              <Mail className="w-3.5 h-3.5 text-white/25" />
              <a href={`mailto:${player.parent.email}`} className="text-blue-400/70 hover:text-blue-400 transition-colors">{player.parent.email}</a>
            </div>
          )}
          {player.parent?.phone && (
            <div className="flex items-center gap-2.5 text-[12px]">
              <Phone className="w-3.5 h-3.5 text-white/25" />
              {/* Tap-to-call: the coach is holding a phone on a field. */}
              <a href={`tel:${player.parent.phone}`} className="text-blue-400/70 hover:text-blue-400 transition-colors">{player.parent.phone}</a>
            </div>
          )}
        </div>

        {hasMedical ? (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70" />
              <span className="text-[11px] text-amber-400/80 font-semibold uppercase tracking-wider">Medical Alert</span>
            </div>
            {hasRealAllergies(player.child.medical?.allergies) && (
              <p className="text-[12px] text-amber-300/60">Allergies: {player.child.medical!.allergies}</p>
            )}
            {player.child.medical?.epiPen && (
              <p className="text-[12px] text-red-400/70 font-medium">⚠ Carries EpiPen</p>
            )}
            {player.child.medical?.notes && (
              <p className="text-[12px] text-amber-300/50">{player.child.medical.notes}</p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 space-y-1">
            <span className="text-[11px] text-white/25 font-semibold uppercase tracking-wider">Allergies</span>
            <p className="text-[12px] text-white/40">None</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminSessionRoll() {
  // Matched under whichever section the programme lives in (camps / academy /
  // programs) so back goes where the user came from.
  const route = useProgramRoute("/session/:dateId/:sessionType");
  const campId = route?.id || 0;
  const detailPath = `${route?.base ?? "/admin/camps"}/${campId}`;
  const dateId = parseInt(route?.params.dateId || "0");
  const sessionType = route?.params.sessionType || "MORNING";
  const { toast } = useToast();
  const [selectedPlayer, setSelectedPlayer] = useState<RollPlayer | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: camp } = useQuery<any>({
    queryKey: ["/api/admin/camps", campId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Camp not found");
      return res.json();
    },
    enabled: campId > 0,
  });

  const { data: roll, isLoading } = useQuery<RollPlayer[]>({
    queryKey: ["/api/admin/camps", campId, "session-roll", dateId, sessionType],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/session-roll?campDateId=${dateId}&sessionType=${sessionType}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load roll");
      return res.json();
    },
    enabled: campId > 0 && dateId > 0,
  });

  const { data: sessions } = useQuery<any[]>({
    queryKey: ["/api/admin/camps", campId, "sessions-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/camps/${campId}/sessions-summary`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: campId > 0,
  });

  const sessionInfo = sessions?.find((s: any) => s.campDateId === dateId && s.productType === sessionType);

  // Term programmes (academy) take a plain roll: present or absent, no
  // sign-out. A holiday camp signs a child OUT to a named adult because the
  // club holds them all day; a 45-minute academy session just ends.
  const isTermRoll = camp?.scheduleType === "term";

  const checkInMutation = useMutation({
    mutationFn: async ({ attendanceId, action }: { attendanceId: number; action: "in" | "out" }) => {
      const body = action === "in"
        ? { checkedInAt: new Date().toISOString() }
        : { checkedOutAt: new Date().toISOString() };
      await apiRequest("PATCH", `/api/admin/attendance/${attendanceId}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/camps", campId, "session-roll", dateId, sessionType] });
      toast({ title: "Attendance updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // Tapping the state a player is already in clears it back to "not marked",
  // so a mis-tap is recoverable without a coach inventing a state.
  const rollKey = ["/api/admin/camps", campId, "session-roll", dateId, sessionType];

  // Optimistic: a coach ticks 30 children off in a few seconds as they run
  // onto the field, so the row must light up on the tap, not a round-trip
  // later. Nothing is disabled while a save is in flight either — a global
  // `isPending` lock would swallow every tap after the first.
  const markMutation = useMutation({
    mutationFn: async ({ attendanceId, status }: { attendanceId: number; status: "present" | "absent" | null }) => {
      await apiRequest("PATCH", `/api/admin/attendance/${attendanceId}`, { status });
    },
    onMutate: async ({ attendanceId, status }) => {
      await queryClient.cancelQueries({ queryKey: rollKey });
      const previous = queryClient.getQueryData<RollPlayer[]>(rollKey);
      queryClient.setQueryData<RollPlayer[]>(rollKey, old =>
        (old ?? []).map(p =>
          p.attendance?.id === attendanceId
            ? { ...p, attendance: { ...p.attendance, status, markedAt: status ? new Date().toISOString() : null } }
            : p,
        ),
      );
      return { previous };
    },
    onError: (e: Error, _vars, context: any) => {
      // Put the roll back exactly as it was — a tap that silently didn't save
      // would leave a child recorded as absent when they were standing there.
      if (context?.previous) queryClient.setQueryData(rollKey, context.previous);
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: rollKey });
    },
  });

  const sessionDate = sessionInfo?.date;
  const dateLabel = sessionDate
    ? new Date(sessionDate + "T12:00:00").toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" })
    : "";
  const timeLabel = sessionInfo?.startTime
    ? `${String(sessionInfo.startTime).slice(0, 5)}–${String(sessionInfo.endTime ?? "").slice(0, 5)}`
    : "";
  const sessionLabel = isTermRoll
    ? (sessionInfo?.name || "Session")
    : sessionType === "MORNING" ? "Morning" : "Afternoon";

  const sortedRoll = (roll || []).slice().sort((a, b) => {
    const firstCmp = a.child.firstName.localeCompare(b.child.firstName);
    if (firstCmp !== 0) return firstCmp;
    return a.child.lastName.localeCompare(b.child.lastName);
  });

  const filteredRoll = searchQuery.trim()
    ? sortedRoll.filter(p => {
        const q = searchQuery.toLowerCase();
        const fullName = `${p.child.firstName} ${p.child.lastName}`.toLowerCase();
        return fullName.includes(q);
      })
    : sortedRoll;

  const signedInCount = roll?.filter(p => p.attendance?.checkedInAt).length || 0;
  const signedOutCount = roll?.filter(p => p.attendance?.checkedOutAt).length || 0;
  const totalPlayers = roll?.length || 0;
  // Daniel's model (2026-07-23): children pick which days they come, so the
  // roll is a one-tap list — tapped = here, everything left untapped is taken
  // as not here. There is no separate "absent" tap and no unmarked state to
  // chase, because on a 45-minute session the coach only ever ticks arrivals.
  const presentCount = roll?.filter(p => p.attendance?.status === "present").length || 0;
  const absentCount = totalPlayers - presentCount;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={detailPath}>
          <button className="w-8 h-8 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer" data-testid="link-back-to-camp">
            <ArrowLeft className="w-4 h-4 text-white/40" />
          </button>
        </Link>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-white/90 tracking-tight" data-testid="text-session-title">
            {isTermRoll ? sessionLabel : `${sessionLabel} Session`}
          </h1>
          <p className="text-[13px] text-white/35 mt-0.5">
            {dateLabel}{timeLabel ? ` · ${timeLabel}` : ""}{camp ? ` · ${camp.name}` : ""}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-blue-500/[0.08] bg-blue-500/[0.03] p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Users className="w-3.5 h-3.5 text-blue-400/40" />
            <span className="text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">{isTermRoll ? "On roll" : "Players"}</span>
          </div>
          <span className="text-2xl font-bold text-white/85" data-testid="text-total-players">{totalPlayers}</span>
        </div>
        <div className="rounded-xl border border-emerald-500/[0.12] bg-emerald-500/[0.03] p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <UserCheck className="w-3.5 h-3.5 text-emerald-400/40" />
            <span className="text-[10px] text-emerald-300/30 uppercase tracking-wider font-semibold">{isTermRoll ? "Here" : "Signed In"}</span>
          </div>
          <span className="text-2xl font-bold text-emerald-400/80" data-testid="text-signed-in">{isTermRoll ? presentCount : signedInCount}</span>
        </div>
        {isTermRoll ? (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <UserX className="w-3.5 h-3.5 text-white/25" />
              <span className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Not here</span>
            </div>
            <span className="text-2xl font-bold text-white/45" data-testid="text-absent">{absentCount}</span>
          </div>
        ) : (
          <div className="rounded-xl border border-blue-500/[0.12] bg-blue-500/[0.03] p-4">
            <div className="flex items-center gap-2 mb-1.5">
              <UserX className="w-3.5 h-3.5 text-blue-400/40" />
              <span className="text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">Signed Out</span>
            </div>
            <span className="text-2xl font-bold text-blue-400/80" data-testid="text-signed-out">{signedOutCount}</span>
          </div>
        )}
      </div>

      {isTermRoll && totalPlayers > 0 && (
        <p className="text-[12px] text-white/30 -mt-2" data-testid="text-unmarked">
          Tap each player who's here. Anyone left untapped counts as not here.
        </p>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />
          <Skeleton className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />
          <Skeleton className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />
        </div>
      ) : !roll || roll.length === 0 ? (
        <div className="rounded-xl border border-blue-500/[0.08] bg-blue-500/[0.02] p-8 text-center">
          <Users className="w-8 h-8 text-white/15 mx-auto mb-3" />
          <p className="text-[13px] text-white/25">No players registered for this session</p>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Sticky on a term roll: with ~58 names the coach is scrolled well
              down the list when the next child arrives, and a search box that
              has scrolled off the top is no use to them. */}
          <div className={isTermRoll ? "sticky top-0 z-30 -mx-1 px-1 py-2 backdrop-blur-md" : ""}
               style={isTermRoll ? { background: "rgba(6,10,18,0.88)" } : undefined}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/25" />
              <input
                type="text"
                inputMode="search"
                autoComplete="off"
                placeholder={isTermRoll ? "Search for a player…" : "Search players..."}
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className={`w-full pl-10 pr-10 rounded-xl border border-blue-500/[0.1] bg-blue-500/[0.03] text-white/80 placeholder-white/25 outline-none focus:border-blue-500/25 transition-colors ${
                  isTermRoll ? "py-3 text-[16px]" : "py-2.5 text-[13px]"
                }`}
                /* 16px on the term roll: iOS Safari zooms the whole page in
                   when a focused input's text is smaller than that. */
                data-testid="input-search-players"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center hover:bg-white/10 transition-colors cursor-pointer"
                  data-testid="button-clear-search"
                >
                  <X className="w-3.5 h-3.5 text-white/40" />
                </button>
              )}
            </div>
            {isTermRoll && searchQuery && (
              <p className="text-[11px] text-white/30 mt-1.5 px-1">
                {filteredRoll.length} of {totalPlayers} player{totalPlayers === 1 ? "" : "s"}
              </p>
            )}
          </div>
          {filteredRoll.length === 0 ? (
            <div className="rounded-xl border border-blue-500/[0.08] bg-blue-500/[0.02] p-6 text-center">
              <Search className="w-6 h-6 text-white/15 mx-auto mb-2" />
              <p className="text-[13px] text-white/25">No players match "{searchQuery}"</p>
            </div>
          ) : (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="overflow-x-auto">
            {/* A term roll must NOT force a min-width: the 500px floor pushed
                the Present/Absent buttons off the right of a 390px phone
                behind a horizontal scroll, so a coach standing on the field
                could read the roll but not actually take it. */}
            <table className={`w-full ${isTermRoll ? "" : "min-w-[500px]"}`} data-testid="table-session-roll">
              <thead>
                <tr className="border-b border-blue-500/[0.06] bg-blue-500/[0.03]">
                  <th className="text-left px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">Player</th>
                  <th className="text-left px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold hidden sm:table-cell">Age</th>
                  {/* The row's own highlight is the status on a term roll, so
                      the badge column stands down on a phone to leave room. */}
                  <th className={`text-center px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold ${isTermRoll ? "hidden sm:table-cell" : ""}`}>Status</th>
                  {isTermRoll ? (
                    <th className="text-center px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold hidden sm:table-cell">Marked</th>
                  ) : (
                    <>
                      <th className="text-center px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">Sign In</th>
                      <th className="text-center px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">Sign Out</th>
                    </>
                  )}
                  <th className="text-right px-4 py-3 text-[10px] text-blue-300/30 uppercase tracking-wider font-semibold">{isTermRoll ? "Roll" : "Actions"}</th>
                </tr>
              </thead>
              <tbody>
                {filteredRoll.map((player) => {
                  const isIn = !!player.attendance?.checkedInAt;
                  const isOut = !!player.attendance?.checkedOutAt;
                  const hasMedical = hasRealAllergies(player.child.medical?.allergies) || player.child.medical?.epiPen;
                  const mark = player.attendance?.status ?? null;

                  const here = mark === "present";
                  // One tap anywhere on the row marks a player here (and taps
                  // again to undo) — with 58 names arriving at once, hunting a
                  // small button is the slow part. The profile moved to its own
                  // control so a mis-tap can't open a sheet mid-roll.
                  const toggleHere = () => {
                    if (!isTermRoll || !player.attendance) return;
                    markMutation.mutate({ attendanceId: player.attendance.id, status: here ? null : "present" });
                  };

                  return (
                    <tr
                      key={player.child.id}
                      onClick={isTermRoll ? toggleHere : undefined}
                      role={isTermRoll ? "button" : undefined}
                      aria-pressed={isTermRoll ? here : undefined}
                      className={`border-b border-blue-500/[0.04] transition-colors ${
                        isTermRoll
                          ? `cursor-pointer select-none ${here ? "bg-emerald-500/[0.10] hover:bg-emerald-500/[0.14]" : "hover:bg-white/[0.04]"}`
                          : "hover:bg-blue-500/[0.04]"
                      }`}
                      data-testid={`row-player-${player.child.id}`}
                    >
                      <td className="px-4 py-3">
                        {/* On a term roll the name is NOT a separate target —
                            the click bubbles up and marks them here. The
                            profile lives on its own button in the Roll cell. */}
                        <button
                          onClick={isTermRoll ? undefined : () => setSelectedPlayer(player)}
                          className={`flex items-center gap-3 text-left transition-opacity ${isTermRoll ? "cursor-pointer" : "cursor-pointer hover:opacity-80"}`}
                          tabIndex={isTermRoll ? -1 : 0}
                          data-testid={`button-player-profile-${player.child.id}`}
                        >
                          <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
                            <span className="text-[11px] font-semibold text-blue-400/60">
                              {player.child.firstName[0]}{player.child.lastName[0]}
                            </span>
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[13px] font-medium text-white/80 truncate">{player.child.firstName} {player.child.lastName}</p>
                              {hasMedical && (
                                <AlertTriangle className="w-3 h-3 text-amber-400/60 flex-shrink-0" aria-label="Has medical info" />
                              )}
                            </div>
                            <p className="text-[11px] text-white/30 truncate">
                              {player.parent ? `${player.parent.firstName} ${player.parent.lastName}` : "—"}
                            </p>
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className="text-[12px] text-white/45">{formatAge(player.child.dateOfBirth)}</span>
                      </td>
                      <td className={`px-4 py-3 text-center ${isTermRoll ? "hidden sm:table-cell" : ""}`}>
                        {isTermRoll ? (
                          here ? (
                            <Badge variant="outline" className="text-[9px] text-emerald-400/80 border-emerald-500/20 bg-emerald-500/10 uppercase tracking-wider" data-testid={`badge-status-${player.child.id}`}>Here</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] text-white/25 border-white/10 bg-white/[0.02] uppercase tracking-wider" data-testid={`badge-status-${player.child.id}`}>Not here</Badge>
                          )
                        ) : isOut ? (
                          <Badge variant="outline" className="text-[9px] text-blue-400/70 border-blue-500/20 bg-blue-500/10 uppercase tracking-wider" data-testid={`badge-status-${player.child.id}`}>Signed Out</Badge>
                        ) : isIn ? (
                          <Badge variant="outline" className="text-[9px] text-emerald-400/80 border-emerald-500/20 bg-emerald-500/10 uppercase tracking-wider" data-testid={`badge-status-${player.child.id}`}>Signed In</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[9px] text-white/30 border-white/10 bg-white/[0.03] uppercase tracking-wider" data-testid={`badge-status-${player.child.id}`}>Not Arrived</Badge>
                        )}
                      </td>
                      {isTermRoll ? (
                        <td className="px-4 py-3 text-center hidden sm:table-cell">
                          {player.attendance?.markedAt ? (
                            <div className="flex items-center justify-center gap-1">
                              <Clock className="w-3 h-3 text-white/25" />
                              <span className="text-[12px] text-white/45 font-medium" data-testid={`text-marked-time-${player.child.id}`}>
                                {formatTime(player.attendance.markedAt)}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-white/15">—</span>
                          )}
                        </td>
                      ) : (
                        <>
                          <td className="px-4 py-3 text-center">
                            {isIn ? (
                              <div className="flex items-center justify-center gap-1">
                                <Clock className="w-3 h-3 text-emerald-400/50" />
                                <span className="text-[12px] text-emerald-400/70 font-medium" data-testid={`text-signin-time-${player.child.id}`}>
                                  {formatTime(player.attendance?.checkedInAt)}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-white/15">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {isOut ? (
                              <div className="flex items-center justify-center gap-1">
                                <Clock className="w-3 h-3 text-blue-400/50" />
                                <span className="text-[12px] text-blue-400/70 font-medium" data-testid={`text-signout-time-${player.child.id}`}>
                                  {formatTime(player.attendance?.checkedOutAt)}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[11px] text-white/15">—</span>
                            )}
                          </td>
                        </>
                      )}
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {isTermRoll && player.attendance && (
                            <>
                              {/* Profile is its own small control so it can't
                                  be hit by accident while ticking the roll. */}
                              <button
                                onClick={e => { e.stopPropagation(); setSelectedPlayer(player); }}
                                aria-label={`Details for ${player.child.firstName} ${player.child.lastName}`}
                                className="min-h-[44px] min-w-[36px] rounded-lg text-white/25 hover:text-white/60 hover:bg-white/[0.05] transition-colors cursor-pointer"
                                data-testid={`button-details-${player.child.id}`}
                              >
                                <Info className="w-4 h-4 inline-block" />
                              </button>
                              {/* One tap = here, tap again to undo. The whole
                                  row does this too; the button is the obvious
                                  affordance and the 44px target. */}
                              <button
                                onClick={e => { e.stopPropagation(); toggleHere(); }}
                                aria-pressed={here}
                                className={`min-h-[44px] min-w-[64px] px-3 sm:px-4 rounded-lg border text-[12px] font-semibold transition-colors cursor-pointer ${
                                  here
                                    ? "bg-emerald-500/30 border-emerald-400/60 text-emerald-100"
                                    : "bg-white/[0.03] border-white/10 text-white/40 hover:bg-emerald-500/10 hover:border-emerald-500/25 hover:text-emerald-300/70"
                                }`}
                                data-testid={`button-present-${player.child.id}`}
                              >
                                <UserCheck className="w-4 h-4 inline-block mr-1.5" />
                                {here ? "Here" : "Mark"}
                              </button>
                            </>
                          )}
                          {!isTermRoll && !isIn && player.attendance && (
                            <button
                              onClick={() => checkInMutation.mutate({ attendanceId: player.attendance!.id, action: "in" })}
                              disabled={checkInMutation.isPending}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-400/80 font-medium hover:bg-emerald-500/20 transition-colors cursor-pointer"
                              data-testid={`button-signin-${player.child.id}`}
                            >
                              <UserCheck className="w-3.5 h-3.5" /> Sign In
                            </button>
                          )}
                          {!isTermRoll && isIn && !isOut && player.attendance && (
                            <button
                              onClick={() => checkInMutation.mutate({ attendanceId: player.attendance!.id, action: "out" })}
                              disabled={checkInMutation.isPending}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-[11px] text-blue-400/80 font-medium hover:bg-blue-500/20 transition-colors cursor-pointer"
                              data-testid={`button-signout-${player.child.id}`}
                            >
                              <UserX className="w-3.5 h-3.5" /> Sign Out
                            </button>
                          )}
                          {!isTermRoll && isOut && (
                            <span className="text-[10px] text-white/20 italic">Complete</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
          )}
      </div>
      )}

      {selectedPlayer && <PlayerProfileModal player={selectedPlayer} onClose={() => setSelectedPlayer(null)} />}
    </div>
  );
}

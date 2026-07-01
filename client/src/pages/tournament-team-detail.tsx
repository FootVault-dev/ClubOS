import { Fragment, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Users, UserCog, Plus, Trash2, X, FileText, Upload, Image as ImageIcon, ShieldCheck, ShieldAlert, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TournamentTeam, TournamentPlayer, TournamentStaff, Club, Tournament } from "@shared/schema";

// Swap a /objects/uploads/<id>.webp URL for its .avif sibling. <picture>
// renders the AVIF source preferentially when supported.
function avifSiblingFor(webpUrl: string): string | null {
  return /\.webp(\?|$)/i.test(webpUrl) ? webpUrl.replace(/\.webp(\?|$)/i, ".avif$1") : null;
}

function TeamLogo({ team, size = 40 }: { team: TournamentTeam; size?: number }) {
  if (team.logoUrl) {
    const avif = avifSiblingFor(team.logoUrl);
    return (
      <picture>
        {avif && <source srcSet={avif} type="image/avif" />}
        <img
          src={team.logoUrl}
          alt={`${team.name} logo`}
          width={size}
          height={size}
          className="rounded-xl object-cover bg-white/[0.03]"
          style={{ width: size, height: size }}
        />
      </picture>
    );
  }
  return (
    <div
      className="rounded-xl flex items-center justify-center font-bold text-white/70"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: team.primaryColor ? `${team.primaryColor}30` : "rgba(255,255,255,0.05)",
      }}
    >
      {team.name.charAt(0)}
    </div>
  );
}

function TeamLogoUploader({ team }: { team: TournamentTeam }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/admin/tournament/teams/${team.id}/logo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.message || `Upload failed (${res.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", team.id] });
      toast({ title: "Logo updated" });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiRequest("DELETE", `/api/admin/tournament/teams/${team.id}/logo`);
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", team.id] });
      toast({ title: "Logo removed" });
    } catch (e: any) {
      toast({ title: "Couldn't remove logo", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = "";
        }}
        data-testid="input-team-logo"
      />
      <Button
        size="sm"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="text-xs"
        data-testid="button-upload-team-logo"
      >
        {busy ? <span>Uploading…</span> : (
          <>
            <Upload className="w-3 h-3 mr-1" />
            {team.logoUrl ? "Replace logo" : "Upload logo"}
          </>
        )}
      </Button>
      {team.logoUrl && !busy && (
        <Button
          size="sm"
          variant="ghost"
          onClick={remove}
          className="text-xs text-white/30 hover:text-red-400"
          data-testid="button-remove-team-logo"
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      )}
    </div>
  );
}

type Tab = "players" | "staff";

function AgeDocCell({ player }: { player: TournamentPlayer }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File, docType: "passport" | "birth_certificate" | "other") => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("documentType", docType);
      const r = await fetch(`/api/admin/tournament/players/${player.id}/age-document`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || `Upload failed (${r.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", player.teamId, "players"] });
      toast({ title: "Document uploaded — needs verification" });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const verifyMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/tournament/players/${player.id}/verify-age`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", player.teamId, "players"] });
      toast({ title: "Age verified" });
    },
    onError: (e: any) => toast({ title: "Couldn't verify", description: e.message, variant: "destructive" }),
  });
  const unverifyMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/tournament/players/${player.id}/unverify-age`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", player.teamId, "players"] });
      toast({ title: "Verification removed" });
    },
  });

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (!f) return;
          // Quick prompt for doc type. Could be a fancier modal — kept inline for speed.
          const t = window.prompt("Document type? Type: passport / birth_certificate / other", "passport");
          if (!t) { e.target.value = ""; return; }
          const docType = (t.toLowerCase().includes("birth") ? "birth_certificate"
            : t.toLowerCase().includes("pass") ? "passport"
            : "other") as "passport" | "birth_certificate" | "other";
          upload(f, docType);
          e.target.value = "";
        }}
      />
      {player.idDocumentUrl ? (
        <>
          <a
            href={player.idDocumentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-blue-400/70 hover:text-blue-400"
            title={player.idDocumentType || "Document"}
          >
            <FileText className="w-3 h-3" />
            {player.idDocumentType?.replace("_", " ") || "doc"}
          </a>
          {player.ageVerified ? (
            <button
              onClick={() => unverifyMut.mutate()}
              disabled={unverifyMut.isPending}
              className="flex items-center gap-1 text-[10px] text-green-400 hover:text-green-300 px-1.5 py-0.5 rounded bg-green-500/10"
              title="Verified — click to unverify"
            >
              <ShieldCheck className="w-3 h-3" /> Verified
            </button>
          ) : (
            <button
              onClick={() => verifyMut.mutate()}
              disabled={verifyMut.isPending}
              className="flex items-center gap-1 text-[10px] text-yellow-400 hover:text-yellow-300 px-1.5 py-0.5 rounded bg-yellow-500/10"
              title="Document on file — click to verify age"
            >
              <ShieldAlert className="w-3 h-3" /> Verify
            </button>
          )}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="text-[10px] text-white/30 hover:text-white/60 px-1.5 py-0.5"
            title="Replace document"
          >
            <Upload className="w-3 h-3" />
          </button>
        </>
      ) : (
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 px-1.5 py-0.5 rounded border border-dashed border-white/10"
        >
          {busy ? "Uploading…" : <><Upload className="w-3 h-3" /> Upload</>}
        </button>
      )}
    </div>
  );
}

function PlayersTab({ teamId }: { teamId: number }) {
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", shirtNumber: "", dateOfBirth: "" });

  const { data: players = [], isLoading } = useQuery<TournamentPlayer[]>({
    queryKey: ["/api/admin/tournament/teams", teamId, "players"],
    queryFn: () => fetch(`/api/admin/tournament/teams/${teamId}/players`).then(r => r.json()),
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/players", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", teamId, "players"] });
      toast({ title: "Player added" });
      setShowModal(false);
      setForm({ firstName: "", lastName: "", shirtNumber: "", dateOfBirth: "" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/players/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", teamId, "players"] });
      toast({ title: "Player removed" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/40">{players.length} player{players.length !== 1 ? "s" : ""}</p>
        <Button onClick={() => setShowModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-add-player">
          <Plus className="w-4 h-4" />Add Player
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-12 rounded-xl bg-white/[0.02] animate-pulse" />)}</div>
      ) : players.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-10 text-center">
          <Users className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <p className="text-sm text-white/30">No players registered</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 w-12">#</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Name</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">DOB</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">ID Doc</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr key={p.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]" data-testid={`player-row-${p.id}`}>
                  <td className="px-5 py-2.5">
                    <span className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-xs font-bold text-blue-400/70">
                      {p.shirtNumber || "—"}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-sm text-white/80">{p.firstName} {p.lastName}</td>
                  <td className="px-5 py-2.5 text-xs text-white/40 hidden sm:table-cell">
                    {p.dateOfBirth ? new Date(p.dateOfBirth + "T12:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                  </td>
                  <td className="px-5 py-2.5 hidden sm:table-cell">
                    <AgeDocCell player={p} />
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => deleteMut.mutate(p.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/15 hover:text-red-400"
                      data-testid={`button-delete-player-${p.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-white/5">
              <h2 className="text-lg font-semibold text-white">Add Player</h2>
              <button onClick={() => setShowModal(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">First Name</label>
                  <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="premium-input text-white" data-testid="input-player-first-name" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Last Name</label>
                  <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="premium-input text-white" data-testid="input-player-last-name" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Shirt Number</label>
                  <Input type="number" value={form.shirtNumber} onChange={e => setForm(f => ({ ...f, shirtNumber: e.target.value }))} className="premium-input text-white" data-testid="input-player-shirt" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Date of Birth</label>
                  <DatePickerInput value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))} className="premium-input text-white" />
                </div>
              </div>
            </div>
            <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowModal(false)} className="text-white/40">Cancel</Button>
              <Button
                onClick={() => createMut.mutate({
                  teamId,
                  firstName: form.firstName,
                  lastName: form.lastName,
                  shirtNumber: form.shirtNumber ? parseInt(form.shirtNumber) : null,
                  dateOfBirth: form.dateOfBirth || null,
                })}
                disabled={!form.firstName || !form.lastName || createMut.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="button-save-player"
              >
                Add Player
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StaffTab({ teamId }: { teamId: number }) {
  const { toast } = useToast();
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", role: "Manager", email: "", phone: "" });

  const { data: staff = [], isLoading } = useQuery<TournamentStaff[]>({
    queryKey: ["/api/admin/tournament/teams", teamId, "staff"],
    queryFn: () => fetch(`/api/admin/tournament/teams/${teamId}/staff`).then(r => r.json()),
  });

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/tournament/staff", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", teamId, "staff"] });
      toast({ title: "Staff member added" });
      setShowModal(false);
      setForm({ firstName: "", lastName: "", role: "Manager", email: "", phone: "" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/tournament/staff/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", teamId, "staff"] });
      toast({ title: "Staff member removed" });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/40">{staff.length} staff member{staff.length !== 1 ? "s" : ""}</p>
        <Button onClick={() => setShowModal(true)} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-add-staff">
          <Plus className="w-4 h-4" />Add Staff
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-12 rounded-xl bg-white/[0.02] animate-pulse" />)}</div>
      ) : staff.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-10 text-center">
          <UserCog className="w-10 h-10 text-white/10 mx-auto mb-3" />
          <p className="text-sm text-white/30">No staff registered</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Name</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5">Role</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">Email</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-2.5 hidden sm:table-cell">Phone</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {staff.map(s => (
                <tr key={s.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]" data-testid={`staff-row-${s.id}`}>
                  <td className="px-5 py-2.5 text-sm text-white/80">{s.firstName} {s.lastName}</td>
                  <td className="px-5 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/50">{s.role}</span>
                  </td>
                  <td className="px-5 py-2.5 text-xs text-white/40 hidden sm:table-cell">{s.email || "—"}</td>
                  <td className="px-5 py-2.5 text-xs text-white/40 hidden sm:table-cell">{s.phone || "—"}</td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => deleteMut.mutate(s.id)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/15 hover:text-red-400"
                      data-testid={`button-delete-staff-${s.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-white/5">
              <h2 className="text-lg font-semibold text-white">Add Staff Member</h2>
              <button onClick={() => setShowModal(false)} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">First Name</label>
                  <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="premium-input text-white" data-testid="input-staff-first-name" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Last Name</label>
                  <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="premium-input text-white" data-testid="input-staff-last-name" />
                </div>
              </div>
              <div>
                <label className="text-xs text-white/40 mb-1 block">Role</label>
                <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                  <SelectTrigger className="premium-input text-white" data-testid="select-staff-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Manager">Manager</SelectItem>
                    <SelectItem value="Coach">Coach</SelectItem>
                    <SelectItem value="Assistant Coach">Assistant Coach</SelectItem>
                    <SelectItem value="Physio">Physio</SelectItem>
                    <SelectItem value="Team Admin">Team Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Email</label>
                  <Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="premium-input text-white" />
                </div>
                <div>
                  <label className="text-xs text-white/40 mb-1 block">Phone</label>
                  <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className="premium-input text-white" />
                </div>
              </div>
            </div>
            <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setShowModal(false)} className="text-white/40">Cancel</Button>
              <Button
                onClick={() => createMut.mutate({
                  teamId,
                  firstName: form.firstName,
                  lastName: form.lastName,
                  role: form.role,
                  email: form.email || null,
                  phone: form.phone || null,
                })}
                disabled={!form.firstName || !form.lastName || createMut.isPending}
                className="bg-blue-600 hover:bg-blue-700 text-white"
                data-testid="button-save-staff"
              >
                Add Staff
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TournamentTeamDetail() {
  const [, params] = useRoute("/admin/tournaments/:tournamentId/teams/:teamId");
  const [, setLocation] = useLocation();
  const tournamentId = params?.tournamentId ? parseInt(params.tournamentId) : 0;
  const teamId = params?.teamId ? parseInt(params.teamId) : 0;
  const [tab, setTab] = useState<Tab>("players");

  const { data: team, isLoading } = useQuery<TournamentTeam>({
    queryKey: ["/api/admin/tournament/teams", teamId],
    queryFn: () => fetch(`/api/admin/tournament/teams/${teamId}`).then(r => r.json()),
    enabled: !!teamId,
  });

  // Tournament gives us orgId, which lets us list clubs for the picker.
  const { data: tournament } = useQuery<Tournament>({
    queryKey: ["/api/admin/tournament/tournaments", tournamentId],
    queryFn: () => fetch(`/api/admin/tournament/tournaments/${tournamentId}`).then(r => r.json()),
    enabled: !!tournamentId,
  });

  const { data: clubs = [] } = useQuery<Club[]>({
    queryKey: ["/api/admin/clubs", { orgId: tournament?.organizationId }],
    queryFn: () => fetch(`/api/admin/clubs?orgId=${tournament!.organizationId}`).then(r => r.json()),
    enabled: !!tournament?.organizationId,
  });

  const linkClubMut = useMutation({
    mutationFn: (clubId: number | null) =>
      apiRequest("PATCH", `/api/admin/tournament/teams/${teamId}`, { clubId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/tournament/teams", teamId] });
    },
  });

  if (isLoading || !team) {
    return <div className="p-6"><div className="h-32 rounded-2xl bg-white/[0.02] animate-pulse" /></div>;
  }

  const linkedClub = clubs.find(c => c.id === team.clubId);

  const tabs: { id: Tab; label: string; icon: any }[] = [
    { id: "players", label: "Players", icon: Users },
    { id: "staff", label: "Staff", icon: UserCog },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => setLocation(`/admin/tournaments/${tournamentId}`)}
          className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-white/5 text-white/30"
          data-testid="button-back-tournament"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-3 flex-1">
          <TeamLogo team={{ ...team, logoUrl: team.logoUrl || linkedClub?.logoUrl || null }} size={48} />
          <div className="flex-1">
            <h1 className="text-xl font-bold text-white" data-testid="text-team-name">{team.name}</h1>
            <p className="text-xs text-white/30">
              {linkedClub?.name || team.clubName || "No club linked"} · {team.contactName || linkedClub?.contactName || "No contact"}
            </p>
          </div>
          <TeamLogoUploader team={team} />
        </div>
      </div>

      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="text-xs text-white/40 uppercase tracking-wide">Club affiliation</div>
          <p className="text-xs text-white/50 mt-1">
            Link this team to a club to inherit its logo by default. Override with a team-specific logo above.
          </p>
        </div>
        <select
          value={team.clubId ?? ""}
          onChange={e => {
            const v = e.target.value;
            linkClubMut.mutate(v === "" ? null : parseInt(v));
          }}
          disabled={linkClubMut.isPending}
          className="bg-white/[0.02] border border-white/10 text-white text-sm rounded-md px-3 py-2 min-w-[240px]"
          data-testid="select-team-club"
        >
          <option value="">— No club linked —</option>
          {clubs.map(c => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 border border-white/5">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-all ${
              tab === t.id ? "bg-blue-600/20 text-blue-400 font-medium" : "text-white/30 hover:text-white/50 hover:bg-white/[0.02]"
            }`}
            data-testid={`tab-${t.id}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "players" && <PlayersTab teamId={teamId} />}
      {tab === "staff" && <StaffTab teamId={teamId} />}
    </div>
  );
}

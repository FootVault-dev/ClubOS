import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Trophy, Users, ClipboardCheck, Loader2, Plus, Pencil, Trash2, X, Search,
  Download, CheckCircle2, Clock, Medal, Goal, ListOrdered,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// The Play Predictor admin — fans predict CUFC first-team scores + goalscorers
// on cufc.co.nz; this tab runs the whole game: fixtures + prizes, the squad
// list behind the goalscorer picker, results (which recompute points via
// shared/predictor-scoring.ts), the entrant database and unmasked leaderboards.

type Fixture = {
  id: number;
  externalId: string | null;
  opponent: string;
  homeAway: string;
  kickoffAt: string;
  venue: string | null;
  status: string;
  cufcScore: number | null;
  opponentScore: number | null;
  goalscorers: string[] | null;
  prize: string | null;
  createdAt: string | null;
  predictionCount: number;
};
type SquadPlayer = { id: number; name: string; position: string | null; active: boolean; sort: number };
type Entrant = {
  id: number; fullName: string; email: string; phone: string;
  marketingConsent: boolean; source: string | null; createdAt: string | null;
  predictionCount: number; totalPoints: number;
};
type SeasonRow = { rank: number; entrantId: number; name: string; email: string; points: number; games: number };
type FixtureBoardRow = { rank: number; name: string; email?: string; points: number; predicted: string; goalscorers: string[] };
type PredictionRow = {
  id: number; entrantId: number; fullName: string; email: string; phone: string;
  cufcScore: number; opponentScore: number; goalscorers: string[]; pointsAwarded: number | null; createdAt: string | null;
};
type View = "fixtures" | "squad" | "entrants" | "leaderboard";

const kickoffLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-NZ", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

// datetime-local wants local wall time, not ISO/UTC.
const toLocalInputValue = (iso: string) => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const fixtureTitle = (f: Fixture) => (f.homeAway === "A" ? `${f.opponent} (A)` : `${f.opponent} (H)`);

export default function Predictor() {
  const [view, setView] = useState<View>("fixtures");

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Play Predictor</h1>
          <p className="text-sm text-white/40 mt-1">First-team score predictions — fixtures, results, entrants and leaderboards</p>
        </div>
        <div className="inline-flex rounded-lg border border-white/5 bg-white/[0.02] p-0.5">
          {([["fixtures", "Fixtures"], ["squad", "Squad"], ["entrants", "Entries"], ["leaderboard", "Leaderboard"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} data-testid={`predictor-view-${v}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-md transition-colors ${view === v ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {view === "fixtures" && <FixturesView />}
      {view === "squad" && <SquadView />}
      {view === "entrants" && <EntrantsView />}
      {view === "leaderboard" && <LeaderboardView />}
    </div>
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
function FixturesView() {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Fixture | null>(null);
  const [creating, setCreating] = useState(false);
  const [resultFor, setResultFor] = useState<Fixture | null>(null);
  const [predictionsFor, setPredictionsFor] = useState<Fixture | null>(null);

  const { data: fixtures = [], isLoading } = useQuery<Fixture[]>({ queryKey: ["/api/admin/predictor/fixtures"] });

  const deleteFixture = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/predictor/fixtures/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/fixtures"] });
      toast({ title: "Fixture deleted" });
    },
    onError: (e: any) => toast({ title: "Couldn't delete fixture", description: e.message, variant: "destructive" }),
  });

  const upcoming = fixtures.filter((f) => f.status !== "final");
  const finals = fixtures.filter((f) => f.status === "final");

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="grid grid-cols-3 gap-3 flex-1 min-w-[260px] max-w-md">
          {[
            { label: "Fixtures", value: fixtures.length },
            { label: "Scheduled", value: upcoming.length },
            { label: "Finals", value: finals.length },
          ].map((s, i) => (
            <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
              <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
              <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
            </div>
          ))}
        </div>
        <button onClick={() => setCreating(true)} data-testid="predictor-add-fixture"
          className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-400 transition-colors">
          <Plus className="w-3.5 h-3.5" /> Add fixture
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading fixtures…</div>
      ) : fixtures.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Trophy className="w-12 h-12 mb-3" />
            <p className="text-sm">No fixtures yet — add the next first-team game to open predictions.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Fixture", "Kickoff", "Venue", "Prize", "Status", "Entries", ""].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fixtures.map((f) => (
                <tr key={f.id} className="border-b border-white/[0.02]" data-testid={`predictor-fixture-row-${f.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/85 font-medium">
                    {f.homeAway === "A" ? `${f.opponent} (A)` : `${f.opponent} (H)`}
                    {f.status === "final" && (
                      <span className="ml-2 text-xs text-white/50">
                        {f.homeAway === "A" ? `${f.opponentScore}–${f.cufcScore}` : `${f.cufcScore}–${f.opponentScore}`}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/60 whitespace-nowrap">{kickoffLabel(f.kickoffAt)}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{f.venue || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50 max-w-[200px] truncate">{f.prize || "—"}</td>
                  <td className="px-4 py-2.5">
                    {f.status === "final"
                      ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-green-400"><CheckCircle2 className="w-3 h-3" /> Final</span>
                      : new Date(f.kickoffAt).getTime() > Date.now()
                        ? <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-300"><Clock className="w-3 h-3" /> Open</span>
                        : <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300"><Clock className="w-3 h-3" /> Kicked off</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => setPredictionsFor(f)} data-testid={`predictor-fixture-predictions-${f.id}`}
                      className="text-sm text-white/60 hover:text-white underline decoration-white/20 underline-offset-2">
                      {f.predictionCount}
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => setResultFor(f)} data-testid={`predictor-fixture-result-${f.id}`}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15">
                        {f.status === "final" ? "Edit result" : "Enter result"}
                      </button>
                      <button onClick={() => setEditing(f)} title="Edit fixture"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete ${f.opponent}? This also removes its ${f.predictionCount} prediction${f.predictionCount === 1 ? "" : "s"}.`)) {
                            deleteFixture.mutate(f.id);
                          }
                        }}
                        title="Delete fixture"
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-red-500/10">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <FixtureDialog fixture={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      )}
      {resultFor && <ResultDialog fixture={resultFor} onClose={() => setResultFor(null)} />}
      {predictionsFor && <PredictionsDialog fixture={predictionsFor} onClose={() => setPredictionsFor(null)} />}
    </>
  );
}

function FixtureDialog({ fixture, onClose }: { fixture: Fixture | null; onClose: () => void }) {
  const { toast } = useToast();
  const [opponent, setOpponent] = useState(fixture?.opponent ?? "");
  const [homeAway, setHomeAway] = useState(fixture?.homeAway === "A" ? "A" : "H");
  const [kickoff, setKickoff] = useState(fixture ? toLocalInputValue(fixture.kickoffAt) : "");
  const [venue, setVenue] = useState(fixture?.venue ?? "");
  const [prize, setPrize] = useState(fixture?.prize ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        opponent: opponent.trim(),
        homeAway,
        kickoffAt: new Date(kickoff).toISOString(),
        venue: venue.trim(),
        prize: prize.trim(),
      };
      return fixture
        ? apiRequest("PATCH", `/api/admin/predictor/fixtures/${fixture.id}`, body)
        : apiRequest("POST", "/api/admin/predictor/fixtures", body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/fixtures"] });
      toast({ title: fixture ? "Fixture updated" : "Fixture added" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't save fixture", description: e.message, variant: "destructive" }),
  });

  const canSave = opponent.trim().length > 0 && kickoff && !isNaN(new Date(kickoff).getTime());

  return (
    <Modal title={fixture ? "Edit fixture" : "Add fixture"} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Opponent">
          <input value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="e.g. Cashmere Technical"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25"
            data-testid="predictor-fixture-opponent" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Home / Away">
            <Select value={homeAway} onValueChange={setHomeAway}>
              <SelectTrigger className="premium-input text-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="H">Home</SelectItem>
                <SelectItem value="A">Away</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Kickoff">
            <input type="datetime-local" value={kickoff} onChange={(e) => setKickoff(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white focus:outline-none focus:border-white/25 [color-scheme:dark]"
              data-testid="predictor-fixture-kickoff" />
          </Field>
        </div>
        <Field label="Venue (optional)">
          <input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g. United Sports Centre"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" />
        </Field>
        <Field label="Prize (optional)">
          <input value={prize} onChange={(e) => setPrize(e.target.value)} placeholder="e.g. Signed 2026 home shirt"
            className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25"
            data-testid="predictor-fixture-prize" />
        </Field>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button onClick={onClose} className="py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!canSave || save.isPending} data-testid="predictor-fixture-save"
            className="py-2.5 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-40 flex items-center justify-center gap-2">
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ResultDialog({ fixture, onClose }: { fixture: Fixture; onClose: () => void }) {
  const { toast } = useToast();
  const [cufcScore, setCufcScore] = useState(fixture.cufcScore != null ? String(fixture.cufcScore) : "");
  const [opponentScore, setOpponentScore] = useState(fixture.opponentScore != null ? String(fixture.opponentScore) : "");
  const [scorers, setScorers] = useState<string[]>(fixture.goalscorers ?? []);
  const [otherScorer, setOtherScorer] = useState("");

  const { data: squad = [] } = useQuery<SquadPlayer[]>({ queryKey: ["/api/admin/predictor/squad"] });
  const activeSquad = squad.filter((p) => p.active);

  const toggleScorer = (name: string) => {
    setScorers((prev) => prev.some((s) => s.toLowerCase() === name.toLowerCase())
      ? prev.filter((s) => s.toLowerCase() !== name.toLowerCase())
      : [...prev, name]);
  };
  const addOther = () => {
    const name = otherScorer.trim();
    if (!name) return;
    if (!scorers.some((s) => s.toLowerCase() === name.toLowerCase())) setScorers((prev) => [...prev, name]);
    setOtherScorer("");
  };

  const save = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/predictor/fixtures/${fixture.id}/result`, {
      cufcScore: parseInt(cufcScore), opponentScore: parseInt(opponentScore), goalscorers: scorers,
    }).then((r) => r.json()),
    onSuccess: (r: { scored: number }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/fixtures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/entrants"] });
      toast({ title: "Result saved", description: `Points recomputed for ${r.scored} prediction${r.scored === 1 ? "" : "s"}.` });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't save result", description: e.message, variant: "destructive" }),
  });

  const validScore = (v: string) => /^\d+$/.test(v) && parseInt(v) >= 0 && parseInt(v) <= 20;
  const canSave = validScore(cufcScore) && validScore(opponentScore);

  return (
    <Modal title={`Result — ${fixtureTitle(fixture)}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="CUFC">
            <input inputMode="numeric" value={cufcScore} onChange={(e) => setCufcScore(e.target.value)} placeholder="0"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white text-center font-semibold placeholder:text-white/30 focus:outline-none focus:border-white/25"
              data-testid="predictor-result-cufc" />
          </Field>
          <Field label={fixture.opponent}>
            <input inputMode="numeric" value={opponentScore} onChange={(e) => setOpponentScore(e.target.value)} placeholder="0"
              className="w-full px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white text-center font-semibold placeholder:text-white/30 focus:outline-none focus:border-white/25"
              data-testid="predictor-result-opponent" />
          </Field>
        </div>

        <Field label="CUFC goalscorers">
          {activeSquad.length === 0 ? (
            <p className="text-xs text-white/40">No active squad players yet — add them under Squad, or type names below.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5 max-h-[160px] overflow-y-auto pr-1">
              {activeSquad.map((p) => {
                const on = scorers.some((s) => s.toLowerCase() === p.name.toLowerCase());
                return (
                  <button key={p.id} onClick={() => toggleScorer(p.name)} data-testid={`predictor-result-scorer-${p.id}`}
                    className={`text-xs font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${on ? "bg-blue-500/20 border-blue-500/40 text-blue-200" : "bg-white/[0.03] border-white/10 text-white/50 hover:text-white/80"}`}>
                    {p.name}
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 mt-2">
            <input value={otherScorer} onChange={(e) => setOtherScorer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOther(); } }}
              placeholder="Other scorer (own goal, trialist…)"
              className="flex-1 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-xs text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" />
            <button onClick={addOther} disabled={!otherScorer.trim()}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 disabled:opacity-40">Add</button>
          </div>
          {scorers.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {scorers.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-blue-500/15 text-blue-200 border border-blue-500/25">
                  <Goal className="w-3 h-3" /> {s}
                  <button onClick={() => setScorers((prev) => prev.filter((x) => x !== s))} className="text-blue-200/60 hover:text-blue-100"><X className="w-3 h-3" /></button>
                </span>
              ))}
            </div>
          )}
        </Field>

        <p className="text-[11px] text-white/40">
          Saving marks the game as final and recomputes points for every prediction — exact score 5, correct result 2, +1 per correct goalscorer pick. You can re-enter a corrected result any time.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={onClose} className="py-2.5 rounded-lg text-sm font-medium bg-white/10 text-white hover:bg-white/15">Cancel</button>
          <button onClick={() => save.mutate()} disabled={!canSave || save.isPending} data-testid="predictor-result-save"
            className="py-2.5 rounded-lg text-sm font-semibold bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-40 flex items-center justify-center gap-2">
            {save.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Scoring…</> : "Save result"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PredictionsDialog({ fixture, onClose }: { fixture: Fixture; onClose: () => void }) {
  const { data: predictions = [], isLoading } = useQuery<PredictionRow[]>({
    queryKey: [`/api/admin/predictor/fixtures/${fixture.id}/predictions`],
  });
  return (
    <Modal title={`Predictions — ${fixtureTitle(fixture)}`} onClose={onClose} wide>
      {isLoading ? (
        <div className="text-center py-10 text-white/20 text-sm">Loading predictions…</div>
      ) : predictions.length === 0 ? (
        <div className="text-center py-10 text-white/25 text-sm">No predictions yet.</div>
      ) : (
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Fan", "Email", "Predicted", "Scorer picks", "Points"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {predictions.map((p) => (
                <tr key={p.id} className="border-b border-white/[0.02]">
                  <td className="px-3 py-2 text-sm text-white/80 font-medium">{p.fullName}</td>
                  <td className="px-3 py-2 text-sm text-white/50">{p.email}</td>
                  <td className="px-3 py-2 text-sm text-white/70">{p.cufcScore}–{p.opponentScore}</td>
                  <td className="px-3 py-2 text-sm text-white/50">{(p.goalscorers || []).join(", ") || "—"}</td>
                  <td className="px-3 py-2 text-sm text-white/70 font-semibold">{p.pointsAwarded ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// ── Squad ─────────────────────────────────────────────────────────────────────
function SquadView() {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");

  const { data: squad = [], isLoading } = useQuery<SquadPlayer[]>({ queryKey: ["/api/admin/predictor/squad"] });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/predictor/squad"] });

  const create = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/predictor/squad", { name: name.trim(), position: position.trim() }),
    onSuccess: () => { invalidate(); setName(""); setPosition(""); toast({ title: "Player added" }); },
    onError: (e: any) => toast({ title: "Couldn't add player", description: e.message, variant: "destructive" }),
  });
  const toggle = useMutation({
    mutationFn: (p: SquadPlayer) => apiRequest("PATCH", `/api/admin/predictor/squad/${p.id}`, { active: !p.active }),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "Couldn't update player", description: e.message, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/predictor/squad/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Player removed" }); },
    onError: (e: any) => toast({ title: "Couldn't remove player", description: e.message, variant: "destructive" }),
  });

  return (
    <>
      <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
        <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold mb-2">Add player</p>
        <div className="flex items-center gap-2 flex-wrap">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name"
            onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) create.mutate(); }}
            className="flex-1 min-w-[180px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25"
            data-testid="predictor-squad-name" />
          <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="Position (optional)"
            className="w-[170px] px-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25" />
          <button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending} data-testid="predictor-squad-add"
            className="flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-400 disabled:opacity-40">
            {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add
          </button>
        </div>
        <p className="text-[11px] text-white/30 mt-2">Active players appear in the goalscorer picker on cufc.co.nz.</p>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading squad…</div>
      ) : squad.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Users className="w-12 h-12 mb-3" />
            <p className="text-sm">No players yet — add the first-team squad above.</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[520px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Player", "Position", "Status", ""].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {squad.map((p) => (
                <tr key={p.id} className={`border-b border-white/[0.02] ${p.active ? "" : "opacity-40"}`} data-testid={`predictor-squad-row-${p.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{p.name}</td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{p.position || "—"}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[11px] font-medium ${p.active ? "text-green-400" : "text-white/40"}`}>{p.active ? "Active" : "Hidden"}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => toggle.mutate(p)}
                        className="text-[11px] font-medium px-2.5 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15">
                        {p.active ? "Hide" : "Activate"}
                      </button>
                      <button
                        onClick={() => { if (window.confirm(`Remove ${p.name} from the squad list?`)) remove.mutate(p.id); }}
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40 hover:text-red-400 hover:bg-red-500/10">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Entries (entrant database) ────────────────────────────────────────────────
function EntrantsView() {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const { data: entrants = [], isLoading } = useQuery<Entrant[]>({ queryKey: ["/api/admin/predictor/entrants"] });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entrants;
    return entrants.filter((e) =>
      e.fullName.toLowerCase().includes(needle) || e.email.toLowerCase().includes(needle) || (e.phone || "").toLowerCase().includes(needle));
  }, [entrants, q]);

  const exportCsv = async () => {
    try {
      const res = await apiRequest("GET", "/api/admin/predictor/entrants.csv");
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "predictor-entrants.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: "Entrants", value: entrants.length },
          { label: "Predictions", value: entrants.reduce((s, e) => s + e.predictionCount, 0) },
          { label: "Marketing consent", value: entrants.filter((e) => e.marketingConsent).length },
        ].map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or phone…"
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-white/[0.03] border border-white/10 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/25"
            data-testid="predictor-entrants-search" />
        </div>
        <button onClick={exportCsv} disabled={!entrants.length} data-testid="predictor-entrants-export"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15 transition-colors disabled:opacity-40">
          <Download className="w-3.5 h-3.5" /> Export CSV
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading entrants…</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <ClipboardCheck className="w-12 h-12 mb-3" />
            <p className="text-sm">{entrants.length === 0 ? "No entries yet." : "No entrants match."}</p>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-white/5">
                {["Name", "Email", "Phone", "Predictions", "Points", "Joined"].map((h) => (
                  <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id} className="border-b border-white/[0.02]" data-testid={`predictor-entrant-row-${e.id}`}>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{e.fullName}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">
                    {e.email}
                    {!e.marketingConsent && <span className="ml-2 text-[10px] text-amber-400">no marketing</span>}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-white/50">{e.phone || "—"}</td>
                  <td className="px-4 py-2.5 text-sm text-white/60">{e.predictionCount}</td>
                  <td className="px-4 py-2.5 text-sm text-white/80 font-semibold">{e.totalPoints}</td>
                  <td className="px-4 py-2.5 text-sm text-white/40 whitespace-nowrap">
                    {e.createdAt ? new Date(e.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ── Leaderboard (unmasked) ────────────────────────────────────────────────────
function LeaderboardView() {
  const [fixtureId, setFixtureId] = useState<string>("season");
  const { data: fixtures = [] } = useQuery<Fixture[]>({ queryKey: ["/api/admin/predictor/fixtures"] });
  const finals = fixtures.filter((f) => f.status === "final");

  const url = fixtureId === "season"
    ? "/api/admin/predictor/leaderboard"
    : `/api/admin/predictor/leaderboard?fixtureId=${fixtureId}`;
  const { data, isLoading } = useQuery<{ fixtureBoard: FixtureBoardRow[] | null; season: SeasonRow[] }>({ queryKey: [url] });

  const showingFixture = fixtureId !== "season" && data?.fixtureBoard;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={fixtureId} onValueChange={setFixtureId}>
          <SelectTrigger className="premium-input text-white w-[280px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="season">Season leaderboard</SelectItem>
            {finals.map((f) => (
              <SelectItem key={f.id} value={String(f.id)}>{fixtureTitle(f)} · {kickoffLabel(f.kickoffAt)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-[11px] text-white/40 flex items-center gap-1.5">
          <ListOrdered className="w-3.5 h-3.5" /> Per-game boards exist once a result is entered. Public boards mask names to "First L."
        </span>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading leaderboard…</div>
      ) : showingFixture ? (
        <Board
          headers={["#", "Fan", "Email", "Predicted", "Scorer picks", "Points"]}
          empty="No scored predictions for this game."
          rows={(data!.fixtureBoard || []).map((r, i) => (
            <tr key={i} className="border-b border-white/[0.02]">
              <td className="px-4 py-2.5 text-sm text-white/50 w-10">{r.rank <= 3 ? <Medal className={`w-4 h-4 ${r.rank === 1 ? "text-amber-300" : r.rank === 2 ? "text-white/60" : "text-amber-700"}`} /> : r.rank}</td>
              <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{r.name}</td>
              <td className="px-4 py-2.5 text-sm text-white/50">{r.email || "—"}</td>
              <td className="px-4 py-2.5 text-sm text-white/70">{r.predicted}</td>
              <td className="px-4 py-2.5 text-sm text-white/50">{(r.goalscorers || []).join(", ") || "—"}</td>
              <td className="px-4 py-2.5 text-sm text-white/85 font-semibold">{r.points}</td>
            </tr>
          ))}
        />
      ) : (
        <Board
          headers={["#", "Fan", "Email", "Games", "Points"]}
          empty="No finals yet — the season board fills once the first result is entered."
          rows={(data?.season || []).map((r) => (
            <tr key={r.entrantId} className="border-b border-white/[0.02]" data-testid={`predictor-season-row-${r.entrantId}`}>
              <td className="px-4 py-2.5 text-sm text-white/50 w-10">{r.rank <= 3 ? <Medal className={`w-4 h-4 ${r.rank === 1 ? "text-amber-300" : r.rank === 2 ? "text-white/60" : "text-amber-700"}`} /> : r.rank}</td>
              <td className="px-4 py-2.5 text-sm text-white/80 font-medium">{r.name}</td>
              <td className="px-4 py-2.5 text-sm text-white/50">{r.email}</td>
              <td className="px-4 py-2.5 text-sm text-white/60">{r.games}</td>
              <td className="px-4 py-2.5 text-sm text-white/85 font-semibold">{r.points}</td>
            </tr>
          ))}
        />
      )}
    </>
  );
}

function Board({ headers, rows, empty }: { headers: string[]; rows: React.ReactNode[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
        <div className="flex flex-col items-center justify-center py-16 text-white/20">
          <Trophy className="w-12 h-12 mb-3" />
          <p className="text-sm">{empty}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-x-auto">
      <table className="w-full min-w-[680px]">
        <thead>
          <tr className="border-b border-white/5">
            {headers.map((h) => (
              <th key={h} className="text-left text-[10px] text-white/30 uppercase px-4 py-2 font-semibold">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}

// ── Shared bits ───────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className={`bg-[#0a0e1a] border border-blue-500/20 rounded-2xl w-full ${wide ? "max-w-2xl" : "max-w-md"} p-6`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">{title}</h3>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wider text-white/30 font-semibold">{label}</p>
      {children}
    </div>
  );
}

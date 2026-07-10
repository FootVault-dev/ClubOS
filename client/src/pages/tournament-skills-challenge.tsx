// Skills Challenge tab — CIC workspace. Built for one job: on tournament day a
// single scorer takes paper slips from five juggling counters and types them in
// while the standings update live behind them.
//
// So the page is the four categories ({U10, U11} × {90s Juggling, Dribble, Pass
// & Finish}), each holding its own players. Inside a category the scored players
// sit at the top as a live leaderboard; everyone still waiting sits underneath.
// Enter a score, press Enter, and focus jumps to the next unscored player — the
// scorer never reaches for the mouse.
//
// Adding a walk-up runs club → age → player, because the club narrows everything
// after it and almost every walk-up is already in the database under a club that
// registered online.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Zap, Plus, Search, Trash2, X, Users, ClipboardCheck, Clock, Check, ChevronDown, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { canonicalClub } from "@/lib/skills-clubs";

type ChallengeKey = "juggling" | "dribble_pass_finish";
type AgeGroup = "U10" | "U11";

interface SkillsEntry {
  id: number;
  playerName: string;
  clubName: string;
  ageGroup: AgeGroup;
  challenge: ChallengeKey;
  score: number | null;
  scoredAt: string | null;
  source: string;
  createdAt: string;
}

const CHALLENGE_LABELS: Record<ChallengeKey, string> = {
  juggling: "90s Juggling",
  dribble_pass_finish: "Dribble, Pass & Finish",
};

const CHALLENGE_SCORE_UNIT: Record<ChallengeKey, string> = {
  juggling: "juggles",
  dribble_pass_finish: "seconds",
};

// The four panels, in the order Daniel reads them out.
const CATEGORIES: { challenge: ChallengeKey; ageGroup: AgeGroup }[] = [
  { ageGroup: "U10", challenge: "juggling" },
  { ageGroup: "U10", challenge: "dribble_pass_finish" },
  { ageGroup: "U11", challenge: "juggling" },
  { ageGroup: "U11", challenge: "dribble_pass_finish" },
];

const AGE_GROUPS: AgeGroup[] = ["U10", "U11"];

function formatScore(challenge: ChallengeKey, score: number | null): string {
  if (score == null) return "—";
  return challenge === "juggling" ? `${Math.round(score)}` : `${score.toFixed(2)}s`;
}

/** A fat-fingered score poisons a live leaderboard, so ask before taking an
 *  outlier. 90 seconds of juggling tops out well under 300; the dribble course
 *  is a sprint, not a marathon. */
function implausible(challenge: ChallengeKey, n: number): string | null {
  if (challenge === "juggling") {
    if (!Number.isInteger(n)) return `${n} juggles isn't a whole number.`;
    if (n > 300) return `${n} juggles in 90 seconds is over three a second.`;
  } else {
    if (n < 5) return `${n} seconds is faster than anyone can run the course.`;
    if (n > 300) return `${n} seconds is over five minutes.`;
  }
  return null;
}

/** The same child, entered twice in one category under two spellings of their
 *  club. The server's dedupe compares the club string exactly, so "Nomads
 *  united" and "Nomads United AFC" slipped past it and Arlo Pitman is in the
 *  U10 juggling twice. Flag them; never delete a registration automatically. */
function findDuplicates(entries: SkillsEntry[]): { ids: Set<number>; players: number } {
  const groups = new Map<string, number[]>();
  for (const e of entries) {
    const key = [
      e.playerName.trim().toLowerCase().replace(/\s+/g, " "),
      canonicalClub(e.clubName).toLowerCase(),
      e.ageGroup,
      e.challenge,
    ].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(e.id);
  }
  const ids = new Set<number>();
  let players = 0;
  for (const group of Array.from(groups.values())) {
    if (group.length > 1) {
      players++;
      group.forEach((id) => ids.add(id));
    }
  }
  return { ids, players };
}

/** Standard competition ranking — equal scores share a rank (1,2,2,4).
 *  Mirrors skillsLeaderboards() on the server so the page and the app agree. */
function rankScored(challenge: ChallengeKey, entries: SkillsEntry[]) {
  const scored = entries.filter((e) => e.score != null);
  scored.sort((a, b) => (challenge === "juggling" ? b.score! - a.score! : a.score! - b.score!));
  let lastScore: number | null = null;
  let lastRank = 0;
  return scored.map((e, i) => {
    const rank = e.score === lastScore ? lastRank : i + 1;
    lastScore = e.score;
    lastRank = rank;
    return { entry: e, rank };
  });
}

// ─────────────────────────────── Combobox ────────────────────────────────────
// Type to filter, arrow keys to move, Enter to take the highlighted option.
// Anything typed that doesn't match is still accepted — a club or a player who
// never registered online has to be enterable in three seconds flat.

interface ComboOption {
  value: string;
  hint?: string;
}

function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  emptyHint,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ComboOption[];
  placeholder: string;
  disabled?: boolean;
  emptyHint?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.value.toLowerCase().includes(q));
  }, [options, value]);

  const exact = options.some((o) => o.value.toLowerCase() === value.trim().toLowerCase());

  useEffect(() => setHighlight(0), [value]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const take = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <Input
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) return setOpen(true);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && open && matches[highlight]) {
            e.preventDefault();
            take(matches[highlight].value);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className="pr-8"
      />
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/25" />

      {open && !disabled && (matches.length > 0 || (value.trim() && !exact)) && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-white/10 bg-[#0d1220] py-1 shadow-2xl">
          {matches.map((o, i) => (
            <button
              key={o.value}
              type="button"
              onMouseEnter={() => setHighlight(i)}
              onClick={() => take(o.value)}
              className={`flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm ${
                i === highlight ? "bg-white/[0.07] text-white" : "text-white/75"
              }`}
            >
              <span className="truncate">{o.value}</span>
              {o.hint && <span className="shrink-0 text-xs text-white/30">{o.hint}</span>}
            </button>
          ))}
          {value.trim() && !exact && (
            <button
              type="button"
              onClick={() => take(value.trim())}
              className={`flex w-full items-center gap-2 border-t border-white/5 px-3 py-2.5 text-left text-sm ${
                matches.length === 0 ? "text-white" : "text-amber-300/90"
              }`}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">
                Add “{value.trim()}” {emptyHint ? <span className="text-white/30">— {emptyHint}</span> : null}
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`min-h-[44px] flex-1 rounded-xl border px-3 text-sm font-semibold transition-colors ${
            value === o.value
              ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
              : "border-white/10 bg-white/[0.02] text-white/50 hover:text-white/80"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ────────────────────────────── Add entry ────────────────────────────────────

function AddEntryModal({
  entries,
  initial,
  onClose,
}: {
  entries: SkillsEntry[];
  initial: { ageGroup: AgeGroup; challenge: ChallengeKey } | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [clubName, setClubName] = useState("");
  const [ageGroup, setAgeGroup] = useState<AgeGroup>(initial?.ageGroup ?? "U10");
  const [playerName, setPlayerName] = useState("");
  const [challenge, setChallenge] = useState<ChallengeKey>(initial?.challenge ?? "juggling");
  const [score, setScore] = useState("");

  // Clubs, grouped across their spellings. Display the canonical name; count
  // players across every spelling of it.
  const clubOptions = useMemo<ComboOption[]>(() => {
    const groups = new Map<string, { display: string; players: Set<string> }>();
    for (const e of entries) {
      const display = canonicalClub(e.clubName);
      const key = display.toLowerCase();
      if (!groups.has(key)) groups.set(key, { display, players: new Set() });
      groups.get(key)!.players.add(e.playerName.toLowerCase());
    }
    return Array.from(groups.values())
      .sort((a, b) => a.display.localeCompare(b.display))
      .map((g) => ({ value: g.display, hint: `${g.players.size} player${g.players.size === 1 ? "" : "s"}` }));
  }, [entries]);

  // Players already known at this club + age, whatever challenge they signed up
  // for. A kid who registered for juggling and turns up for the dribble course
  // is the common case, and the scorer shouldn't retype his name.
  const playerOptions = useMemo<ComboOption[]>(() => {
    if (!clubName.trim()) return [];
    const wanted = canonicalClub(clubName).toLowerCase();
    // Key on the lowercased name so "yino dong" and "Yino Dong" are one person.
    const seen = new Map<string, { display: string; challenges: Set<ChallengeKey> }>();
    for (const e of entries) {
      if (canonicalClub(e.clubName).toLowerCase() !== wanted) continue;
      if (e.ageGroup !== ageGroup) continue;
      const key = e.playerName.trim().toLowerCase();
      if (!seen.has(key)) seen.set(key, { display: e.playerName.trim(), challenges: new Set() });
      seen.get(key)!.challenges.add(e.challenge);
    }
    return Array.from(seen.values())
      .sort((a, b) => a.display.localeCompare(b.display))
      .map(({ display, challenges }) => ({
        value: display,
        hint: challenges.has(challenge)
          ? "already in this challenge"
          : `entered in ${challenges.size} other`,
      }));
  }, [entries, clubName, ageGroup, challenge]);

  // Only true once they've actually landed on a club we know — otherwise the
  // "no players registered" hint fires on every keystroke of a half-typed name.
  const clubKnown = useMemo(
    () => clubOptions.some((o) => o.value.toLowerCase() === canonicalClub(clubName).toLowerCase()),
    [clubOptions, clubName],
  );

  // Exactly the server's soft-dedupe rule, checked up front so the scorer isn't
  // told "already registered" only after committing.
  const duplicate = useMemo(() => {
    if (!playerName.trim() || !clubName.trim()) return false;
    return entries.some(
      (e) =>
        e.challenge === challenge &&
        e.ageGroup === ageGroup &&
        e.playerName.trim().toLowerCase() === playerName.trim().toLowerCase() &&
        canonicalClub(e.clubName).toLowerCase() === canonicalClub(clubName).toLowerCase(),
    );
  }, [entries, playerName, clubName, ageGroup, challenge]);

  const createMut = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/admin/skills-challenge/entries", data),
    onSuccess: async (res) => {
      const body = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/leaderboard"] });
      toast({
        title: body.alreadyRegistered ? "Already registered — no duplicate created" : "Player added",
        description: `${playerName.trim()} · ${CHALLENGE_LABELS[challenge]} ${ageGroup}`,
      });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't add player", description: e.message, variant: "destructive" }),
  });

  const submit = () => {
    const raw = score.trim();
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return toast({ title: "Score must be a positive number", variant: "destructive" });
      }
      const warn = implausible(challenge, n);
      if (warn && !confirm(`${warn}\n\nSave it anyway?`)) return;
    }
    createMut.mutate({
      playerName: playerName.trim(),
      // Store the canonical spelling so the picker doesn't fragment further.
      clubName: canonicalClub(clubName),
      ageGroup,
      challenge,
      score: raw === "" ? null : raw,
    });
  };

  const step = (n: number, label: string, done: boolean) => (
    <div className="mb-1.5 flex items-center gap-2">
      <span
        className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[10px] font-bold ${
          done ? "bg-amber-400/20 text-amber-300" : "bg-white/5 text-white/30"
        }`}
      >
        {done ? <Check className="h-2.5 w-2.5" /> : n}
      </span>
      <label className="text-xs font-medium text-white/50">{label}</label>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-blue-500/15 bg-[#0a0e1a] shadow-2xl sm:rounded-2xl">
        <div className="sticky top-0 flex items-center justify-between border-b border-white/5 bg-[#0a0e1a] p-5">
          <div>
            <h2 className="text-lg font-semibold text-white">Add a player</h2>
            <p className="mt-0.5 text-xs text-white/35">Walk-ups and anyone who didn't register online</p>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            {step(1, "Club", !!clubName.trim())}
            <ComboBox
              autoFocus
              value={clubName}
              onChange={(v) => {
                setClubName(v);
                setPlayerName("");
              }}
              options={clubOptions}
              placeholder="Start typing a club…"
              emptyHint="new club"
            />
          </div>

          <div>
            {step(2, "Age group", true)}
            <Segmented
              value={ageGroup}
              onChange={(v) => {
                setAgeGroup(v);
                setPlayerName("");
              }}
              options={AGE_GROUPS.map((a) => ({ value: a, label: a }))}
            />
          </div>

          <div>
            {step(3, "Player", !!playerName.trim())}
            <ComboBox
              value={playerName}
              onChange={setPlayerName}
              options={playerOptions}
              disabled={!clubName.trim()}
              placeholder={clubName.trim() ? "Start typing a name…" : "Pick a club first"}
              emptyHint="not registered online"
            />
            {clubKnown && playerOptions.length === 0 && (
              <p className="mt-1.5 text-xs text-white/30">
                No {ageGroup} players registered under {canonicalClub(clubName)} — type the full name.
              </p>
            )}
          </div>

          <div>
            {step(4, "Challenge", true)}
            <Segmented
              value={challenge}
              onChange={setChallenge}
              options={[
                { value: "juggling" as const, label: "90s Juggling" },
                { value: "dribble_pass_finish" as const, label: "Dribble, Pass & Finish" },
              ]}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-white/50">
              Score ({CHALLENGE_SCORE_UNIT[challenge]}) — optional
            </label>
            <Input
              value={score}
              onChange={(e) => setScore(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && playerName.trim() && clubName.trim()) submit();
              }}
              placeholder={challenge === "juggling" ? "e.g. 42" : "e.g. 34.52"}
              inputMode="decimal"
            />
          </div>

          {duplicate && (
            <div className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2.5 text-xs text-amber-200/80">
              {playerName.trim()} is already entered in {CHALLENGE_LABELS[challenge]} {ageGroup}. Adding won't create a
              duplicate — score them from the {ageGroup} panel instead.
            </div>
          )}
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 border-t border-white/5 bg-[#0a0e1a] p-5">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!playerName.trim() || !clubName.trim() || createMut.isPending}>
            {createMut.isPending ? "Adding…" : "Add player"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────── Category panel ─────────────────────────────────

function ScoreButton({
  entry,
  editing,
  onStartEdit,
  onCancel,
  onSave,
  saving,
}: {
  entry: SkillsEntry;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (raw: string) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    if (editing) setValue(entry.score == null ? "" : String(entry.score));
  }, [editing, entry.score]);

  if (!editing) {
    return (
      <button
        onClick={onStartEdit}
        className={`min-h-[44px] min-w-[84px] rounded-lg px-2.5 text-sm font-semibold transition-colors sm:min-h-[38px] ${
          entry.score == null
            ? "border border-dashed border-white/15 text-white/30 hover:border-amber-400/40 hover:text-amber-300"
            : "bg-white/5 text-white hover:bg-white/10"
        }`}
        title="Click to enter or edit the score"
      >
        {entry.score == null ? "Enter score" : formatScore(entry.challenge, entry.score)}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(value);
          if (e.key === "Escape") onCancel();
        }}
        onFocus={(e) => e.currentTarget.select()}
        placeholder={entry.challenge === "juggling" ? "juggles" : "seconds"}
        inputMode="decimal"
        className="h-9 w-[88px] text-sm"
      />
      <Button size="sm" className="h-9" disabled={saving} onClick={() => onSave(value)}>
        {saving ? "…" : "Save"}
      </Button>
      <button onClick={onCancel} className="text-white/30 hover:text-white/60" aria-label="Cancel">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

const RANK_STYLES: Record<number, string> = {
  1: "bg-amber-400/15 text-amber-300 border-amber-400/30",
  2: "bg-white/10 text-white/70 border-white/20",
  3: "bg-orange-800/25 text-orange-300/80 border-orange-700/30",
};

function PlayerRow({
  entry,
  rank,
  editing,
  saving,
  isDuplicate,
  onStartEdit,
  onCancel,
  onSave,
  onDelete,
}: {
  entry: SkillsEntry;
  rank?: number;
  editing: boolean;
  saving: boolean;
  isDuplicate: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (raw: string) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2.5 rounded-xl px-2 py-2 hover:bg-white/[0.02] ${
        isDuplicate ? "bg-amber-400/[0.04] ring-1 ring-inset ring-amber-400/15" : ""
      }`}
    >
      {rank ? (
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs font-bold ${
            RANK_STYLES[rank] ?? "border-white/5 bg-white/[0.03] text-white/40"
          }`}
        >
          {rank}
        </span>
      ) : (
        <span className="h-6 w-6 shrink-0" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5">
          <span className="truncate text-sm font-medium text-white">{entry.playerName}</span>
          {entry.source === "admin" && (
            <span className="shrink-0 rounded bg-white/5 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-white/30">
              walk-up
            </span>
          )}
          {isDuplicate && (
            <span
              className="shrink-0 rounded bg-amber-400/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300"
              title="This player is entered twice in this category under two spellings of their club. Score one, delete the other."
            >
              duplicate
            </span>
          )}
        </div>
        <div className="truncate text-xs text-white/35">{entry.clubName}</div>
      </div>

      <ScoreButton
        entry={entry}
        editing={editing}
        saving={saving}
        onStartEdit={onStartEdit}
        onCancel={onCancel}
        onSave={onSave}
      />

      <button
        onClick={onDelete}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white/10 transition-colors hover:bg-red-500/10 hover:text-red-400 group-hover:text-white/25"
        title="Delete entry"
        aria-label={`Delete ${entry.playerName}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CategoryPanel({
  challenge,
  ageGroup,
  entries,
  dupIds,
  onAdd,
}: {
  challenge: ChallengeKey;
  ageGroup: AgeGroup;
  entries: SkillsEntry[];
  dupIds: Set<number>;
  onAdd: () => void;
}) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);

  const ranked = useMemo(() => rankScored(challenge, entries), [challenge, entries]);
  const unscored = useMemo(
    () =>
      entries
        .filter((e) => e.score == null)
        .sort((a, b) => a.playerName.localeCompare(b.playerName)),
    [entries],
  );

  const scoreMut = useMutation({
    mutationFn: ({ id, score }: { id: number; score: string | null; advanceTo: number | null }) =>
      apiRequest("PATCH", `/api/admin/skills-challenge/entries/${id}`, { score }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/leaderboard"] });
      // Jump to the next player still waiting. Correcting an already-scored
      // player just closes the editor — the scorer went there deliberately.
      setEditingId(vars.advanceTo);
    },
    onError: (e: any) => toast({ title: "Score not saved", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/skills-challenge/entries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/entries"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/skills-challenge/leaderboard"] });
      toast({ title: "Entry deleted" });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const save = (entry: SkillsEntry, raw: string) => {
    const trimmed = raw.trim();
    // Where focus lands next: the player after this one in the waiting list.
    const idx = unscored.findIndex((e) => e.id === entry.id);
    const advanceTo = entry.score == null && trimmed !== "" && idx >= 0 ? (unscored[idx + 1]?.id ?? null) : null;

    if (trimmed === "") return scoreMut.mutate({ id: entry.id, score: null, advanceTo: null });
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      return toast({ title: "Score must be a positive number", variant: "destructive" });
    }
    const warn = implausible(challenge, n);
    if (warn && !confirm(`${warn}\n\nSave it anyway?`)) return;
    scoreMut.mutate({ id: entry.id, score: trimmed, advanceTo });
  };

  const total = entries.length;
  const done = ranked.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <section className="flex flex-col rounded-2xl border border-white/5 bg-white/[0.02]">
      <header className="border-b border-white/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-white">{CHALLENGE_LABELS[challenge]}</h2>
              <span className="shrink-0 rounded-md border border-amber-400/25 bg-amber-400/10 px-1.5 py-px text-xs font-bold text-amber-300">
                {ageGroup}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/35">
              {done} of {total} scored
              {challenge === "juggling" ? " · most juggles wins" : " · fastest time wins"}
            </p>
          </div>
          <Button size="sm" variant="ghost" className="shrink-0 text-white/50 hover:text-white" onClick={onAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-amber-400/60 transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </header>

      <div className="flex-1 p-2">
        {total === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-white/25">No players in this category.</p>
        ) : (
          <>
            {ranked.length > 0 && (
              <div className="mb-1">
                {ranked.map(({ entry, rank }) => (
                  <PlayerRow
                    key={entry.id}
                    entry={entry}
                    rank={rank}
                    editing={editingId === entry.id}
                    isDuplicate={dupIds.has(entry.id)}
                    saving={scoreMut.isPending && scoreMut.variables?.id === entry.id}
                    onStartEdit={() => setEditingId(entry.id)}
                    onCancel={() => setEditingId(null)}
                    onSave={(raw) => save(entry, raw)}
                    onDelete={() => {
                      if (confirm(`Delete ${entry.playerName}'s entry?`)) deleteMut.mutate(entry.id);
                    }}
                  />
                ))}
              </div>
            )}

            {unscored.length > 0 && (
              <>
                {ranked.length > 0 && (
                  <div className="my-2 flex items-center gap-2 px-2">
                    <Clock className="h-3 w-3 text-white/20" />
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-white/25">
                      Awaiting score ({unscored.length})
                    </span>
                    <div className="h-px flex-1 bg-white/5" />
                  </div>
                )}
                {unscored.map((entry) => (
                  <PlayerRow
                    key={entry.id}
                    entry={entry}
                    editing={editingId === entry.id}
                    isDuplicate={dupIds.has(entry.id)}
                    saving={scoreMut.isPending && scoreMut.variables?.id === entry.id}
                    onStartEdit={() => setEditingId(entry.id)}
                    onCancel={() => setEditingId(null)}
                    onSave={(raw) => save(entry, raw)}
                    onDelete={() => {
                      if (confirm(`Delete ${entry.playerName}'s entry?`)) deleteMut.mutate(entry.id);
                    }}
                  />
                ))}
              </>
            )}

            {unscored.length === 0 && ranked.length > 0 && (
              <p className="px-2 py-3 text-center text-xs text-amber-300/50">Every player scored.</p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────── Page ───────────────────────────────────────

export default function TournamentSkillsChallenge() {
  const [search, setSearch] = useState("");
  const [dupOnly, setDupOnly] = useState(false);
  const [addFor, setAddFor] = useState<{ ageGroup: AgeGroup; challenge: ChallengeKey } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: entries = [], isLoading } = useQuery<SkillsEntry[]>({
    queryKey: ["/api/admin/skills-challenge/entries"],
    // Tournament day: a second screen showing the standings must not go stale,
    // and the mobile app writes to this same table.
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
  });

  const { ids: dupIds, players: dupPlayers } = useMemo(() => findDuplicates(entries), [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (dupOnly && !dupIds.has(e.id)) return false;
      if (!q) return true;
      return e.playerName.toLowerCase().includes(q) || e.clubName.toLowerCase().includes(q);
    });
  }, [entries, search, dupOnly, dupIds]);

  const scoredCount = entries.filter((e) => e.score != null).length;
  const remaining = entries.length - scoredCount;

  const openAdd = (cat: { ageGroup: AgeGroup; challenge: ChallengeKey } | null) => {
    setAddFor(cat);
    setAddOpen(true);
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold text-white">
            <Zap className="h-6 w-6 text-amber-400" />
            Skills Challenge
          </h1>
          <p className="mt-1 text-sm text-white/40">
            Enter a score and press Enter — it saves and jumps to the next player. Standings update live.
          </p>
        </div>
        <Button onClick={() => openAdd(null)}>
          <Plus className="mr-1.5 h-4 w-4" /> Add a player
        </Button>
      </div>

      {dupPlayers > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-400/20 bg-amber-400/[0.05] p-3 sm:p-4">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <p className="min-w-0 flex-1 text-sm text-amber-100/80">
            <span className="font-semibold text-amber-200">
              {dupPlayers} player{dupPlayers === 1 ? " is" : "s are"} entered twice
            </span>{" "}
            — the same child registered under two spellings of their club. Score one row and delete the other, or
            they'll appear twice in the standings.
          </p>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 text-amber-200 hover:bg-amber-400/10 hover:text-amber-100"
            onClick={() => setDupOnly((v) => !v)}
          >
            {dupOnly ? "Show everyone" : "Show me"}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Registered", value: entries.length, icon: Users },
          { label: "Scored", value: scoredCount, icon: ClipboardCheck },
          { label: "To score", value: remaining, icon: Clock },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-white/5 bg-white/[0.03] p-3 sm:p-4">
            <div className="mb-1 flex items-center gap-1.5 text-xs text-white/40">
              <s.icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{s.label}</span>
            </div>
            <div className="text-2xl font-bold text-white">{s.value}</div>
          </div>
        ))}
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find a player or club…"
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="py-20 text-center text-white/30">Loading players…</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {CATEGORIES.map((cat) => (
            <CategoryPanel
              key={`${cat.challenge}-${cat.ageGroup}`}
              challenge={cat.challenge}
              ageGroup={cat.ageGroup}
              entries={visible.filter((e) => e.challenge === cat.challenge && e.ageGroup === cat.ageGroup)}
              dupIds={dupIds}
              onAdd={() => openAdd(cat)}
            />
          ))}
        </div>
      )}

      {addOpen && <AddEntryModal entries={entries} initial={addFor} onClose={() => setAddOpen(false)} />}
    </div>
  );
}

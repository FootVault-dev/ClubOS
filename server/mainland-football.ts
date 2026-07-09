/**
 * Mainland Football match-centre client — pulls a finished Southern League
 * result for the Play Predictor so nobody has to type it in.
 *
 * Their public widget API (no auth, read-only) exposes, per match id:
 *   /matchcentre/info/{id}      → HomeTeamName, AwayTeamName, HomeScore, AwayScore
 *   /matchcentre/lineUp/{id}    → HomePlayers[]/AwayPlayers[] with PlayerId + names
 *   /matchcentre/timeline/{id}  → minute-stamped events (goals, penalties, own goals, cards, subs)
 *
 * What it CANNOT give us: shots, shots on target, possession, corners. Those are
 * not unpublished — the underlying data-entry system never captures them
 * (verified 2026-07-09 by probing every endpoint variant and decompiling the
 * widget's own Angular bundle). Those four predictor categories therefore stay
 * NULL here and void unless a human records them.
 *
 * Safety rule: this function reconciles the goals it derives from the timeline
 * against the published scoreline. If they disagree it throws rather than
 * writing a half-right result onto a live leaderboard.
 */
import { PREDICTOR_OWN_GOAL, normaliseGoalMinute } from "@shared/predictor-scoring";

const BASE = "https://www.mainlandfootball.co.nz/api/v2/competition/widget/matchcentre";
const CUFC_NAME_MATCH = /christchurch\s+united/i;

/** Event types in the timeline that put a goal on the scoreboard. */
const GOAL_EVENTS = new Set(["Football-Goal", "Football-Penalty"]);
const OWN_GOAL_EVENT = "Football-OwnGoal";

export interface MfPlayer {
  PlayerId: number;
  FirstName?: string;
  LastName?: string;
  ShirtNumber?: string | number | null; // arrives as a string ("7")
  IsGoalkeeper?: boolean;
  IsStarting?: boolean;
}
interface MfLineUp { HomePlayers?: MfPlayer[]; AwayPlayers?: MfPlayer[] }
interface MfInfo { HomeTeamName?: string; AwayTeamName?: string; HomeScore?: number | string; AwayScore?: number | string }
interface MfEvent {
  Minute?: number; StoppageMinute?: number | null; Period?: number;
  PlayerId?: number; EventType?: string; IsHome?: boolean;
}

/**
 * Teamsheets are typed by club admins, so names arrive inconsistently cased:
 * "Mason STEARN", "Nicolas MONTOYA BERRY", "oliver grosso", "Ry MCLEOD".
 *
 * A word is only re-cased when its casing carries no information — all upper or
 * all lower. Genuinely mixed-case names ("Wildash-Chan", "O'Brien") are left as
 * the club typed them. Hyphens and apostrophes start a new word.
 *
 * "Mc" is then fixed unconditionally, because the club also types "Mcleod" —
 * and a surname beginning "Mc" is essentially always "McSomething".
 */
export function formatPlayerName(first?: string, last?: string): string {
  const fix = (word: string): string => {
    if (!/[a-zA-Z]/.test(word)) return word;
    const isAllUpper = word === word.toUpperCase();
    const isAllLower = word === word.toLowerCase();
    const cased = (isAllUpper || isAllLower)
      ? word.toLowerCase().replace(/(^|[-'’])([a-zà-öø-ÿ])/g, (_, sep: string, ch: string) => sep + ch.toUpperCase())
      : word;
    return cased.replace(/^Mc([a-z])/, (_, ch: string) => `Mc${ch.toUpperCase()}`);
  };
  return [first, last]
    .map((part) => String(part ?? "").trim().split(/\s+/).filter(Boolean).map(fix).join(" "))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Coastal Spirit FC " → "Coastal Spirit". Their names carry trailing spaces. */
export function tidyTeamName(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+FC$/i, "").trim();
}

/** Shirt numbers arrive as strings, and sometimes blank. */
export function parseShirtNumber(v: unknown): number | null {
  const n = Number(String(v ?? "").trim());
  return Number.isInteger(n) && n > 0 && n < 100 ? n : null;
}

export interface MainlandFootballResult {
  cufcScore: number;
  opponentScore: number;
  /** United's scorers in the order they scored; PREDICTOR_OWN_GOAL for an opposition own goal. */
  goalscorers: string[];
  /** Minute of United's first goal, stoppage folded to 45/90. Null if United didn't score. */
  firstGoalMinute: number | null;
  opponent: string;
  cufcIsHome: boolean;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Mainland Football ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Scores arrive as strings ("0", "4") when a match has been played and null
 * when it hasn't. Guard the empty cases explicitly: `Number(null)` is 0, which
 * would make every future fixture look like a played 0-0.
 */
function toInt(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Sort events into the order they happened on the pitch. */
function chronological(a: MfEvent, b: MfEvent): number {
  return (a.Period ?? 0) - (b.Period ?? 0)
    || (a.Minute ?? 0) - (b.Minute ?? 0)
    || (a.StoppageMinute ?? 0) - (b.StoppageMinute ?? 0);
}

/**
 * Fetch and reconcile a finished match. Returns null when the match hasn't been
 * published yet; throws when the timeline and the scoreline disagree.
 */
export async function fetchMainlandFootballResult(matchId: string): Promise<MainlandFootballResult | null> {
  const [info, lineUp, timelineRaw] = await Promise.all([
    getJson<MfInfo>(`info/${encodeURIComponent(matchId)}`),
    getJson<MfLineUp>(`lineUp/${encodeURIComponent(matchId)}`),
    getJson<MfEvent[]>(`timeline/${encodeURIComponent(matchId)}`),
  ]);

  const homeScore = toInt(info?.HomeScore);
  const awayScore = toInt(info?.AwayScore);
  if (homeScore == null || awayScore == null) return null; // not played / not published

  const homeName = tidyTeamName(info?.HomeTeamName);
  const awayName = tidyTeamName(info?.AwayTeamName);
  const cufcIsHome = CUFC_NAME_MATCH.test(homeName);
  if (!cufcIsHome && !CUFC_NAME_MATCH.test(awayName)) {
    throw new Error(`Match ${matchId} is ${homeName} v ${awayName} — neither side is Christchurch United.`);
  }

  const cufcScore = cufcIsHome ? homeScore : awayScore;
  const opponentScore = cufcIsHome ? awayScore : homeScore;
  const opponent = cufcIsHome ? awayName : homeName;

  // PlayerId → display name, across both squads. Same formatting as the squad
  // seeder, so a scorer's name matches the name in the picker exactly.
  const names = new Map<number, string>();
  for (const p of [...(lineUp?.HomePlayers ?? []), ...(lineUp?.AwayPlayers ?? [])]) {
    const name = formatPlayerName(p.FirstName, p.LastName);
    if (p.PlayerId != null && name) names.set(p.PlayerId, name);
  }

  const timeline = Array.isArray(timelineRaw) ? [...timelineRaw].sort(chronological) : [];

  // Every event that changed the scoreboard, attributed to the team it scored FOR.
  // An own goal is credited to the opposing team of the player who scored it.
  const scoringEvents = timeline
    .filter((e) => GOAL_EVENTS.has(String(e.EventType)) || String(e.EventType) === OWN_GOAL_EVENT)
    .map((e) => {
      const isOwnGoal = String(e.EventType) === OWN_GOAL_EVENT;
      const playerIsHome = !!e.IsHome;
      const scoredForHome = isOwnGoal ? !playerIsHome : playerIsHome;
      return { event: e, isOwnGoal, scoredForHome };
    });

  const cufcGoals = scoringEvents.filter((g) => g.scoredForHome === cufcIsHome);
  const oppGoals = scoringEvents.filter((g) => g.scoredForHome !== cufcIsHome);

  // Refuse to write a result we can't prove. A mismatch means the timeline is
  // incomplete, or an own goal is attributed the other way round — either way a
  // human must enter it rather than have us guess a leaderboard into existence.
  if (cufcGoals.length !== cufcScore || oppGoals.length !== opponentScore) {
    throw new Error(
      `Mainland Football's timeline doesn't reconcile with the scoreline for match ${matchId}: ` +
      `it published ${cufcScore}-${opponentScore} but the timeline shows ${cufcGoals.length}-${oppGoals.length} ` +
      `goal events. Enter this result by hand.`,
    );
  }

  const goalscorers = cufcGoals.map(({ event, isOwnGoal }) => {
    if (isOwnGoal) return PREDICTOR_OWN_GOAL;
    const name = event.PlayerId != null ? names.get(event.PlayerId) : undefined;
    if (!name) throw new Error(`A United goal in match ${matchId} has no named player. Enter this result by hand.`);
    return name;
  });

  const first = cufcGoals[0]?.event;
  const firstGoalMinute = first ? normaliseGoalMinute(first.Minute, first.StoppageMinute) : null;

  return { cufcScore, opponentScore, goalscorers, firstGoalMinute, opponent, cufcIsHome };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures + teamsheets — used by script/seed-predictor-cufc.ts
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_URL = "https://www.mainlandfootball.co.nz/api/v2/competition/widget/fixture/DatesNoCache";
/** Southern League 2026 (parent competition) · Senior Men grade · Christchurch United FC. */
export const MF_IDS = { compId: 13413, orgId: 9941, gradeId: 705173 } as const;

export interface MfFixture {
  id: string;
  opponent: string;
  cufcIsHome: boolean;
  /** Kickoff as a real instant (their `From` is NZ wall-clock with no offset). */
  kickoffAt: Date;
  venue: string | null;
  played: boolean;
  cufcScore: number | null;
  opponentScore: number | null;
}

/** Offset of a timezone from UTC at a given instant, in milliseconds. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - at.getTime();
}

/**
 * Their `From` is NZ wall-clock time with no offset ("2026-07-11T18:00:00").
 * Resolve it to a real instant, correctly across the NZDT/NZST boundary.
 */
export function nzLocalToInstant(localIso: string): Date {
  const naive = Date.parse(`${localIso.replace(/Z$/, "")}Z`);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - tzOffsetMs(new Date(ts), "Pacific/Auckland");
  return new Date(ts);
}

/** Every Christchurch United fixture in the window, newest last. */
export async function fetchCufcFixtures(fromIso: string, toIso: string): Promise<MfFixture[]> {
  const res = await fetch(FIXTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      CompIds: [MF_IDS.compId], OrgIds: [MF_IDS.orgId], GradeIds: [MF_IDS.gradeId],
      From: fromIso, To: toIso,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Mainland Football fixtures returned ${res.status}`);
  const body = (await res.json()) as { Fixtures?: any[] };
  const fixtures = Array.isArray(body?.Fixtures) ? body.Fixtures : [];

  return fixtures
    .filter((f) => CUFC_NAME_MATCH.test(String(f.HomeTeamName ?? "")) || CUFC_NAME_MATCH.test(String(f.AwayTeamName ?? "")))
    .map((f) => {
      const cufcIsHome = CUFC_NAME_MATCH.test(String(f.HomeTeamName ?? ""));
      const home = toInt(f.HomeScore);
      const away = toInt(f.AwayScore);
      const played = home != null && away != null;
      // "United Sports Centre: United Sports Centre 1" → "United Sports Centre"
      const venue = String(f.VenueName ?? "").split(":")[0].trim() || null;
      return {
        id: String(f.Id),
        opponent: tidyTeamName(cufcIsHome ? f.AwayTeamName : f.HomeTeamName),
        cufcIsHome,
        kickoffAt: nzLocalToInstant(String(f.From)),
        venue,
        played,
        cufcScore: played ? (cufcIsHome ? home : away) : null,
        opponentScore: played ? (cufcIsHome ? away : home) : null,
      };
    })
    .sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime());
}

export interface MfTeamsheetPlayer { name: string; shirtNumber: number | null; isGoalkeeper: boolean }

/** Christchurch United's published teamsheet for one match. */
export async function fetchCufcTeamsheet(matchId: string, cufcIsHome: boolean): Promise<MfTeamsheetPlayer[]> {
  const lineUp = await getJson<MfLineUp>(`lineUp/${encodeURIComponent(matchId)}`);
  const players = (cufcIsHome ? lineUp?.HomePlayers : lineUp?.AwayPlayers) ?? [];
  return players
    .map((p) => ({
      name: formatPlayerName(p.FirstName, p.LastName),
      shirtNumber: parseShirtNumber(p.ShirtNumber),
      isGoalkeeper: !!p.IsGoalkeeper,
    }))
    .filter((p) => p.name.length > 0);
}

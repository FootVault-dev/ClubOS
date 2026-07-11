// Shared live match timer — the "Score Game" clock — used at the top of the
// CIC referee scoring screen (client/src/pages/ref/RefGameDetail.tsx). The
// clock is entirely CLIENT-DERIVED from server fields (timerRunning /
// timerStartedAt / timerBaseSeconds) — this component never owns its own
// running counter, it just re-renders on a 500ms tick and recomputes from
// whatever `game` it was last given. That's what makes it safe across a
// backgrounded tab, a slow network, or a second device watching the same
// game: whoever reads the game row gets the same answer.
//
// Phase state machine (mirrors server/cic-referee-routes.ts
// applyTimerAction()): pre → first_half → half_time → second_half →
// finished. Every action here just posts an action string — the server
// decides the resulting state; this component only reflects it.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { RefGameFull, RefTimerAction, RefTimerPhase } from "@/pages/ref/ref-api";

const GOLD = "#C9A43E";
const INK = "#141511";

interface MatchTimerProps {
  game: RefGameFull;
  halfLengthMinutes: number;
  breakMinutes: number;
  onAction: (action: RefTimerAction) => void;
}

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const PHASE_LABEL: Record<RefTimerPhase, string> = {
  pre: "Pre-Match",
  first_half: "1st Half",
  half_time: "Half-time",
  second_half: "2nd Half",
  finished: "Full Time",
};

export default function MatchTimer({ game, halfLengthMinutes, breakMinutes, onAction }: MatchTimerProps) {
  const phase: RefTimerPhase = (game.timerPhase ?? "pre") as RefTimerPhase;
  const running = !!game.timerRunning;

  // Re-render every 500ms while the clock is actually running — the value
  // itself is always recomputed fresh from `game`, this state is just a
  // heartbeat to force that recomputation.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(iv);
  }, [running, game.timerStartedAt]);

  // A locally-tracked in-flight action, purely for button disable/spinner —
  // cleared as soon as the server's game object actually changes underneath
  // us (a successful mutation refetch), with no fixed timeout needed.
  const [pending, setPending] = useState<RefTimerAction | null>(null);
  useEffect(() => {
    setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.timerPhase, game.timerRunning, game.timerStartedAt, game.timerBaseSeconds, game.status]);

  const fire = (action: RefTimerAction) => {
    if (pending) return;
    setPending(action);
    onAction(action);
  };
  const fireWithConfirm = (action: RefTimerAction, message: string) => {
    if (pending) return;
    if (!window.confirm(message)) return;
    setPending(action);
    onAction(action);
  };

  // ── Derive the clock ──────────────────────────────────────────────────
  let clockText: string | null = null;
  let overtime = false;
  if (phase === "first_half" || phase === "second_half") {
    const base = game.timerBaseSeconds ?? 0;
    const started = game.timerStartedAt ? new Date(game.timerStartedAt).getTime() : null;
    const elapsed = running && started ? base + (Date.now() - started) / 1000 : base;
    const elapsedFloor = Math.max(0, Math.floor(elapsed));
    clockText = fmtClock(elapsedFloor);
    overtime = elapsedFloor >= halfLengthMinutes * 60;
  } else if (phase === "half_time") {
    const started = game.timerStartedAt ? new Date(game.timerStartedAt).getTime() : null;
    const remaining = started ? breakMinutes * 60 - (Date.now() - started) / 1000 : breakMinutes * 60;
    clockText = fmtClock(Math.max(0, remaining));
  }

  const homeScore = game.homeScore ?? 0;
  const awayScore = game.awayScore ?? 0;

  return (
    <section
      className="rounded-2xl p-5 text-center"
      style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}
    >
      <div
        className="text-xs font-bold uppercase tracking-[0.25em] mb-1"
        style={overtime ? { color: "#ef4444" } : running ? { color: GOLD } : { color: "rgba(255,255,255,0.5)" }}
      >
        {running && (phase === "first_half" || phase === "second_half") && (
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current mr-1.5 align-middle animate-pulse" />
        )}
        {PHASE_LABEL[phase]}
      </div>

      {clockText !== null && (
        <div
          className="cic-ref-display text-7xl font-black tabular-nums my-3 leading-none"
          style={{ color: overtime ? "#ef4444" : "white" }}
        >
          {clockText}
        </div>
      )}
      {phase === "half_time" && (
        <p className="mb-4 text-[11px]" style={{ color: "rgba(255,255,255,0.35)" }}>
          Counting down the break — start the 2nd half early or right on the hooter, whichever comes first.
        </p>
      )}

      <div className="mt-1 space-y-2">
        {phase === "pre" && (
          <ActionButton primary label="Start 1st Half" pending={pending === "start_1h"} onClick={() => fire("start_1h")} />
        )}

        {phase === "first_half" && (
          <>
            <ActionButton
              primary
              label="Finish 1st Half"
              pending={pending === "finish_1h"}
              onClick={() => fireWithConfirm("finish_1h", "Finish the 1st half? This starts half-time.")}
            />
            <PauseResumeButton running={running} pending={pending} onClick={() => fire(running ? "pause" : "resume")} />
          </>
        )}

        {phase === "half_time" && (
          <ActionButton primary label="Start 2nd Half" pending={pending === "start_2h"} onClick={() => fire("start_2h")} />
        )}

        {phase === "second_half" && (
          <>
            <ActionButton
              primary
              label="Finish Game"
              pending={pending === "finish_game"}
              onClick={() =>
                fireWithConfirm(
                  "finish_game",
                  `Finish the game — ${homeScore}–${awayScore}? This locks the result in as final.`,
                )
              }
            />
            <PauseResumeButton running={running} pending={pending} onClick={() => fire(running ? "pause" : "resume")} />
          </>
        )}

        {phase === "finished" && (
          <button
            type="button"
            disabled={!!pending}
            onClick={() => fireWithConfirm("reset", "Reopen this game? This undoes Full Time so you can make a correction.")}
            className="text-xs font-semibold disabled:opacity-40"
            style={{ color: "rgba(255,255,255,0.4)" }}
          >
            {pending === "reset" ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : "Reopen"}
          </button>
        )}
      </div>
    </section>
  );
}

function ActionButton({
  label,
  primary,
  pending,
  onClick,
}: {
  label: string;
  primary?: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="w-full h-16 rounded-2xl flex items-center justify-center gap-2 text-lg font-bold active:scale-[0.98] transition disabled:opacity-60"
      style={primary ? { background: GOLD, color: INK } : { background: "rgba(255,255,255,0.05)", color: "white", border: "1px solid rgba(255,255,255,0.12)" }}
    >
      {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : label}
    </button>
  );
}

function PauseResumeButton({
  running,
  pending,
  onClick,
}: {
  running: boolean;
  pending: RefTimerAction | null;
  onClick: () => void;
}) {
  const isPending = pending === "pause" || pending === "resume";
  return (
    <button
      type="button"
      disabled={!!pending}
      onClick={onClick}
      className="w-full h-10 rounded-xl text-xs font-bold disabled:opacity-40"
      style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)" }}
    >
      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : running ? "Pause" : "Resume"}
    </button>
  );
}

// Scan sound cues (spec §8) — three distinct synthesised tones so the operator
// can work by ear and never look up from the shelf.
//
// The distinction that matters is MATCHED vs UNKNOWN: a matched scan needs no
// attention at all, an unknown one means "stop, this needs typing in". Making
// those two sound obviously different is the whole point — a single generic
// beep would mean checking the screen after every garment, which is the thing
// this screen exists to avoid.
//
// Synthesised, not audio files: no asset to 404, no loading delay before the
// first scan of the day, and nothing to add to the bundle.
//
// 🔴 Autoplay policy: a browser refuses to start an AudioContext until the user
// has interacted. A barcode scanner IS a keyboard, so its keystrokes count as a
// gesture — but the FIRST scan of a session can still land before the context
// resumes. Every failure path here is silent by design: a stock take must never
// break because the speaker did not co-operate.

const MUTE_KEY = "wh_scan_sound_muted";

let ctx: AudioContext | null = null;

export function isMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
}

export function setMuted(muted: boolean) {
  try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch { /* private mode — sound just won't persist */ }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    if (!ctx) ctx = new Ctx();
    // Suspended is the normal state before the first gesture, and after a phone
    // locks and wakes. resume() is a promise we deliberately ignore.
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Tie the audio context to the first user gesture. Safe to call repeatedly. */
export function primeAudio() { audio(); }

function tone(steps: { freq: number; at: number; len: number; gain?: number }[], type: OscillatorType = "sine") {
  if (isMuted()) return;
  const c = audio();
  if (!c) return;
  try {
    const now = c.currentTime;
    for (const s of steps) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(s.freq, now + s.at);
      // Ramped, not switched: a square-edged gain change clicks, and a click
      // eight hundred times in an afternoon is genuinely unpleasant.
      const peak = s.gain ?? 0.06;
      gain.gain.setValueAtTime(0.0001, now + s.at);
      gain.gain.exponentialRampToValueAtTime(peak, now + s.at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + s.at + s.len);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(now + s.at);
      osc.stop(now + s.at + s.len + 0.02);
    }
  } catch { /* never let a sound break a count */ }
}

/** Scan matched, quantity incremented — short, bright, ascending. */
export function soundCounted() {
  tone([
    { freq: 880, at: 0, len: 0.07 },
    { freq: 1320, at: 0.06, len: 0.09 },
  ]);
}

/** Unknown barcode, the registration form is opening — lower and deliberately
 *  unlike the counted tone, so it is distinguishable without looking. */
export function soundUnknown() {
  tone([
    { freq: 320, at: 0, len: 0.11, gain: 0.075 },
    { freq: 240, at: 0.1, len: 0.16, gain: 0.075 },
  ], "triangle");
}

/** Saved from the form — a rising three-note chime, distinct from both scans. */
export function soundSaved() {
  tone([
    { freq: 660, at: 0, len: 0.07 },
    { freq: 880, at: 0.06, len: 0.07 },
    { freq: 1180, at: 0.12, len: 0.13 },
  ]);
}

/** Something went wrong — a mis-scan, a failed save. Low and flat. */
export function soundError() {
  tone([{ freq: 180, at: 0, len: 0.22, gain: 0.08 }], "sawtooth");
}

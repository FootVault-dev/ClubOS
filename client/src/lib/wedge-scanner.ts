// Keyboard-wedge barcode scanner detection.
//
// A USB or Bluetooth barcode scanner is not a camera and not a peripheral the
// page can query — it is a KEYBOARD. It types the barcode's characters and
// presses Enter, into whatever happens to have focus. If nothing suitable has
// focus, the scan is simply lost and the hardware looks broken.
//
// So the page listens at the document level and decides, from TIMING alone,
// whether a burst of keystrokes came from a human or a scanner:
//
//   • a scanner emits characters a few milliseconds apart (typically 5–30ms)
//     because it is replaying a buffer;
//   • a human types ~100ms+ apart, and much slower when reading something off.
//
// A burst that arrives fast enough, is long enough to be a real code, and is
// terminated by Enter is treated as a scan. Everything else falls through
// untouched — this must never eat ordinary typing.
//
// Tested by script/test-wedge-scanner.ts.

/** Max gap between two keystrokes for them to count as one machine-fired
 *  burst. 50ms is deliberately generous: cheap scanners over Bluetooth jitter,
 *  and the Enter-terminator plus the length floor already do most of the work
 *  of telling a scan from typing. */
export const MAX_KEY_GAP_MS = 50;

/** Shorter than this and it isn't a barcode — it's someone hitting Enter in a
 *  hurry. Our own SKUs are well above this; the shortest real barcode format
 *  in play (EAN-8) is 8. */
export const MIN_CODE_LENGTH = 3;

export interface WedgeKey {
  key: string;
  /** Milliseconds since the epoch — passed in rather than read inside, so the
   *  logic is testable without faking a clock. */
  at: number;
}

export interface WedgeState {
  buffer: string;
  lastAt: number | null;
}

export const EMPTY_WEDGE: WedgeState = { buffer: "", lastAt: null };

export type WedgeResult =
  | { kind: "buffering"; state: WedgeState }
  | { kind: "scan"; code: string; state: WedgeState }
  /** The burst was terminated but wasn't credible as a scan (too short, or
   *  typed too slowly). The caller does nothing — crucially it does NOT
   *  swallow the keystroke, so a human pressing Enter still behaves normally. */
  | { kind: "discard"; state: WedgeState };

/**
 * Feeds one keystroke through the detector and returns the next state.
 *
 * Pure and clock-free so the timing rule — the only thing standing between
 * "scanner input" and "eating what someone typed" — can be tested exactly.
 */
export function feedWedgeKey(state: WedgeState, ev: WedgeKey): WedgeResult {
  const gap = state.lastAt === null ? Infinity : ev.at - state.lastAt;

  if (ev.key === "Enter") {
    const code = state.buffer;
    // A slow final keystroke means a human pressed Enter after typing, even if
    // the earlier characters arrived quickly.
    const fast = gap <= MAX_KEY_GAP_MS;
    if (code.length >= MIN_CODE_LENGTH && fast) {
      return { kind: "scan", code, state: EMPTY_WEDGE };
    }
    return { kind: "discard", state: EMPTY_WEDGE };
  }

  // Only single printable characters are part of a barcode. Modifiers, arrows,
  // Tab, Backspace and friends end the burst rather than corrupting it.
  if (ev.key.length !== 1) {
    return { kind: "discard", state: EMPTY_WEDGE };
  }

  // Too long a pause means whatever came before was a different burst (or a
  // person). Start again from this character.
  if (gap > MAX_KEY_GAP_MS) {
    return { kind: "buffering", state: { buffer: ev.key, lastAt: ev.at } };
  }

  return { kind: "buffering", state: { buffer: state.buffer + ev.key, lastAt: ev.at } };
}

/**
 * Should the document-level listener ignore this event entirely?
 *
 * Yes whenever the operator is typing into something — a quantity box, a note,
 * a search field. In that case the input receives the scan directly, which is
 * what we want, and hijacking it would double-post or corrupt what they were
 * writing. `isContentEditable` covers rich-text surfaces too.
 */
export function shouldIgnoreWedgeTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

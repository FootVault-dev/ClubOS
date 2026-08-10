// Keep the scan box focused (spec §2) — the operator's hands never leave the
// scanner.
//
// Dima's bar, verbatim: "the operator never has to click back into the scan
// field mid-session." That is a behaviour requirement, not an implementation
// one, and it is harder than it sounds: a button click, a modal closing, a
// toast, a re-render, or a stray tap on the page body all silently move focus,
// and a scanner then types its barcode into nothing.
//
// Two mechanisms, because neither alone is enough:
//   1. Refocus after any pointer interaction that did not land on something
//      that legitimately wants focus.
//   2. A slow poll as a backstop, for every focus loss that is not a click —
//      a closing dialog restoring focus to its trigger, an async re-render, the
//      phone waking up.
//
// 🔴 The poll must NEVER steal focus from a real input. Someone typing a
// quantity, a colour, or a rack code has legitimately taken it, and yanking it
// back mid-word would be worse than the problem being solved. Hence
// holdsFocusLegitimately() — deliberately generous: when in doubt, leave focus
// where it is.
import { useCallback, useEffect, useRef } from "react";

/** Is whatever currently has focus entitled to keep it? */
function holdsFocusLegitimately(el: Element | null, scanEl: HTMLElement | null): boolean {
  if (!el || el === document.body) return false;
  if (el === scanEl) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Anything inside an open dialog — the person is mid-form, and its own
  // autoFocus has usually just placed the caret somewhere deliberate.
  if (el.closest('[role="dialog"], [aria-modal="true"]')) return true;
  return false;
}

export interface ScannerFocusOptions {
  /** Suspend entirely — used while a registration form owns the keyboard. */
  enabled?: boolean;
  /** How often the backstop checks. 1.2s matches the prototype: fast enough to
   *  be invisible between garments, slow enough not to fight a real
   *  interaction. */
  intervalMs?: number;
}

export function useScannerFocus(
  ref: React.RefObject<HTMLInputElement | null>,
  { enabled = true, intervalMs = 1200 }: ScannerFocusOptions = {},
) {
  // Read through a ref inside the listeners so toggling `enabled` never has to
  // tear down and rebuild them mid-count.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const focusScanner = useCallback(() => {
    if (!enabledRef.current) return;
    // rAF so this lands after React has committed whatever just re-rendered —
    // focusing a node that is about to be replaced does nothing.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el || el.disabled) return;
      if (document.activeElement === el) return;
      if (holdsFocusLegitimately(document.activeElement, el)) return;
      el.focus({ preventScroll: true });
    });
  }, [ref]);

  useEffect(() => {
    // pointerup, not click: a click on a <button> fires after focus has already
    // moved, and pointerup covers touch as well as mouse.
    const onPointerUp = () => focusScanner();
    document.addEventListener("pointerup", onPointerUp);
    const timer = window.setInterval(focusScanner, intervalMs);
    // Coming back to the tab, or a phone unlocking, is the single most common
    // way a count loses its cursor.
    const onVisible = () => { if (document.visibilityState === "visible") focusScanner(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    focusScanner();
    return () => {
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, [focusScanner, intervalMs]);

  return focusScanner;
}

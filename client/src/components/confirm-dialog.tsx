// askConfirm() — a promise-based confirmation, in our own modal.
//
// Spec §7 (Dima, 2026-08-10) asks for this by name, and the reason is a real
// bug he hit, not a style preference:
//
//   "confirm() was silently blocked, so the 'New stocktake' button appeared to
//    do nothing (it was correctly hitting the confirm-then-return-early branch,
//    just with an invisible dialog)."
//
// Native dialogs are blocked outright in sandboxed and embedded contexts, vary
// between kiosk browsers, cannot be styled, and freeze the whole page rather
// than the component. A destructive action that silently no-ops is worse than
// one that asks awkwardly.
//
// Deliberately IMPERATIVE and singleton, mirroring how `toast` already works in
// this codebase: that makes replacing an existing `if (confirm(msg))` a
// one-line change at the call site instead of a component refactor —
//
//   if (await askConfirm(`Delete ${sku}?`)) remove.mutate();
//
// A component-scoped hook would have meant restructuring every handler that
// currently calls confirm() inline, which is how these replacements get half
// done and leave native dialogs behind.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";

export interface ConfirmOptions {
  title?: string;
  /** Label on the confirming button. Say what will happen — "Delete", "Zero the
   *  counts" — never "OK", which tells the reader nothing at the moment they
   *  most need telling. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive by default: everything routed through here is a delete or a
   *  reset. Pass false for a merely-significant confirmation. */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

type Listener = (p: PendingConfirm | null) => void;
let listener: Listener | null = null;
let pending: PendingConfirm | null = null;

/**
 * Ask the operator a yes/no question. Resolves true if they confirm.
 *
 * Falls back to resolving FALSE if no host is mounted — a confirmation that
 * cannot be shown must never be treated as a yes.
 */
export function askConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (!listener) {
    console.error("[askConfirm] no <ConfirmHost /> mounted — refusing rather than assuming yes");
    return Promise.resolve(false);
  }
  // One question at a time. A second call while one is open answers the first
  // with "no" rather than silently dropping its promise on the floor, which
  // would leave the caller awaiting forever.
  if (pending) pending.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { message, resolve, ...options };
    listener?.(pending);
  });
}

/** Mounted once, next to <Toaster />. */
export function ConfirmHost() {
  const [current, setCurrent] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    listener = setCurrent;
    return () => { listener = null; };
  }, []);

  const close = (ok: boolean) => {
    current?.resolve(ok);
    pending = null;
    setCurrent(null);
  };

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape cancels. Enter is deliberately NOT bound to confirm: a barcode
      // scanner ends every scan with Enter, so a stray trigger-pull while this
      // is open would confirm a deletion nobody read.
      if (e.key === "Escape") { e.preventDefault(); close(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current || typeof document === "undefined") return null;
  const destructive = current.destructive !== false;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) close(false); }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#12151b] p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          {destructive && (
            <div className="mt-0.5 shrink-0 rounded-lg bg-amber-500/10 p-2">
              <AlertTriangle className="h-4 w-4 text-amber-400" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">
              {current.title ?? "Are you sure?"}
            </h2>
            <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-white/60">
              {current.message}
            </p>
          </div>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => close(false)}>
            {current.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            className={`flex-1 ${destructive ? "bg-red-600 text-white hover:bg-red-500" : ""}`}
            onClick={() => close(true)}
            autoFocus
          >
            {current.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

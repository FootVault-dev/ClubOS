// Scan station (T15, SPEC §4.4/§4.5) — the warehouse operators' home screen.
// Mobile-first, full-screen: scan any code → the server resolves it to an
// item or a location (POST /api/admin/warehouse/scan, T7's resolveScanCode)
// → a big-button action sheet drives the right T4-T11 endpoint. Continuous
// loop: after a movement posts, the camera resumes scanning for the next
// code with no navigation round-trip.
//
// Camera engine (AGENTS.md): a native `window.BarcodeDetector` fast path,
// feature-detected via its OWN `getSupportedFormats()` CONTENTS (never
// `'BarcodeDetector' in window` — some browsers expose the constructor but
// support zero usable formats) — falling back to the `barcode-detector` npm
// ponyfill (ZXing-C++ WASM) whose WASM asset is SELF-HOSTED at
// `/zxing/zxing_reader.wasm` (copied from node_modules/zxing-wasm at build
// time into client/public/zxing/ — see AGENTS.md) rather than the package's
// default jsDelivr CDN locateFile.
//
// State shape, deliberately NOT one big discriminated union (a function
// living inside a union member makes React state comparisons and TS both
// harder to reason about for little benefit here):
//   - `resolved`  — the last code that resolved to something (item/location/
//                   unknown), plus its raw string (so a re-scan of the exact
//                   same label can be told apart from a genuinely new code).
//   - `scanCount` — how many times THIS SAME code has been scanned in a row
//                   since it resolved. For an alias match (a case barcode,
//                   packQty > 1) this drives the default qty via
//                   scanQuantityToUnits — scan a case barcode 4 times, the
//                   next form defaults to 4×packQty eaches, not 4.
//   - `action`    — which action-form is open (null = still on the big-
//                   button action sheet for `resolved`).
//   - `picking`   — a SECOND scan is being collected mid-form (e.g. "scan the
//                   destination bin" for a putaway) — reuses the SAME camera
//                   loop, just dispatches detections differently while set.
// The camera runs whenever `action === null || picking !== null` — i.e.
// paused only while a specific action FORM (not the action sheet itself) is
// showing and no sub-scan has been requested.
//
// Every action form calls exactly one existing (or, for Consume, newly
// added) warehouse endpoint and is responsible for its own qty/location/
// reference inputs — none of this duplicates the movement engine, it only
// assembles the same request bodies the admin pages (T16) will also send.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  MOVEMENT_TYPE_LABELS,
  REASON_CODES,
  REASON_CODE_LABELS,
  CONDITION_GRADES,
  CONDITION_GRADE_LABELS,
  scanQuantityToUnits,
  type MovementType,
  type ReasonCode,
  type ConditionGrade,
} from "@shared/warehouse";
import type { PrintOrder } from "@shared/schema";
import {
  Camera,
  CameraOff,
  Flashlight,
  FlashlightOff,
  X,
  ChevronLeft,
  Keyboard,
  Loader2,
  PackagePlus,
  ArrowRightLeft,
  PackageMinus,
  ClipboardList,
  ArrowDownToLine,
  HandCoins,
  Undo2,
  Boxes,
  Truck,
  AlertTriangle,
  CheckCircle2,
  ScanLine,
  Search,
  ShoppingCart,
  CloudOff,
  RefreshCw,
} from "lucide-react";
import {
  enqueueSale, flushSales, mintSaleKey, pendingSales, removeSale, type PendingSale,
} from "@/lib/warehouse-offline-queue";
import {
  feedWedgeKey, shouldIgnoreWedgeTarget, EMPTY_WEDGE, type WedgeState,
} from "@/lib/wedge-scanner";

// ── Types (mirror server/warehouse.ts's ScanResolution — client can't import
// server/* code, so the JSON shape is redeclared here) ──────────────────────

interface ScanResolvedItem {
  id: number;
  sku: string;
  name: string;
  isLoanable: boolean;
}
interface ScanResolvedLocation {
  id: number;
  code: string;
  kind: "bin" | "zone" | "virtual";
}
interface ScanResolvedInstance {
  id: number;
  assetTag: string | null;
  serialNumber: string | null;
  condition: string;
  itemId: number;
  itemSku: string;
  itemName: string;
  isLoanable: boolean;
  locationId: number;
  locationCode: string;
}
type ScanResolution =
  | { kind: "item"; item: ScanResolvedItem; matchedVia: "sku" | "alias"; aliasCode?: string; packQty: number; actions: MovementType[] }
  | { kind: "location"; location: ScanResolvedLocation; actions: MovementType[] }
  | { kind: "instance"; instance: ScanResolvedInstance; actions: MovementType[] }
  | { kind: "unknown"; rawCode: string };

type ActionKey =
  | "receipt" | "putaway" | "transfer" | "pick" | "dispatch" | "consume"
  | "loan_out" | "loan_return" | "count" | "sale";

const ACTION_META: Record<ActionKey, { label: string; icon: any; blurb: string }> = {
  receipt: { label: "Receive", icon: ArrowDownToLine, blurb: "Log stock arriving against a purchase order" },
  putaway: { label: "Putaway", icon: PackagePlus, blurb: "Move it into its home bin" },
  transfer: { label: "Transfer", icon: ArrowRightLeft, blurb: "Move stock between bins" },
  pick: { label: "Pick", icon: ClipboardList, blurb: "Pick against an approved requisition" },
  dispatch: { label: "Dispatch", icon: Truck, blurb: "Fulfil a paid order" },
  consume: { label: "Consume", icon: PackageMinus, blurb: "Use stock against a print job" },
  loan_out: { label: "Loan out", icon: HandCoins, blurb: "Check equipment out to a borrower" },
  loan_return: { label: "Return", icon: Undo2, blurb: "Check equipment back in" },
  count: { label: "Count", icon: Boxes, blurb: "Enter a counted quantity for this bin" },
  // D25 — someone buys it over the desk. Unlike Dispatch there is no order
  // behind it: the movement IS the record of the sale.
  sale: { label: "Sell", icon: ShoppingCart, blurb: "Sell it over the counter — works offline" },
};

/** Advisory action list for a resolved code — server's scanActionsForItem/
 *  scanActionsForLocation drive most of it; "receipt" is added client-side
 *  for items only (T7's advisory lists never included it — receiving is
 *  PO+item driven, not itself a MovementType any scan-actions helper
 *  offers), and any MovementType with no ACTION_META entry (e.g. the
 *  bare taxonomy value "adjustment") is dropped rather than rendered blank. */
function actionsFor(resolution: ScanResolution): ActionKey[] {
  if (resolution.kind === "item") {
    const rest = resolution.actions.filter((a): a is ActionKey => a in ACTION_META);
    return ["receipt", ...rest];
  }
  if (resolution.kind === "location") {
    return resolution.actions.filter((a): a is ActionKey => a in ACTION_META);
  }
  return [];
}

// ── Audio + haptic confirm ───────────────────────────────────────────────────

function beep(kind: "ok" | "err" = "ok") {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = kind === "ok" ? 880 : 200;
    const dur = kind === "ok" ? 0.12 : 0.3;
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + dur);
    osc.onended = () => ctx.close();
  } catch {
    // best-effort — silence is fine, it's never the only feedback (vibrate + UI)
  }
}

function hapticBuzz(kind: "ok" | "err" = "ok") {
  if (typeof navigator !== "undefined" && navigator.vibrate) {
    navigator.vibrate(kind === "ok" ? 60 : [80, 60, 80]);
  }
}

function confirmFeedback(kind: "ok" | "err" = "ok") {
  beep(kind);
  hapticBuzz(kind);
}

// ── Barcode detector loading (native fast-path, self-hosted WASM fallback) ──

const WANTED_FORMATS = ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar"] as const;

interface DetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

let detectorPromise: Promise<{ detector: DetectorLike; engine: "native" | "wasm" }> | null = null;

async function loadDetector(): Promise<{ detector: DetectorLike; engine: "native" | "wasm" }> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const NativeCtor = (window as any).BarcodeDetector;
      if (typeof NativeCtor === "function" && typeof NativeCtor.getSupportedFormats === "function") {
        try {
          const supported: string[] = await NativeCtor.getSupportedFormats();
          const usable = WANTED_FORMATS.filter((f) => supported.includes(f));
          if (usable.length > 0) {
            return { detector: new NativeCtor({ formats: usable }) as DetectorLike, engine: "native" as const };
          }
        } catch {
          // fall through to the ponyfill
        }
      }
      const mod = await import("barcode-detector/pure");
      mod.setZXingModuleOverrides({ locateFile: (path: string) => `/zxing/${path}` });
      const detector = new mod.BarcodeDetector({ formats: [...WANTED_FORMATS] as any }) as unknown as DetectorLike;
      return { detector, engine: "wasm" as const };
    })();
  }
  return detectorPromise;
}

// ── Camera hook — one getUserMedia stream, reused for the idle loop AND any
// mid-form "scan a second code" sub-flow (starting a new stream every time a
// form opens is slow and flickers on mobile Safari). ────────────────────────

function useCamera(active: boolean, onDetect: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  const [status, setStatus] = useState<"idle" | "starting" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<"native" | "wasm" | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setStatus("idle");
      setTorchOn(false);
      return;
    }

    setStatus("starting");
    setError(null);

    (async () => {
      try {
        const { detector, engine: loadedEngine } = await loadDetector();
        if (cancelled) return;
        setEngine(loadedEngine);

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities ? (track.getCapabilities() as any) : {};
        setTorchSupported(!!caps?.torch);

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus("running");

        let busy = false;
        intervalRef.current = setInterval(async () => {
          if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
          busy = true;
          try {
            const results = await detector.detect(videoRef.current);
            if (results.length > 0 && results[0].rawValue) {
              onDetectRef.current(results[0].rawValue);
            }
          } catch {
            // a transient decode failure (frame mid-transition) — just try again next tick
          } finally {
            busy = false;
          }
        }, 300);
      } catch (e: any) {
        if (!cancelled) {
          setStatus("error");
          setError(e?.message || "Couldn't access the camera");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [active]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn((v) => !v);
    } catch {
      // torch toggle isn't universally reliable — fail silently, button stays visible
    }
  }, [torchOn]);

  return { videoRef, status, error, engine, torchSupported, torchOn, toggleTorch };
}

// ── Small shared UI ───────────────────────────────────────────────────────────

function errMsg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed?.message) return String(parsed.message);
  } catch {
    // not JSON — use the raw text
  }
  return body || raw;
}

function ActionButton({ actionKey, onClick }: { actionKey: ActionKey; onClick: () => void }) {
  const meta = ACTION_META[actionKey];
  const Icon = meta.icon;
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-4 rounded-2xl bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] active:scale-[0.98] transition text-left"
    >
      <div className="w-11 h-11 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5 text-blue-400" />
      </div>
      <div className="min-w-0">
        <div className="text-white font-semibold">{meta.label}</div>
        <div className="text-white/40 text-xs truncate">{meta.blurb}</div>
      </div>
    </button>
  );
}

function FormShell({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-4 border-b border-white/10 flex-shrink-0">
        <button onClick={onBack} className="p-2 -ml-2 rounded-lg hover:bg-white/10 text-white/70">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h2 className="text-white font-bold text-lg">{title}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-white/40 mb-1.5">{label}</div>
      {children}
    </label>
  );
}

const inputCls =
  "w-full px-3 py-3 rounded-xl bg-white/[0.04] border border-white/10 text-white placeholder:text-white/25 focus:outline-none focus:border-blue-500/60 text-base";

function NumberField({ value, onChange, min = 0, step = "any" }: { value: number; onChange: (v: number) => void; min?: number; step?: string }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      className={inputCls}
      value={Number.isFinite(value) ? value : ""}
      min={min}
      step={step}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
    />
  );
}

function SubmitError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>{errMsg(error)}</span>
    </div>
  );
}

function SubmitButton({ onClick, disabled, loading, label }: { onClick: () => void; disabled?: boolean; loading?: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="w-full py-3.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold flex items-center justify-center gap-2 text-base"
    >
      {loading && <Loader2 className="w-4 h-4 animate-spin" />}
      {label}
    </button>
  );
}

/** A location field: pick from a searchable dropdown of real (non-virtual)
 *  locations, or scan a bin label directly — both write into the same value. */
function LocationPicker({
  value,
  onChange,
  onScanRequest,
  scanning,
  excludeId,
}: {
  value: ScanResolvedLocation | null;
  onChange: (loc: ScanResolvedLocation) => void;
  onScanRequest: () => void;
  scanning: boolean;
  excludeId?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: locations = [] } = useQuery<ScanResolvedLocation[]>({
    queryKey: ["/api/admin/warehouse/locations", "picker"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations?active=true")).json(),
  });
  const options = useMemo(
    () =>
      locations
        .filter((l) => l.kind !== "virtual" && l.id !== excludeId)
        .filter((l) => !q.trim() || l.code.toLowerCase().includes(q.trim().toLowerCase())),
    [locations, q, excludeId],
  );

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`flex-1 px-3 py-3 rounded-xl border text-left text-base ${
            value ? "bg-white/[0.06] border-white/15 text-white" : "bg-white/[0.02] border-white/10 text-white/40"
          }`}
        >
          {value ? value.code : "Choose a bin..."}
        </button>
        <button
          onClick={onScanRequest}
          disabled={scanning}
          className="px-4 rounded-xl bg-blue-600/20 border border-blue-500/30 text-blue-300 disabled:opacity-40"
        >
          {scanning ? <Loader2 className="w-5 h-5 animate-spin" /> : <ScanLine className="w-5 h-5" />}
        </button>
      </div>
      {open && (
        <div className="rounded-xl border border-white/10 bg-black/60 p-2 space-y-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
            <input
              className="w-full pl-8 pr-2 py-2 rounded-lg bg-white/[0.04] border border-white/10 text-white text-sm"
              placeholder="Search bin code..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {options.length === 0 && <div className="text-white/30 text-sm text-center py-3">No bins found</div>}
            {options.map((l) => (
              <button
                key={l.id}
                onClick={() => {
                  onChange(l);
                  setOpen(false);
                  setQ("");
                }}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/[0.06] text-white text-sm font-mono"
              >
                {l.code}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Counter sale (D25) ───────────────────────────────────────────────────────
// The one action that must work with no network. The idempotency key is minted
// BEFORE the request goes out and stored with the queued row, so a sale posted
// twice — because the response was lost, not because the request failed — is a
// no-op server-side rather than a second shirt off the shelf.

async function postSale(body: Record<string, unknown>) {
  const res = await apiRequest("POST", "/api/admin/warehouse/sale", body);
  let payload: any = {};
  try {
    payload = await res.json();
  } catch {
    /* a 204/empty body is still a success */
  }
  return { ok: res.ok, status: res.status, replayed: payload?.replayed === true, message: payload?.message };
}

function SaleForm({
  item,
  defaultQty,
  onQueueChange,
  ...common
}: FormCommonProps & { item: ScanResolvedItem; defaultQty: number; onQueueChange: () => void }) {
  const { toast } = useToast();
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);
  const [qty, setQty] = useState(defaultQty);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!location) return;
    setBusy(true);
    setError(null);

    const idempotencyKey = mintSaleKey(item.id, location.id);
    const sale = {
      idempotencyKey,
      itemId: item.id,
      itemSku: item.sku,
      locationId: location.id,
      locationCode: location.code,
      qty,
    };

    // Offline is known up front — don't even try, just bank it. Trying first
    // would make the operator wait out a timeout with a customer in front of
    // them, which is the exact thing this feature exists to avoid.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      enqueueSale(sale);
      onQueueChange();
      confirmFeedback("ok");
      toast({ title: "Sale saved offline", description: `${qty} × ${item.sku} — it'll post when you're back online.` });
      setBusy(false);
      common.onDone();
      return;
    }

    try {
      const res = await postSale({ ...sale, itemSku: undefined });
      if (res.ok) {
        confirmFeedback("ok");
        toast({
          title: res.replayed ? "Already recorded" : "Sale posted",
          description: `${qty} × ${item.sku} from ${location.code}`,
        });
        common.onDone();
      } else if (res.status >= 500 || res.status === 408 || res.status === 429) {
        // The server is there but struggling — queue rather than lose it.
        enqueueSale(sale);
        onQueueChange();
        confirmFeedback("ok");
        toast({ title: "Sale queued", description: "The server was busy — it'll retry automatically." });
        common.onDone();
      } else {
        confirmFeedback("err");
        setError(new Error(res.message || "That sale was refused."));
      }
    } catch (e: any) {
      // The request never completed. It MIGHT have reached the server, so the
      // stored key is what makes retrying safe.
      enqueueSale(sale);
      onQueueChange();
      confirmFeedback("ok");
      toast({ title: "Sale saved offline", description: `${qty} × ${item.sku} — it'll post when the connection returns.` });
      common.onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormShell title={`Sell — ${item.sku}`} onBack={common.onCancel}>
      <Field label="Out of which bin">
        <LocationPicker
          value={location}
          onChange={setLocation}
          onScanRequest={() => common.requestScan(setLocation)}
          scanning={common.picking}
        />
      </Field>
      <Field label="Quantity">
        <NumberField value={qty} onChange={setQty} step="1" />
      </Field>
      <SubmitError error={error} />
      <SubmitButton onClick={submit} disabled={!location || qty <= 0} loading={busy} label="Record sale" />
    </FormShell>
  );
}

/** The pending-sales strip. Shown only when something is actually waiting, so
 *  it is never chrome the operator learns to ignore. */
function PendingSalesBar({ rows, onChange }: { rows: PendingSale[]; onChange: () => void }) {
  const { toast } = useToast();
  const [flushing, setFlushing] = useState(false);

  const flush = async () => {
    setFlushing(true);
    const r = await flushSales(postSale);
    onChange();
    setFlushing(false);
    if (r.posted || r.replayed) {
      toast({
        title: `${r.posted + r.replayed} sale(s) synced`,
        description: r.replayed ? `${r.replayed} had already been recorded.` : undefined,
      });
    }
    if (r.failed) {
      toast({
        title: `${r.failed} sale(s) couldn't be posted`,
        description: "They were refused by the server and have been dropped — re-enter them.",
        variant: "destructive",
      });
    }
  };

  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CloudOff className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-xs text-amber-200/90 truncate">
            {rows.length} sale{rows.length === 1 ? "" : "s"} waiting to post
          </span>
        </div>
        <button
          onClick={flush}
          disabled={flushing}
          className="px-2.5 py-1.5 rounded-lg text-[11px] text-amber-100 bg-amber-500/15 hover:bg-amber-500/25 flex items-center gap-1.5 shrink-0"
        >
          <RefreshCw className={`w-3 h-3 ${flushing ? "animate-spin" : ""}`} /> Send now
        </button>
      </div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.idempotencyKey} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-white/60 truncate">
              {r.qty} × {r.itemSku} <span className="text-white/30">from {r.locationCode}</span>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-white/30">{new Date(r.queuedAt).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit" })}</span>
              {r.attempts > 0 && <span className="text-amber-400/70">{r.attempts} tr{r.attempts === 1 ? "y" : "ies"}</span>}
              <button
                onClick={() => { removeSale(r.idempotencyKey); onChange(); }}
                className="text-white/25 hover:text-red-400"
                title="Discard this queued sale"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Action forms ──────────────────────────────────────────────────────────────

interface FormCommonProps {
  onDone: () => void;
  onCancel: () => void;
  requestScan: (onPick: (loc: ScanResolvedLocation) => void) => void;
  picking: boolean;
}

function PutawayTransferForm({
  kind,
  item,
  defaultQty,
  ...common
}: FormCommonProps & { kind: "putaway" | "transfer"; item: ScanResolvedItem; defaultQty: number }) {
  const { toast } = useToast();
  const [from, setFrom] = useState<ScanResolvedLocation | null>(null);
  const [to, setTo] = useState<ScanResolvedLocation | null>(null);
  const [qty, setQty] = useState(defaultQty);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/admin/warehouse/${kind}`, {
          itemId: item.id,
          fromLocationId: from?.id,
          toLocationId: to?.id,
          qty,
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: `${ACTION_META[kind].label} posted`, description: `${qty} × ${item.sku}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`${ACTION_META[kind].label} — ${item.sku}`} onBack={common.onCancel}>
      <Field label="From bin">
        <LocationPicker
          value={from}
          onChange={setFrom}
          onScanRequest={() => common.requestScan(setFrom)}
          scanning={common.picking}
          excludeId={to?.id}
        />
      </Field>
      <Field label="To bin">
        <LocationPicker
          value={to}
          onChange={setTo}
          onScanRequest={() => common.requestScan(setTo)}
          scanning={common.picking}
          excludeId={from?.id}
        />
      </Field>
      <Field label="Quantity">
        <NumberField value={qty} onChange={setQty} step="0.001" />
      </Field>
      <SubmitError error={mutation.error} />
      <SubmitButton
        onClick={() => mutation.mutate()}
        disabled={!from || !to || qty <= 0}
        loading={mutation.isPending}
        label={`Post ${ACTION_META[kind].label.toLowerCase()}`}
      />
    </FormShell>
  );
}

function ConsumeForm({ item, defaultQty, ...common }: FormCommonProps & { item: ScanResolvedItem; defaultQty: number }) {
  const { toast } = useToast();
  const { currentOrg } = useWorkspace();
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);
  const [qty, setQty] = useState(defaultQty);
  const [printOrder, setPrintOrder] = useState<PrintOrder | null>(null);
  const [poQuery, setPoQuery] = useState("");
  const [reasonCode, setReasonCode] = useState<ReasonCode | "">("");

  const orgId = currentOrg?.id;
  const { data: printOrders = [], isLoading: loadingOrders } = useQuery<PrintOrder[]>({
    queryKey: ["/api/admin/print-orders", { orgId }],
    queryFn: async () => (await apiRequest("GET", `/api/admin/print-orders?orgId=${orgId}`)).json(),
    enabled: !!orgId,
  });
  const openOrders = useMemo(
    () =>
      printOrders
        .filter((o: any) => o.status !== "cancelled")
        .filter((o: any) => {
          const term = poQuery.trim().toLowerCase();
          if (!term) return true;
          return (o.orderNumber ?? "").toLowerCase().includes(term) || (o.title ?? "").toLowerCase().includes(term) || (o.customerName ?? "").toLowerCase().includes(term);
        }),
    [printOrders, poQuery],
  );

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/admin/warehouse/consume", {
          itemId: item.id,
          locationId: location?.id,
          qty,
          printOrderId: printOrder?.id,
          reasonCode: reasonCode || undefined,
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: "Consume posted", description: `${qty} × ${item.sku} against ${printOrder?.orderNumber ?? "print job"}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`Consume — ${item.sku}`} onBack={common.onCancel}>
      <Field label="From bin">
        <LocationPicker value={location} onChange={setLocation} onScanRequest={() => common.requestScan(setLocation)} scanning={common.picking} />
      </Field>
      <Field label="Quantity">
        <NumberField value={qty} onChange={setQty} step="0.001" />
      </Field>
      <Field label="Print job">
        {printOrder ? (
          <div className="flex items-center justify-between px-3 py-3 rounded-xl bg-white/[0.06] border border-white/15">
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold truncate">{printOrder.orderNumber ?? `#${printOrder.id}`}</div>
              <div className="text-white/40 text-xs truncate">{printOrder.title}</div>
            </div>
            <button onClick={() => setPrintOrder(null)} className="text-white/40 hover:text-white p-1">
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              className={inputCls}
              placeholder="Search order number, title, customer..."
              value={poQuery}
              onChange={(e) => setPoQuery(e.target.value)}
            />
            <div className="max-h-44 overflow-y-auto rounded-xl border border-white/10 divide-y divide-white/5">
              {loadingOrders && <div className="text-white/30 text-sm text-center py-4">Loading...</div>}
              {!loadingOrders && openOrders.length === 0 && <div className="text-white/30 text-sm text-center py-4">No print orders found</div>}
              {openOrders.slice(0, 30).map((o: any) => (
                <button key={o.id} onClick={() => setPrintOrder(o)} className="w-full text-left px-3 py-2.5 hover:bg-white/[0.06]">
                  <div className="text-white text-sm font-semibold">{o.orderNumber ?? `#${o.id}`}</div>
                  <div className="text-white/40 text-xs truncate">
                    {o.title} — {o.customerName}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </Field>
      <Field label="Reason (optional)">
        <select className={inputCls} value={reasonCode} onChange={(e) => setReasonCode(e.target.value as ReasonCode | "")}>
          <option value="">— none —</option>
          {REASON_CODES.map((r) => (
            <option key={r} value={r}>
              {REASON_CODE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <SubmitError error={mutation.error} />
      <SubmitButton onClick={() => mutation.mutate()} disabled={!location || !printOrder || qty <= 0} loading={mutation.isPending} label="Post consume" />
    </FormShell>
  );
}

function ReceiveForm({ item, ...common }: FormCommonProps & { item: ScanResolvedItem }) {
  const { toast } = useToast();
  const [poQuery, setPoQuery] = useState("");
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);
  const [qtyGood, setQtyGood] = useState(0);
  const [qtyDamaged, setQtyDamaged] = useState(0);

  const { data: pos = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/warehouse/pos", "receivable"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/pos")).json(),
  });
  const receivable = useMemo(
    () =>
      pos
        .filter((p) => p.status === "sent" || p.status === "partial" || p.status === "received")
        .filter((p) => {
          const term = poQuery.trim().toLowerCase();
          if (!term) return true;
          return (p.supplierName ?? "").toLowerCase().includes(term) || String(p.id).includes(term);
        }),
    [pos, poQuery],
  );

  const { data: poDetail } = useQuery<any>({
    queryKey: ["/api/admin/warehouse/pos", selectedPoId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/pos/${selectedPoId}`)).json(),
    enabled: selectedPoId !== null,
  });
  const matchingLine = useMemo(() => poDetail?.lines?.find((l: any) => l.itemId === item.id) ?? null, [poDetail, item.id]);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/admin/warehouse/pos/${selectedPoId}/receive`, {
          poLineId: matchingLine?.id,
          qtyGood,
          qtyDamaged,
          locationId: location?.id,
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: "Receipt posted", description: `${qtyGood} good / ${qtyDamaged} damaged × ${item.sku}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`Receive — ${item.sku}`} onBack={common.onCancel}>
      {selectedPoId === null ? (
        <>
          <Field label="Purchase order">
            <input
              className={inputCls}
              placeholder="Search supplier or PO #..."
              value={poQuery}
              onChange={(e) => setPoQuery(e.target.value)}
              autoFocus
            />
          </Field>
          <div className="rounded-xl border border-white/10 divide-y divide-white/5">
            {receivable.length === 0 && <div className="text-white/30 text-sm text-center py-6">No open purchase orders</div>}
            {receivable.slice(0, 30).map((p) => (
              <button key={p.id} onClick={() => setSelectedPoId(p.id)} className="w-full text-left px-3 py-3 hover:bg-white/[0.06]">
                <div className="text-white text-sm font-semibold">
                  PO #{p.id} — {p.supplierName}
                </div>
                <div className="text-white/40 text-xs">{p.status} · {p.lineCount} line(s)</div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button onClick={() => setSelectedPoId(null)} className="text-blue-400 text-sm">
            ← Choose a different PO
          </button>
          {!poDetail ? (
            <div className="flex justify-center py-6 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : !matchingLine ? (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>PO #{selectedPoId} doesn't have a line for {item.sku} — pick a different PO, or add the line in the Purchase Orders admin page.</span>
            </div>
          ) : (
            <>
              <div className="text-white/50 text-sm">
                {item.sku} — ordered {matchingLine.qtyOrdered}, {matchingLine.qtyRemaining} remaining
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Good qty">
                  <NumberField value={qtyGood} onChange={setQtyGood} step="0.001" />
                </Field>
                <Field label="Damaged qty">
                  <NumberField value={qtyDamaged} onChange={setQtyDamaged} step="0.001" />
                </Field>
              </div>
              {qtyGood > 0 && (
                <Field label="Location for good stock">
                  <LocationPicker value={location} onChange={setLocation} onScanRequest={() => common.requestScan(setLocation)} scanning={common.picking} />
                </Field>
              )}
              {qtyDamaged > 0 && <div className="text-white/40 text-xs">Damaged stock goes to QUARANTINE automatically.</div>}
              <SubmitError error={mutation.error} />
              <SubmitButton
                onClick={() => mutation.mutate()}
                disabled={(qtyGood <= 0 && qtyDamaged <= 0) || (qtyGood > 0 && !location)}
                loading={mutation.isPending}
                label="Post receipt"
              />
            </>
          )}
        </>
      )}
    </FormShell>
  );
}

function PickDispatchForm({ restrict, item, ...common }: FormCommonProps & { restrict: "pick" | "dispatch"; item: ScanResolvedItem }) {
  const { toast } = useToast();
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);
  const [selected, setSelected] = useState<{ sourceKind: "requisition" | "shop_order" | "shopify_order"; sourceId: number; label: string; maxQty: number } | null>(null);
  const [qty, setQty] = useState(0);

  const { data: queue } = useQuery<{
    nativeOrders: Array<{ sourceKind: "shop_order"; orderId: number; orderNumber: string; customerName: string; items: Array<{ itemId: number; qty: number }> }>;
    shopifyOrders: Array<{ sourceKind: "shopify_order"; orderId: number; items: Array<{ itemId: number; qty: number }> }>;
    requisitions: Array<{ sourceKind: "requisition"; requisitionId: number; chargeTo: string; requestedBy: string | null; items: Array<{ itemId: number; qtyRemaining: number }> }>;
  }>({
    queryKey: ["/api/admin/warehouse/pick-queue"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/pick-queue")).json(),
  });

  const candidates = useMemo(() => {
    if (!queue) return [];
    if (restrict === "pick") {
      return queue.requisitions
        .filter((r) => r.items.some((i) => i.itemId === item.id))
        .map((r) => {
          const line = r.items.find((i) => i.itemId === item.id)!;
          return { sourceKind: "requisition" as const, sourceId: r.requisitionId, label: `Requisition #${r.requisitionId} — ${r.chargeTo}`, maxQty: line.qtyRemaining };
        });
    }
    const native = queue.nativeOrders
      .filter((o) => o.items.some((i) => i.itemId === item.id))
      .map((o) => {
        const line = o.items.find((i) => i.itemId === item.id)!;
        return { sourceKind: "shop_order" as const, sourceId: o.orderId, label: `Order ${o.orderNumber} — ${o.customerName}`, maxQty: line.qty };
      });
    const shopify = queue.shopifyOrders
      .filter((o) => o.items.some((i) => i.itemId === item.id))
      .map((o) => {
        const line = o.items.find((i) => i.itemId === item.id)!;
        return { sourceKind: "shopify_order" as const, sourceId: o.orderId, label: `Shopify order #${o.orderId}`, maxQty: line.qty };
      });
    return [...native, ...shopify];
  }, [queue, restrict, item.id]);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/admin/warehouse/dispatch", {
          sourceKind: selected?.sourceKind,
          sourceId: selected?.sourceId,
          itemId: item.id,
          locationId: location?.id,
          qty,
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: `${ACTION_META[restrict].label} posted`, description: `${qty} × ${item.sku}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`${ACTION_META[restrict].label} — ${item.sku}`} onBack={common.onCancel}>
      {!selected ? (
        <div className="rounded-xl border border-white/10 divide-y divide-white/5">
          {!queue && (
            <div className="flex justify-center py-6 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
          {queue && candidates.length === 0 && <div className="text-white/30 text-sm text-center py-6">Nothing pending for {item.sku}</div>}
          {candidates.map((c) => (
            <button
              key={`${c.sourceKind}:${c.sourceId}`}
              onClick={() => {
                setSelected(c);
                setQty(c.maxQty);
              }}
              className="w-full text-left px-3 py-3 hover:bg-white/[0.06]"
            >
              <div className="text-white text-sm font-semibold">{c.label}</div>
              <div className="text-white/40 text-xs">{c.maxQty} remaining</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <button onClick={() => setSelected(null)} className="text-blue-400 text-sm">
            ← Choose a different order
          </button>
          <div className="text-white/70 text-sm">{selected.label}</div>
          <Field label="Quantity">
            <NumberField value={qty} onChange={setQty} step="0.001" />
          </Field>
          <Field label="From bin">
            <LocationPicker value={location} onChange={setLocation} onScanRequest={() => common.requestScan(setLocation)} scanning={common.picking} />
          </Field>
          <SubmitError error={mutation.error} />
          <SubmitButton
            onClick={() => mutation.mutate()}
            disabled={!location || qty <= 0 || qty > selected.maxQty}
            loading={mutation.isPending}
            label={`Post ${ACTION_META[restrict].label.toLowerCase()}`}
          />
        </>
      )}
    </FormShell>
  );
}

function LoanOutForm({ item, ...common }: FormCommonProps & { item: ScanResolvedItem }) {
  const { toast } = useToast();
  const [borrowerName, setBorrowerName] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [qty, setQty] = useState(1);
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/admin/warehouse/loans", {
          borrowerName,
          dueOn,
          lines: [{ itemId: item.id, qty, locationId: location?.id }],
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: "Loan checked out", description: `${qty} × ${item.sku} to ${borrowerName}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`Loan out — ${item.sku}`} onBack={common.onCancel}>
      <Field label="Borrower name">
        <input className={inputCls} value={borrowerName} onChange={(e) => setBorrowerName(e.target.value)} placeholder="Who's taking it?" autoFocus />
      </Field>
      <Field label="Due back">
        <input type="date" className={inputCls} value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
      </Field>
      <Field label="Quantity">
        <NumberField value={qty} onChange={setQty} step="1" />
      </Field>
      <Field label="From bin">
        <LocationPicker value={location} onChange={setLocation} onScanRequest={() => common.requestScan(setLocation)} scanning={common.picking} />
      </Field>
      <SubmitError error={mutation.error} />
      <SubmitButton
        onClick={() => mutation.mutate()}
        disabled={!borrowerName.trim() || !dueOn || qty <= 0 || !location}
        loading={mutation.isPending}
        label="Check out"
      />
    </FormShell>
  );
}

function LoanReturnForm({ item, ...common }: FormCommonProps & { item: ScanResolvedItem }) {
  const { toast } = useToast();
  const [selectedLoanId, setSelectedLoanId] = useState<number | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<number | null>(null);
  const [location, setLocation] = useState<ScanResolvedLocation | null>(null);
  const [grade, setGrade] = useState<ConditionGrade | "">("");
  const [note, setNote] = useState("");

  const { data: openLoans = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/warehouse/loans", "out"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/loans?status=out")).json(),
  });
  const { data: loanDetail } = useQuery<any>({
    queryKey: ["/api/admin/warehouse/loans", selectedLoanId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/loans/${selectedLoanId}`)).json(),
    enabled: selectedLoanId !== null,
  });
  const ungradedLines = useMemo(() => (loanDetail?.lines ?? []).filter((l: any) => l.conditionGrade == null), [loanDetail]);
  const preselectLine = useMemo(() => ungradedLines.find((l: any) => l.itemId === item.id) ?? null, [ungradedLines, item.id]);

  useEffect(() => {
    if (preselectLine && selectedLineId === null) setSelectedLineId(preselectLine.id);
  }, [preselectLine, selectedLineId]);

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/admin/warehouse/loans/${selectedLoanId}/return`, {
          lines: [{ loanLineId: selectedLineId, locationId: location?.id, conditionGrade: grade, conditionNote: note || undefined }],
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: "Loan returned", description: `${item.sku}` });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`Return — ${item.sku}`} onBack={common.onCancel}>
      {selectedLoanId === null ? (
        <div className="rounded-xl border border-white/10 divide-y divide-white/5">
          {openLoans.length === 0 && <div className="text-white/30 text-sm text-center py-6">No loans currently out</div>}
          {openLoans.map((l) => (
            <button key={l.id} onClick={() => setSelectedLoanId(l.id)} className="w-full text-left px-3 py-3 hover:bg-white/[0.06]">
              <div className="text-white text-sm font-semibold flex items-center gap-2">
                {l.borrowerName}
                {l.overdue && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">Overdue</span>}
              </div>
              <div className="text-white/40 text-xs">Due {l.dueOn} · {l.lineCount} item(s)</div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <button onClick={() => { setSelectedLoanId(null); setSelectedLineId(null); }} className="text-blue-400 text-sm">
            ← Choose a different loan
          </button>
          {!loanDetail ? (
            <div className="flex justify-center py-6 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : ungradedLines.length === 0 ? (
            <div className="text-white/30 text-sm text-center py-6">Every line on this loan has already been returned</div>
          ) : (
            <>
              <Field label="Item on this loan">
                <select
                  className={inputCls}
                  value={selectedLineId ?? ""}
                  onChange={(e) => setSelectedLineId(Number(e.target.value))}
                >
                  {ungradedLines.map((l: any) => (
                    <option key={l.id} value={l.id}>
                      {l.itemSku} — {l.itemName} (qty {l.qty})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Condition">
                <select className={inputCls} value={grade} onChange={(e) => setGrade(e.target.value as ConditionGrade | "")}>
                  <option value="">— choose —</option>
                  {CONDITION_GRADES.map((g) => (
                    <option key={g} value={g}>
                      {CONDITION_GRADE_LABELS[g]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Notes (optional)">
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Any damage or issues..." />
              </Field>
              <Field label="Returning to bin">
                <LocationPicker value={location} onChange={setLocation} onScanRequest={() => common.requestScan(setLocation)} scanning={common.picking} />
              </Field>
              <SubmitError error={mutation.error} />
              <SubmitButton
                onClick={() => mutation.mutate()}
                disabled={!selectedLineId || !grade || !location}
                loading={mutation.isPending}
                label="Post return"
              />
            </>
          )}
        </>
      )}
    </FormShell>
  );
}

function CountForm({ location, ...common }: FormCommonProps & { location: ScanResolvedLocation }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedCountId, setSelectedCountId] = useState<number | null>(null);
  const [entries, setEntries] = useState<Record<number, number>>({});

  const { data: openCounts = [] } = useQuery<any[]>({
    queryKey: ["/api/admin/warehouse/counts", "open"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/counts?status=open")).json(),
  });
  const { data: countDetail } = useQuery<any>({
    queryKey: ["/api/admin/warehouse/counts", selectedCountId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/counts/${selectedCountId}`)).json(),
    enabled: selectedCountId !== null,
  });
  const linesHere = useMemo(
    () => (countDetail?.lines ?? []).filter((l: any) => l.locationId === location.id && l.countedQty === null),
    [countDetail, location.id],
  );

  const mutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `/api/admin/warehouse/counts/${selectedCountId}/count`, {
          lines: linesHere.map((l: any) => ({ lineId: l.id, countedQty: entries[l.id] ?? 0 })),
        })
      ).json(),
    onSuccess: () => {
      confirmFeedback("ok");
      toast({ title: "Count recorded", description: `${linesHere.length} line(s) at ${location.code}` });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/counts", selectedCountId] });
      common.onDone();
    },
    onError: () => confirmFeedback("err"),
  });

  return (
    <FormShell title={`Count — ${location.code}`} onBack={common.onCancel}>
      {selectedCountId === null ? (
        <div className="rounded-xl border border-white/10 divide-y divide-white/5">
          {openCounts.length === 0 && <div className="text-white/30 text-sm text-center py-6">No open count sessions — start one from the Counts admin page</div>}
          {openCounts.map((c) => (
            <button key={c.id} onClick={() => setSelectedCountId(c.id)} className="w-full text-left px-3 py-3 hover:bg-white/[0.06]">
              <div className="text-white text-sm font-semibold">
                Count #{c.id} {c.scopeZone ? `— zone ${c.scopeZone}` : c.scopeClass ? `— ${c.scopeClass}` : ""}
              </div>
              <div className="text-white/40 text-xs">
                {c.countedLineCount}/{c.lineCount} counted
              </div>
            </button>
          ))}
        </div>
      ) : (
        <>
          <button onClick={() => setSelectedCountId(null)} className="text-blue-400 text-sm">
            ← Choose a different session
          </button>
          {!countDetail ? (
            <div className="flex justify-center py-6 text-white/40">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : linesHere.length === 0 ? (
            <div className="text-white/30 text-sm text-center py-6">Nothing left to count at {location.code} in this session</div>
          ) : (
            <>
              {linesHere.map((l: any) => (
                <Field key={l.id} label={`${l.itemSku} — ${l.itemName}`}>
                  <NumberField value={entries[l.id] ?? 0} onChange={(v) => setEntries((prev) => ({ ...prev, [l.id]: v }))} step="0.001" />
                </Field>
              ))}
              <SubmitError error={mutation.error} />
              <SubmitButton onClick={() => mutation.mutate()} loading={mutation.isPending} label="Record counts" />
            </>
          )}
        </>
      )}
    </FormShell>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function WarehouseScan() {
  const [manualCode, setManualCode] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [resolved, setResolved] = useState<{ code: string; resolution: ScanResolution } | null>(null);
  const [scanCount, setScanCount] = useState(1);
  const [action, setAction] = useState<ActionKey | null>(null);
  const [pickOnPick, setPickOnPick] = useState<((loc: ScanResolvedLocation) => void) | null>(null);

  // Counter sales that couldn't reach the server (D25). Read straight out of
  // localStorage on mount so a queued sale survives the tab being closed, the
  // phone locking, or the app being reopened tomorrow.
  const [queued, setQueued] = useState<PendingSale[]>([]);
  const refreshQueue = useCallback(() => setQueued(pendingSales()), []);

  useEffect(() => {
    refreshQueue();
    // Drain on reconnect. The browser's 'online' event is optimistic (it fires
    // for any network interface coming up, not for our server being
    // reachable), which is fine — a flush that fails just re-queues.
    const onOnline = () => {
      flushSales(postSale).then(refreshQueue);
    };
    window.addEventListener("online", onOnline);
    // Also try once on mount, in case the connection came back while the tab
    // was closed and no event ever fired.
    if (typeof navigator === "undefined" || navigator.onLine !== false) onOnline();
    return () => window.removeEventListener("online", onOnline);
  }, [refreshQueue]);

  const resolveMutation = useMutation({
    mutationFn: async (code: string) => (await apiRequest("POST", "/api/admin/warehouse/scan", { code })).json() as Promise<ScanResolution>,
  });

  const resetToIdle = useCallback(() => {
    setResolved(null);
    setAction(null);
    setPickOnPick(null);
    setScanCount(1);
  }, []);

  const resolveCode = useCallback(
    async (code: string) => {
      try {
        const resolution = await resolveMutation.mutateAsync(code);
        setResolved({ code, resolution });
        setAction(null);
        setScanCount(1);
        confirmFeedback(resolution.kind === "unknown" ? "err" : "ok");
      } catch {
        confirmFeedback("err");
      }
    },
    [resolveMutation],
  );

  const handleDetected = useCallback(
    (code: string) => {
      if (pickOnPick) {
        resolveMutation
          .mutateAsync(code)
          .then((r) => {
            if (r.kind === "location") {
              confirmFeedback("ok");
              pickOnPick(r.location);
              setPickOnPick(null);
            } else {
              confirmFeedback("err");
            }
          })
          .catch(() => confirmFeedback("err"));
        return;
      }
      if (resolved && code === resolved.code) {
        if (action === null) {
          setScanCount((c) => c + 1);
          confirmFeedback("ok");
        }
        return;
      }
      resolveCode(code);
    },
    [pickOnPick, resolved, action, resolveCode, resolveMutation],
  );

  const cameraActive = action === null || pickOnPick !== null;
  const { videoRef, status, error, engine, torchSupported, torchOn, toggleTorch } = useCamera(cameraActive, handleDetected);

  // 🔴 When the camera can't start — permission denied, no camera on a desktop,
  // an HTTP origin — open the keyboard box automatically and let it take focus.
  //
  // A USB or Bluetooth barcode scanner is a KEYBOARD: it types the code and
  // presses Enter into whatever input is focused. With the box shut, a scan
  // goes nowhere and the station looks broken to someone holding working
  // hardware. This is the difference between the scanner working and not, so
  // it must not depend on the operator finding the keyboard icon first.
  useEffect(() => {
    if (status === "error") setManualOpen(true);
  }, [status]);

  // 🔴 USB / Bluetooth barcode scanner support (the desk workflow).
  //
  // These are keyboards — they type the code and press Enter into whatever has
  // focus. Auto-opening the manual box on camera failure covers a laptop with
  // no camera, but NOT a laptop whose webcam works and is pointed at the
  // ceiling: there the camera runs happily, the box stays shut, and the
  // trigger does nothing. So the page also listens at the document level and
  // tells a scanner from a person by TIMING (client/src/lib/wedge-scanner.ts).
  //
  // It stands down entirely while any input has focus, so typing a quantity or
  // a note is never hijacked — in that case the field receives the scan
  // directly, which is what we want anyway.
  const wedgeRef = useRef<WedgeState>(EMPTY_WEDGE);
  const [wedgeArmed, setWedgeArmed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreWedgeTarget(e.target)) return;
      const result = feedWedgeKey(wedgeRef.current, { key: e.key, at: e.timeStamp || Date.now() });
      wedgeRef.current = result.state;
      if (result.kind === "scan") {
        e.preventDefault();
        setWedgeArmed(true);
        // Route it exactly like a camera detection, so a hardware scan and a
        // camera scan behave identically everywhere downstream.
        handleDetected(result.code);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleDetected]);

  /** No usable camera means a hardware scanner (or typing) is the input
   *  method, so the box stays open and refocused between scans instead of
   *  closing after each one — otherwise counting a shelf means re-opening it
   *  for every single item. */
  const hardwareScannerMode = status === "error";
  const manualInputRef = useRef<HTMLInputElement>(null);

  const submitManual = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      resolveCode(code);
      setManualCode("");
      if (hardwareScannerMode) {
        // Keep the field alive and focused so the next trigger-pull lands.
        requestAnimationFrame(() => manualInputRef.current?.focus());
      } else {
        setManualOpen(false);
      }
    },
    [resolveCode, hardwareScannerMode],
  );

  const requestScan = useCallback((onPick: (loc: ScanResolvedLocation) => void) => {
    setPickOnPick(() => onPick);
  }, []);

  const defaultQty = useMemo(() => {
    if (!resolved || resolved.resolution.kind !== "item") return 1;
    return scanQuantityToUnits(scanCount, resolved.resolution.packQty);
  }, [resolved, scanCount]);

  const actionKeys = resolved ? actionsFor(resolved.resolution) : [];

  return (
    <div className="fixed inset-0 bg-[#0a0a0c] flex flex-col z-40">
      {/* Viewfinder */}
      <div className="relative flex-1 min-h-[220px] bg-black overflow-hidden">
        <video ref={videoRef} className="w-full h-full object-cover" playsInline muted />
        {!cameraActive && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <CameraOff className="w-8 h-8 text-white/20" />
          </div>
        )}
        {cameraActive && status !== "running" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white/60 text-sm px-6 text-center">
            {status === "error" ? (
              <>
                <AlertTriangle className="w-6 h-6 text-amber-400" />
                <span>{error || "Camera unavailable"}</span>
                {/* The manual box is opened automatically the moment the
                    camera fails (see the effect below) — a USB/Bluetooth
                    scanner is a keyboard and types into whatever is focused,
                    so leaving it shut means scanning does nothing at all. */}
                <span className="text-white/30 text-xs">
                  Keyboard entry is open below — a USB or Bluetooth scanner works straight into it.
                </span>
              </>
            ) : (
              <>
                <Loader2 className="w-6 h-6 animate-spin" />
                <span>Starting camera...</span>
              </>
            )}
          </div>
        )}
        {cameraActive && status === "running" && (
          <div className="absolute inset-6 border-2 border-white/30 rounded-2xl pointer-events-none" />
        )}
        {pickOnPick && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center gap-1.5">
            <ScanLine className="w-3.5 h-3.5" /> Scan the bin
          </div>
        )}

        <div className="absolute top-3 right-3 flex gap-2">
          {torchSupported && (
            <button onClick={toggleTorch} className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white">
              {torchOn ? <FlashlightOff className="w-4.5 h-4.5" /> : <Flashlight className="w-4.5 h-4.5" />}
            </button>
          )}
          <button
            onClick={() => setManualOpen((v) => !v)}
            className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white"
          >
            <Keyboard className="w-4.5 h-4.5" />
          </button>
        </div>

        {engine === "wasm" && status === "running" && (
          <div className="absolute bottom-3 left-3 text-[10px] text-white/30 uppercase tracking-wider">WASM scanner</div>
        )}

        {/* Proof the USB/Bluetooth scanner is being heard. Without this, a
            hardware scan that resolves instantly is indistinguishable from
            the page ignoring you — and the first thing anyone does with a new
            scanner is check whether it's working at all. */}
        {wedgeArmed && (
          <div className="absolute bottom-3 right-3 text-[10px] text-emerald-400/70 uppercase tracking-wider flex items-center gap-1">
            <ScanLine className="w-3 h-3" /> USB scanner connected
          </div>
        )}
      </div>

      {manualOpen && !pickOnPick && (
        <div className="p-3 border-t border-white/10 bg-black/90 flex gap-2 flex-shrink-0">
          <input
            ref={manualInputRef}
            className={inputCls + " flex-1"}
            placeholder={hardwareScannerMode ? "Scan or type a code — stays ready for the next one" : "Type a SKU or bin code..."}
            value={manualCode}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualCode.trim()) {
                submitManual(manualCode);
              }
            }}
            onChange={(e) => setManualCode(e.target.value)}
            autoFocus
          />
          <button
            onClick={() => submitManual(manualCode)}
            className="px-4 rounded-xl bg-blue-600 text-white text-sm font-semibold"
          >
            Go
          </button>
        </div>
      )}

      {/* Result panel */}
      <div className="flex-shrink-0 bg-[#101013] border-t border-white/10 overflow-y-auto" style={{ maxHeight: action ? "78vh" : "56vh" }}>
        {/* Sales that haven't reached the server yet. Only rendered when there
            actually are some, so it never becomes chrome people stop seeing. */}
        {queued.length > 0 && !action && (
          <div className="p-3 pb-0">
            <PendingSalesBar rows={queued} onChange={refreshQueue} />
          </div>
        )}
        {!resolved && !resolveMutation.isPending && (
          <div className="p-6 text-center text-white/30 text-sm">Point the camera at an item or bin label, or use manual entry.</div>
        )}
        {resolveMutation.isPending && (
          <div className="p-6 flex justify-center text-white/40">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {/* D19 — one physical asset. Read-only here on purpose: an asset is
            moved and retired from the Assets screen, which shows its whole
            history and asks for a destination. Scanning the tag is how you
            find out WHICH one you're holding and where it's meant to be. */}
        {resolved && !action && resolved.resolution.kind === "instance" && (() => {
          const inst = resolved.resolution.instance;
          const retired = inst.condition === "decommissioned";
          return (
            <div className="p-5 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-white font-bold text-lg truncate">{inst.itemName}</div>
                  <div className="text-white/40 text-xs truncate">
                    {inst.assetTag ?? "No asset tag"} · {inst.itemSku}
                  </div>
                </div>
                <button onClick={resetToIdle} className="text-white/30 hover:text-white p-1 shrink-0">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-2 py-0.5 rounded ${retired ? "bg-white/5 text-white/40" : "bg-blue-500/10 text-blue-400"}`}>
                  {inst.condition}
                </span>
                <span className="px-2 py-0.5 rounded bg-white/5 text-white/60">at {inst.locationCode}</span>
                {inst.serialNumber && <span className="text-white/30">serial {inst.serialNumber}</span>}
              </div>

              {retired && (
                <div className="text-amber-300/80 text-xs">
                  This one was retired — it shouldn't be back on the floor.
                </div>
              )}

              <a
                href={`/admin/warehouse/assets?instance=${inst.id}`}
                className="block w-full py-3 rounded-xl bg-blue-600 text-white text-center text-sm font-semibold"
              >
                Open it
              </a>
            </div>
          );
        })()}

        {resolved && !action && resolved.resolution.kind === "unknown" && (
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-5 h-5" />
              <span className="font-semibold">Code not recognised</span>
            </div>
            <div className="text-white/40 text-xs font-mono break-all">{resolved.resolution.rawCode}</div>
            <button onClick={resetToIdle} className="w-full py-3 rounded-xl bg-white/[0.06] border border-white/10 text-white/70">
              Try again
            </button>
          </div>
        )}

        {resolved && !action && resolved.resolution.kind === "item" && (
          <div className="overflow-y-auto max-h-full">
            <div className="p-4 pb-2 flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <span className="text-white font-bold truncate">{resolved.resolution.item.sku}</span>
                </div>
                <div className="text-white/40 text-xs truncate mt-0.5">{resolved.resolution.item.name}</div>
                {resolved.resolution.matchedVia === "alias" && (
                  <div className="text-white/30 text-[11px] mt-0.5">
                    Alias {resolved.resolution.aliasCode} · ×{resolved.resolution.packQty}/scan · scanned {scanCount}× = {defaultQty}
                  </div>
                )}
              </div>
              <button onClick={resetToIdle} className="text-white/30 hover:text-white p-1 flex-shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-4 pb-4 space-y-2">
              {actionKeys.map((k) => (
                <ActionButton key={k} actionKey={k} onClick={() => setAction(k)} />
              ))}
            </div>
          </div>
        )}

        {resolved && !action && resolved.resolution.kind === "location" && (
          <div className="overflow-y-auto max-h-full">
            <div className="p-4 pb-2 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                  <span className="text-white font-bold">{resolved.resolution.location.code}</span>
                </div>
                <div className="text-white/40 text-xs mt-0.5 capitalize">{resolved.resolution.location.kind}</div>
              </div>
              <button onClick={resetToIdle} className="text-white/30 hover:text-white p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="px-4 pb-4 space-y-2">
              {actionKeys.length === 0 && <div className="text-white/30 text-sm text-center py-4">No actions for a virtual location</div>}
              {actionKeys
                .filter((k) => k !== "putaway" && k !== "transfer")
                .map((k) => (
                  <ActionButton key={k} actionKey={k} onClick={() => setAction(k)} />
                ))}
              {actionKeys.includes("putaway") && (
                <div className="text-white/30 text-xs px-1">Putaway/transfer start from the item being moved — scan the item first.</div>
              )}
            </div>
          </div>
        )}

        {resolved && action && resolved.resolution.kind === "item" && (() => {
          const item = resolved.resolution.item;
          const commonProps: FormCommonProps = {
            onDone: resetToIdle,
            onCancel: () => setAction(null),
            requestScan,
            picking: pickOnPick !== null,
          };
          switch (action) {
            case "receipt":
              return <ReceiveForm item={item} {...commonProps} />;
            case "putaway":
              return <PutawayTransferForm kind="putaway" item={item} defaultQty={defaultQty} {...commonProps} />;
            case "transfer":
              return <PutawayTransferForm kind="transfer" item={item} defaultQty={defaultQty} {...commonProps} />;
            case "consume":
              return <ConsumeForm item={item} defaultQty={defaultQty} {...commonProps} />;
            case "sale":
              return <SaleForm item={item} defaultQty={defaultQty} onQueueChange={refreshQueue} {...commonProps} />;
            case "pick":
              return <PickDispatchForm restrict="pick" item={item} {...commonProps} />;
            case "dispatch":
              return <PickDispatchForm restrict="dispatch" item={item} {...commonProps} />;
            case "loan_out":
              return <LoanOutForm item={item} {...commonProps} />;
            case "loan_return":
              return <LoanReturnForm item={item} {...commonProps} />;
            default:
              return null;
          }
        })()}

        {resolved && action && resolved.resolution.kind === "location" && action === "count" && (
          <CountForm
            location={resolved.resolution.location}
            onDone={resetToIdle}
            onCancel={() => setAction(null)}
            requestScan={requestScan}
            picking={pickOnPick !== null}
          />
        )}
      </div>
    </div>
  );
}

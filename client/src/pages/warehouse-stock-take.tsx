// Stock take (D27, extended by D29) — walk the racks with a scanner and put
// real numbers in.
//
// The job this replaces: counting a location by hand, writing it on paper, then
// typing it into a spreadsheet. Here you pick the location, scan, and the tally
// builds itself. Scan the same kit ten times and it reads 10; or scan once and
// type 10. Then one button writes it all to the warehouse.
//
// 🔴 A stock take SETS the quantity — "there are 10 at this location" — so the
// ledger records (counted − what we thought). The screen shows that arithmetic
// per line rather than hiding it, because a stock take that silently doubled a
// location on a recount would be worse than no stock take.
//
// 🔴 D29 — an unrecognised barcode is NOT an error here. On a first count most
// of the room is stock ClubOS has never heard of: a KELME shirt's own EAN means
// nothing to us until it is linked once. Scanning one used to raise "not
// recognised" and throw the scan away, which made the uniform stock — most of
// the warehouse — impossible to count. Now it opens a short form, registers the
// item, links the barcode, and counts it, without leaving the count.
//
// Both input methods work: the phone camera and a USB/Bluetooth scanner
// (client/src/lib/wedge-scanner.ts — it types and presses Enter, so the page
// listens at document level and never steals what you're typing in a box).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ScanLine, Plus, Minus, Trash2, Loader2, Download, CheckCircle2, AlertTriangle,
  PackageCheck, MapPin, X, ChevronRight, PackagePlus, Search, Volume2, VolumeX, StickyNote,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { askConfirm } from "@/components/confirm-dialog";
import { useScannerFocus } from "@/lib/use-scanner-focus";
import {
  isMuted, setMuted, primeAudio, soundCounted, soundUnknown, soundSaved, soundError,
} from "@/lib/scan-sounds";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModalPortal } from "@/components/warehouse-custom-fields";
import { feedWedgeKey, shouldIgnoreWedgeTarget, EMPTY_WEDGE, type WedgeState } from "@/lib/wedge-scanner";
import { locationLabel, suggestSku } from "@shared/warehouse";
import type { WhLocation } from "@shared/schema";

interface CountLine {
  itemId: number;
  sku: string;
  name: string;
  counted: number;
  // D32 — the model this variant belongs to. A REAL record now, read from
  // wh_models, not inferred from the words these item names happen to share.
  // Still optional: a roll of vinyl belongs to no model and stands on its own.
  modelId?: number | null;
  modelTitle?: string | null;
  // D29 — the apparel attributes, so a count of forty shirts reads as four
  // models rather than forty unrelated rows.
  vendor?: string | null;
  vendorModel?: string | null;
  colour?: string | null;
  sizeAsian?: string | null;
  sizeEU?: string | null;
  // D35 — where it physically sits, so a recount can be walked rack by rack.
  rackCode?: string | null;
  barcode?: string | null;
  notes?: string | null;
}

/** Survives a reload / the phone locking mid-count — an hour of scanning must
 *  not be lost to a stray tab close before it's posted. Key deliberately
 *  unchanged from D27: the new fields are optional, so a draft written by the
 *  previous version still loads (it just groups its lines on their own). */
const DRAFT_KEY = "wh_stock_take_draft_v1";

function loadDraft(): { locationId: string; lines: CountLine[] } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDraft(locationId: string, lines: CountLine[]) {
  try {
    if (!lines.length) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ locationId, lines }));
  } catch { /* storage blocked — the count still works, it just won't survive a reload */ }
}

/** D32 — a variant sits under the model it actually belongs to.
 *
 *  This used to bucket lines by vendor+model text and then GUESS each heading
 *  from the words the item names shared. That rendered correctly and was not
 *  real: it broke whenever a vendor field was blank or two names diverged, and
 *  there was no record behind it to edit, photograph or add a variant to.
 *
 *  Items with no model still stand on their own — materials and equipment
 *  belong to no garment family, and inventing one would be a relationship that
 *  isn't there. */
function groupKeyFor(l: CountLine): string {
  return l.modelId ? `model:${l.modelId}` : `item:${l.itemId}`;
}

interface LineGroup {
  key: string;
  vendor: string | null;
  model: string | null;
  title: string;
  lines: CountLine[];
  total: number;
}

function groupLines(lines: CountLine[]): LineGroup[] {
  const out: LineGroup[] = [];
  const byKey = new Map<string, LineGroup>();
  for (const l of lines) {
    const key = groupKeyFor(l);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        vendor: l.vendor?.trim() || null,
        model: l.vendorModel?.trim() || null,
        // The model's own title, verbatim. An unmodelled item keeps its full
        // name — that IS its whole description.
        title: l.modelTitle?.trim() || l.name,
        lines: [],
        total: 0,
      };
      byKey.set(key, g);
      out.push(g);
    }
    g.lines.push(l);
    g.total += l.counted;
  }
  return out;
}

/** What distinguishes one line from its siblings under the same heading. */
function variantLabel(l: CountLine): string {
  const bits = [
    l.colour?.trim(),
    l.sizeAsian?.trim() ? `Asian ${l.sizeAsian.trim()}` : "",
    l.sizeEU?.trim() ? `EU ${l.sizeEU.trim()}` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : l.name;
}

export default function WarehouseStockTake() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const draft = useRef(loadDraft());

  const [locationId, setLocationId] = useState(draft.current?.locationId ?? "");
  const [lines, setLines] = useState<CountLine[]>(draft.current?.lines ?? []);
  const [manual, setManual] = useState("");
  const [lastScan, setLastScan] = useState<
    { sku: string; label: string; counted: number; sub?: string; isNew?: boolean } | null
  >(null);
  const [posted, setPosted] = useState<any | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [register, setRegister] = useState<{ barcode: string } | null>(null);
  const [muted, setMutedState] = useState(isMuted);
  // Spec §3 — the rack most recently entered, offered as the default on the
  // next add. A run of new items is nearly always one shelf.
  const [lastRack, setLastRack] = useState("");
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => { saveDraft(locationId, lines); }, [locationId, lines]);

  const { data: locations } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const countable = (locations ?? []).filter((l) => l.kind !== "virtual" && l.active);

  // Spec §2 — the cursor never leaves the scan box. Suspended while the
  // registration form is open: in that state the keyboard belongs to whichever
  // field the operator is filling in.
  const focusScanner = useScannerFocus(manualRef, { enabled: register === null });

  /** D32/D34 — the model and the real colour/size for a scanned item.
   *
   *  This used to read wh_item_fields alone, one request per new line. That was
   *  empty for all 4,726 items seeded from the shop catalogue (their colour and
   *  size live on shop_variants), which is precisely why the old screen had to
   *  guess a model name from common word prefixes. The server now reads the
   *  hand-entered field first and falls back to the shop record, so the whole
   *  catalogue shows real attributes.
   *
   *  Batched: a real count meets a new item every few seconds, and one request
   *  per garment is a request per garment. */
  const pendingHydrate = useRef<Set<number>>(new Set());
  const hydrateTimer = useRef<number | null>(null);

  const flushHydrate = useCallback(async () => {
    const ids = Array.from(pendingHydrate.current);
    pendingHydrate.current.clear();
    if (!ids.length) return;
    try {
      const r = await (await apiRequest("POST", "/api/admin/warehouse/variant-details", { itemIds: ids })).json();
      const byId = new Map<number, any>((r?.details ?? []).map((d: any) => [d.itemId, d]));
      setLines((prev) => prev.map((l) => {
        const d = byId.get(l.itemId);
        if (!d) return l;
        return {
          ...l,
          modelId: d.modelId ?? null,
          modelTitle: d.modelTitle ?? null,
          vendor: d.modelVendor ?? null,
          vendorModel: d.modelVendorModel ?? null,
          colour: d.colour ?? null,
          sizeAsian: d.sizeAsian ?? null,
          sizeEU: d.sizeEU ?? null,
          rackCode: d.rackCode ?? null,
          barcode: d.barcode ?? null,
        };
      }));
    } catch { /* attributes are decoration on a count — never block the scan */ }
  }, []);

  const hydrateAttrs = useCallback((itemId: number) => {
    pendingHydrate.current.add(itemId);
    if (hydrateTimer.current) window.clearTimeout(hydrateTimer.current);
    // Short debounce: a burst of scans down one rack becomes one request, and
    // a single scan still resolves fast enough to feel immediate.
    hydrateTimer.current = window.setTimeout(() => { void flushHydrate(); }, 250);
  }, [flushHydrate]);

  useEffect(() => () => { if (hydrateTimer.current) window.clearTimeout(hydrateTimer.current); }, []);

  const addLine = useCallback((line: CountLine, hydrate: boolean) => {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.itemId === line.itemId);
      if (i === -1) return [...prev, line];
      const next = [...prev];
      next[i] = { ...next[i], counted: next[i].counted + line.counted };
      return next;
    });
    if (hydrate) void hydrateAttrs(line.itemId);
  }, [hydrateAttrs]);

  /** Adds one scan to the tally. Same code twice = 2, not a duplicate row. */
  const addScan = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const r = await (await apiRequest("POST", "/api/admin/warehouse/scan", { code: trimmed })).json();

      // 🔴 D29 — an unknown code during a first count is stock we haven't met
      // yet, not a mistake. Offer to register it rather than dropping the scan.
      if (r.kind === "unknown") {
        // Spec §8 — a deliberately different tone. The operator can tell by ear
        // that this scan needs typing in, without looking up from the shelf.
        soundUnknown();
        setRegister({ barcode: trimmed });
        return;
      }
      if (r.kind !== "item") {
        // A bin label or an asset tag scanned during a count IS a mis-scan —
        // say which, so it's obvious what happened.
        const what = r.kind === "location" ? "a bin label" : "an asset tag";
        soundError();
        toast({ title: `That's ${what}, not stock`, description: trimmed, variant: "destructive" });
        return;
      }
      const item = r.item;
      // A case barcode counts as its pack quantity, not one (D5).
      const add = r.packQty && r.packQty > 1 ? r.packQty : 1;
      const existing = lines.find((l) => l.itemId === item.id);
      addLine({ itemId: item.id, sku: item.sku, name: item.name, counted: add }, !existing);
      // The panel shows the RUNNING total for that variant, not the increment —
      // "that's the ninth one" is the thing worth reading back on a shelf.
      setLastScan({
        sku: item.sku,
        label: item.name,
        counted: (existing?.counted ?? 0) + add,
        isNew: !existing,
        sub: existing ? variantLabel(existing) : item.sku,
      });
      soundCounted();
      if (navigator.vibrate) navigator.vibrate(15);
    } catch {
      soundError();
      toast({ title: "Couldn't look that code up", description: trimmed, variant: "destructive" });
    }
  }, [toast, addLine, lines]);

  // USB / Bluetooth scanner, exactly as on the scan station. Suspended while the
  // register form is open — in that state the scanner's keystrokes belong to
  // whichever box the person is filling in.
  const wedge = useRef<WedgeState>(EMPTY_WEDGE);
  const registerOpen = register !== null;
  useEffect(() => {
    if (registerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreWedgeTarget(e.target)) return;
      const r = feedWedgeKey(wedge.current, { key: e.key, at: e.timeStamp || Date.now() });
      wedge.current = r.state;
      if (r.kind === "scan") { e.preventDefault(); addScan(r.code); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addScan, registerOpen]);

  const total = useMemo(() => lines.reduce((n, l) => n + l.counted, 0), [lines]);

  const visibleLines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) =>
      [l.name, l.sku, l.vendor, l.vendorModel, l.colour, l.sizeAsian, l.sizeEU]
        .filter(Boolean).join(" ").toLowerCase().includes(q));
  }, [lines, filter]);

  const groups = useMemo(() => groupLines(visibleLines), [visibleLines]);

  const post = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/warehouse/stock-take", {
        locationId: Number(locationId),
        lines: lines.map((l) => ({ itemId: l.itemId, counted: l.counted })),
        // Minted once per posted count so a retry can't move the location twice.
        idempotencyKey: `stocktake-${locationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      })).json(),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/dashboard"] });
      setPosted(r);
      setLines([]);
      saveDraft("", []);
      toast({ title: r.unchanged ? "Nothing changed" : "Stock take saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save the count", description: e.message, variant: "destructive" }),
  });

  const setQty = (itemId: number, counted: number) =>
    setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, counted: Math.max(0, counted) } : l)));

  // ── Result screen ──────────────────────────────────────────────────────────
  if (posted) {
    const changed = (posted.lines ?? []).filter((l: any) => l.delta !== 0);
    return (
      <div className="p-4 sm:p-6 max-w-2xl space-y-4">
        <div className="flex items-center gap-2 text-emerald-400">
          <CheckCircle2 className="w-5 h-5" />
          <h1 className="text-xl font-bold text-white">
            {posted.unchanged ? "Everything already matched" : "Stock take saved"}
          </h1>
        </div>
        <p className="text-sm text-white/50">
          {posted.locationCode} · {(posted.lines ?? []).length} line(s), {changed.length} changed.
        </p>

        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
          {(posted.lines ?? []).map((l: any) => (
            <div key={l.itemId} className="px-3 py-2 flex items-center justify-between gap-3 border-b border-white/[0.04] text-sm">
              <div className="min-w-0">
                <div className="text-white/85 truncate">{l.name}</div>
                <div className="text-[11px] text-white/30 font-mono">{l.sku}</div>
              </div>
              <div className="text-right shrink-0 text-xs">
                <div className="text-white/60">{l.before} → {l.counted}</div>
                <div className={l.delta === 0 ? "text-white/25" : l.delta > 0 ? "text-emerald-400" : "text-amber-400"}>
                  {l.delta === 0 ? "no change" : l.delta > 0 ? `+${l.delta}` : l.delta}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPosted(null)} className="gap-1.5"><ScanLine className="w-4 h-4" /> Count another location</Button>
          <a
            href="/api/admin/warehouse/stock.csv"
            className="px-3 py-2 rounded-lg text-sm text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" /> Export all stock (CSV)
          </a>
          <Button variant="ghost" onClick={() => navigate("/admin/warehouse")}>Done</Button>
        </div>
      </div>
    );
  }

  // ── Counting screen ────────────────────────────────────────────────────────
  // Laid out to match the prototype this was ported from: a scan panel that
  // dominates the screen, three running counters, a toolbar, and a table whose
  // COLUMN HEADINGS are visible before anything is counted — so the screen tells
  // you what it is going to collect, instead of being an empty box.
  const emptyStats = [
    { n: groupLines(lines).length, l: "Models" },
    { n: lines.length, l: "Variants" },
    { n: total, l: "Units counted" },
  ];

  return (
    // Full width on purpose: this is a working screen with a table on it, and a
    // capped column left most of a warehouse laptop empty.
    //
    // 🔴 The extra bottom padding is not decoration. The Save bar is sticky, so
    // without room to scroll past it the last rows of a long count sit
    // permanently underneath it — on a phone that is the stock you just counted.
    <div className={`p-4 sm:p-6 w-full space-y-4 ${lines.length > 0 ? "pb-28 sm:pb-24" : ""}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white">Stock take</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Scan what's there — the count builds itself. Scan the same thing twice and it reads 2.
          </p>
        </div>
        <div className="space-y-1 w-full sm:w-auto sm:min-w-[240px]">
          <label className="text-xs text-white/50 flex items-center gap-1"><MapPin className="w-3 h-3" /> Which location are you counting?</label>
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger><SelectValue placeholder="Pick a location" /></SelectTrigger>
            <SelectContent className="max-w-[calc(100vw-2rem)]">
              {countable.map((l) => <SelectItem key={l.id} value={String(l.id)}>{locationLabel(l)}</SelectItem>)}
            </SelectContent>
          </Select>
          {countable.length === 0 && (
            <p className="text-[11px] text-amber-400/70">
              No locations set up yet — add them under Warehouse → Locations first.
            </p>
          )}
        </div>
      </div>

      {/* The scan panel — the one thing the operator looks at all day. */}
      <div className="rounded-2xl border border-white/10 bg-[#0d1424] p-5 space-y-3 shadow-[0_8px_28px_-16px_rgba(0,0,0,0.9)]">
        <div className="text-[11px] uppercase tracking-[0.14em] font-semibold text-blue-200/60 flex items-center gap-2">
          <ScanLine className="w-3.5 h-3.5" /> Scan variant barcode
        </div>
        <div className="flex gap-2">
          <Input
            ref={manualRef}
            autoFocus
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              // Spec §8 — a browser will not start an AudioContext until the
              // user has interacted. A scanner IS a keyboard, so its first
              // keystroke is the gesture that unlocks the beeps.
              primeAudio();
              if (e.key === "Enter" && manual.trim()) {
                addScan(manual);
                setManual("");
                // Stay ready for the next one — a location is many scans.
                focusScanner();
              }
            }}
            placeholder="Cursor is here — just scan..."
            className="font-mono !text-lg h-14 bg-black/40 border-white/10 tracking-wide scroll-mb-24"
          />
          <Button
            onClick={() => { if (manual.trim()) { addScan(manual); setManual(""); focusScanner(); } }}
            disabled={!manual.trim()}
            className="h-14 px-5"
          >
            Add
          </Button>
        </div>

        {/* The confirmation line: the new quantity, big, then what it was. */}
        <div className={`flex items-center gap-3 min-h-[52px] transition-opacity ${lastScan ? "opacity-100" : "opacity-40"}`}>
          <div className={`min-w-[54px] text-center rounded-lg px-3 py-1 text-2xl font-bold tabular-nums ${
            lastScan?.isNew ? "text-emerald-400 bg-emerald-400/10" : "text-amber-300 bg-amber-300/10"
          }`}>
            {lastScan ? lastScan.counted : "–"}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white/90 truncate">{lastScan ? lastScan.label : "Waiting for a scan"}</div>
            <div className="text-[11px] text-white/40 font-mono truncate">{lastScan?.sub ?? ""}</div>
          </div>
        </div>
      </div>

      {/* Running totals — always on, so zero is a state you can see. */}
      <div className="grid grid-cols-3 gap-2">
        {emptyStats.map((s) => (
          <div key={s.l} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <div className="text-2xl font-bold text-white tabular-nums">{s.n}</div>
            <div className="text-[10px] uppercase tracking-wide text-white/35 mt-0.5">{s.l}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 text-white/25 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search by vendor, title, SKU, colour, size..."
            className="pl-9 scroll-mb-24"
          />
        </div>
        <Button variant="outline" onClick={() => setRegister({ barcode: "" })} className="gap-1.5">
          <PackagePlus className="w-4 h-4" /> New item
        </Button>
        {/* Spec §8 — mute, and it remembers. Someone counting next to a class
            in the gym should not have to choose between the beep and the job. */}
        <Button
          variant="ghost"
          onClick={() => { const next = !muted; setMutedState(next); setMuted(next); if (!next) { primeAudio(); soundCounted(); } }}
          className="gap-1.5"
          title={muted ? "Sound is off" : "Sound is on"}
        >
          {muted ? <VolumeX className="w-4 h-4 text-white/40" /> : <Volume2 className="w-4 h-4" />}
          {muted ? "Sound: Off" : "Sound: On"}
        </Button>
        <a
          href="/api/admin/warehouse/catalogue.csv"
          className="px-3 py-2 rounded-lg text-sm text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
        >
          <Download className="w-4 h-4" /> Export CSV
        </a>
        {lines.length > 0 && (
          <Button
            variant="ghost"
            onClick={async () => {
              // Spec §7 — our own modal, never confirm(). And it states the
              // cost: an hour of scanning is a real thing to lose.
              const ok = await askConfirm(
                `${total} unit${total === 1 ? "" : "s"} counted across ${lines.length} variant${lines.length === 1 ? "" : "s"} will be discarded.\n\nThis clears the count in progress. It does not change any stock, and nothing in the catalogue is deleted.`,
                { title: "Clear this count?", confirmLabel: "Clear the count" },
              );
              if (ok) { setLines([]); saveDraft("", []); focusScanner(); }
            }}
          >
            Clear
          </Button>
        )}
      </div>

      {/* The tally. Column headings show before anything is counted. */}
      <div className="rounded-xl border border-white/[0.06] overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[28px_1.1fr_1.6fr_1fr_90px_90px] gap-2 px-3 py-2 bg-white/[0.04] border-b border-white/[0.06] text-[10px] uppercase tracking-wide text-white/40 font-bold">
              <span />
              <span>Vendor</span>
              <span>Title</span>
              <span>Vendor model</span>
              <span className="text-right">Variants</span>
              <span className="text-right">Total qty</span>
            </div>

            {groups.length === 0 ? (
              // 🔴 Sticky-left inside the 720px-wide scroller. Centring it in
              // that width puts it off-screen on a 390px phone — caught by
              // ui-preflight showing "Nothing c…" and "Scan the first thi…"
              // running off the right edge. An empty state you cannot read is
              // worse than none, because it looks like the page failed to load.
              <div className="sticky left-0 w-screen max-w-full sm:w-auto text-center py-12 px-4">
                <PackageCheck className="w-8 h-8 text-white/15 mx-auto mb-3" />
                <p className="text-sm text-white/50">
                  {lines.length === 0 ? "Nothing counted yet." : "Nothing matches that search."}
                </p>
                <p className="text-xs text-white/30 mt-1">
                  {lines.length === 0 ? "Scan the first thing at this location." : "Clear the search to see the whole count."}
                </p>
              </div>
            ) : groups.map((g) => {
              const open = !collapsed.has(g.key);
              return (
                <div key={g.key} className="border-b border-white/[0.04] last:border-b-0">
                  <button
                    onClick={() => setCollapsed((prev) => {
                      const next = new Set(prev);
                      next.has(g.key) ? next.delete(g.key) : next.add(g.key);
                      return next;
                    })}
                    className="w-full grid grid-cols-[28px_1.1fr_1.6fr_1fr_90px_90px] gap-2 px-3 py-2.5 items-center text-left hover:bg-white/[0.02]"
                  >
                    <ChevronRight className={`w-3.5 h-3.5 text-white/30 transition-transform ${open ? "rotate-90" : ""}`} />
                    <span className="text-sm font-semibold text-white truncate">{g.vendor ?? "—"}</span>
                    <span className="text-sm text-white/80 truncate">{g.title}</span>
                    <span className="text-xs text-white/45 font-mono truncate">{g.model ?? "—"}</span>
                    <span className="text-xs text-white/40 text-right tabular-nums">{g.lines.length}</span>
                    <span className="text-base font-bold text-white text-right tabular-nums">{g.total}</span>
                  </button>

                  {open && (
                    <div className="bg-white/[0.015] border-t border-white/[0.03] px-3 pb-2 pt-1">
                      <div className="grid grid-cols-[1.2fr_70px_70px_1.1fr_64px_150px_40px] gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-white/30 font-bold">
                        <span>Colour</span><span>Asian</span><span>EU</span><span>Our SKU</span><span>Rack</span>
                        <span className="text-center">Qty</span><span />
                      </div>
                      {g.lines.map((l) => (
                        <div key={l.itemId} className="grid grid-cols-[1.2fr_70px_70px_1.1fr_64px_150px_40px] gap-2 px-2 py-1.5 items-center rounded-lg hover:bg-white/[0.03]">
                          <span className="text-sm text-white/80 truncate flex items-center gap-1">
                            {l.colour ?? l.name}
                            {/* Spec §6 — a note is the exception, not the norm,
                                so it gets an indicator rather than a column of
                                mostly-empty cells. */}
                            {l.notes && (
                              <span title={l.notes} className="shrink-0 leading-none" aria-label={`Note: ${l.notes}`}>
                                <StickyNote className="w-3 h-3 text-amber-300/70" />
                              </span>
                            )}
                          </span>
                          <span className="text-sm text-white/60 truncate">{l.sizeAsian ?? "—"}</span>
                          <span className="text-sm text-white/60 truncate">{l.sizeEU ?? "—"}</span>
                          <span className="text-[11px] text-white/35 font-mono truncate">{l.sku}</span>
                          <span className="text-[11px] truncate">
                            {l.rackCode
                              ? <span className="px-1.5 py-0.5 rounded bg-blue-400/10 text-blue-200/80 font-mono">{l.rackCode}</span>
                              : <span className="text-white/20">—</span>}
                          </span>
                          <div className="flex items-center gap-1 justify-center">
                            <button
                              onClick={() => setQty(l.itemId, l.counted - 1)}
                              className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/60"
                              aria-label="One less"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <Input
                              type="number"
                              value={l.counted}
                              onChange={(e) => setQty(l.itemId, Number(e.target.value))}
                              className="w-14 h-8 text-center px-1 scroll-mb-24"
                            />
                            <button
                              onClick={() => setQty(l.itemId, l.counted + 1)}
                              className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/60"
                              aria-label="One more"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <button
                            onClick={() => setLines((p) => p.filter((x) => x.itemId !== l.itemId))}
                            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400"
                            aria-label="Remove from this count"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {lines.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 sticky bottom-0 py-3 bg-[#0a0b0d]">
          <Button onClick={() => post.mutate()} disabled={!locationId || post.isPending} className="gap-1.5">
            {post.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
            Save this count ({total})
          </Button>
          {!locationId && <span className="text-[11px] text-amber-400/70">Pick a location first</span>}
          <span className="text-[11px] text-white/30 flex items-start gap-1.5 ml-auto max-w-md">
            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
            This sets the quantity at that location to what you counted — it doesn't add to what's already recorded.
          </span>
        </div>
      )}

      {register && (
        <RegisterItemSheet
          barcode={register.barcode}
          lastRack={lastRack}
          onClose={() => { setRegister(null); focusScanner(); }}
          onRegistered={(line) => {
            addLine({ ...line, counted: 1 }, false);
            if (line.rackCode) setLastRack(line.rackCode);
            setLastScan({ sku: line.sku, label: line.name, counted: 1, isNew: true, sub: variantLabel(line) });
            setRegister(null);
            focusScanner();
          }}
        />
      )}
    </div>
  );
}

// ── D29: register an item mid-count ──────────────────────────────────────────
// Deliberately short. Everything here is either printed on the garment's own
// label or visible while holding it — nothing asks the person on the floor for
// a decision they'd have to leave the warehouse to make.
//
// No photo field: ClubOS's Supabase storage is egress-restricted and returns
// 402 for every object, so an upload would appear to work and then show a broken
// image on every screen. Add it back when billing is restored.
function RegisterItemSheet({
  barcode,
  onClose,
  onRegistered,
  lastRack,
}: {
  barcode: string;
  onClose: () => void;
  onRegistered: (line: CountLine) => void;
  /** Spec §3 — the rack last used in this session. Different colours and sizes
   *  of one model are almost always shelved together, so this saves a re-type
   *  on nearly every add. */
  lastRack: string;
}) {
  const { toast } = useToast();
  const [vendor, setVendor] = useState("");
  const [title, setTitle] = useState("");
  const [vendorModel, setVendorModel] = useState("");
  const [colour, setColour] = useState("");
  const [sizeAsian, setSizeAsian] = useState("");
  const [sizeEU, setSizeEU] = useState("");
  const [notes, setNotes] = useState("");
  const [rackCode, setRackCode] = useState(lastRack);
  const [code, setCode] = useState(barcode);
  const [sku, setSku] = useState("");
  const [skuTouched, setSkuTouched] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  // Spec §5 — autocomplete built from values already in the catalogue, rebuilt
  // each time the form opens. Stops Blue/blue/BLUE drift without imposing a
  // taxonomy on a catalogue still being entered for the first time.
  const { data: suggestions } = useQuery<{
    vendor: string[]; colour: string[]; sizeAsian: string[]; sizeEU: string[]; rackCode: string[];
  }>({
    queryKey: ["/api/admin/warehouse/suggestions"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/suggestions")).json(),
    staleTime: 0,
  });

  // The SKU writes itself from what's been typed, until someone edits it — at
  // which point it's theirs and we stop overwriting their work.
  const suggested = useMemo(
    () => suggestSku({ vendor, vendorModel, colour, size: sizeAsian || sizeEU }),
    [vendor, vendorModel, colour, sizeAsian, sizeEU],
  );
  useEffect(() => { if (!skuTouched) setSku(suggested); }, [suggested, skuTouched]);

  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/warehouse/quick-item", {
        barcode: code.trim() || undefined,
        vendor: vendor.trim() || undefined,
        title: title.trim() || undefined,
        vendorModel: vendorModel.trim() || undefined,
        sku: sku.trim() || undefined,
        colour: colour.trim() || undefined,
        sizeAsian: sizeAsian.trim() || undefined,
        sizeEU: sizeEU.trim() || undefined,
        notes: notes.trim() || undefined,
        rackCode: rackCode.trim() || undefined,
      })).json(),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/items"] });
      // Spec §8 — the third tone: saved, distinct from both scan sounds.
      soundSaved();
      toast({ title: "Registered", description: `${r.item.sku} — counted 1` });
      onRegistered({
        itemId: r.item.id, sku: r.item.sku, name: r.item.name, counted: 1,
        vendor: r.line?.vendor ?? null, vendorModel: r.line?.vendorModel ?? null,
        colour: r.line?.colour ?? null, sizeAsian: r.line?.sizeAsian ?? null, sizeEU: r.line?.sizeEU ?? null,
        rackCode: r.line?.rackCode ?? null, notes: r.line?.notes ?? null, barcode: r.barcode ?? null,
      });
    },
    onError: (e: any) => { soundError(); toast({ title: "Couldn't register that", description: e.message, variant: "destructive" }); },
  });

  const canSave = (vendor.trim() || vendorModel.trim() || title.trim()) && sku.trim() && !save.isPending;

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <div className="space-y-1">
      <label className="text-[11px] uppercase tracking-wide text-white/40 font-semibold">{label}</label>
      {node}
      {hint && <p className="text-[10px] text-white/25">{hint}</p>}
    </div>
  );

  return (
    <ModalPortal>
      {/* 🔴 Never items-center a sheet that can outgrow the screen: staff run
          16:9 Windows laptops at 125% DPI (~620–740px of height), where centring
          clips the top off unreachably. Overlay scrolls, card is m-auto — it
          centres when it fits and top-anchors when it doesn't — and the actions
          are a sticky footer, so Save is always on screen. */}
      <div className="fixed inset-0 z-50 overflow-y-auto flex p-0 sm:p-4">
        <div className="fixed inset-0 bg-black/70" onClick={onClose} />
        <div className="relative w-full sm:max-w-lg sm:rounded-2xl bg-[#0f1216] border border-white/10 mt-auto sm:m-auto">
          <div className="sticky top-0 bg-[#0f1216] border-b border-white/10 px-4 py-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white">
                {barcode ? "We haven't seen this one before" : "Add an item by hand"}
              </div>
              <div className="text-xs text-white/40 truncate">
                {barcode
                  ? <>Register it once and every future scan just counts. <span className="font-mono text-white/60">{barcode}</span></>
                  : "For stock with no barcode on it"}
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5 shrink-0" aria-label="Close">
              <X className="w-4 h-4 text-white/50" />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {field("Vendor",
                <>
                  <Input ref={firstRef} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="KELME" list="wh-vendors" className="scroll-mb-24" />
                  <datalist id="wh-vendors">
                    {(suggestions?.vendor ?? []).map((v) => <option key={v} value={v} />)}
                  </datalist>
                </>)}
              {field("Vendor model", <Input value={vendorModel} onChange={(e) => setVendorModel(e.target.value)} placeholder="K123-45" className="scroll-mb-24" />)}
            </div>

            {field("Title", <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Football Shorts Adults" className="scroll-mb-24" />,
              "Left blank, we'll name it from the vendor, model and colour.")}

            {field("Colour",
              <>
                <Input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="Navy" list="wh-colours" className="scroll-mb-24" />
                <datalist id="wh-colours">
                  {(suggestions?.colour ?? []).map((c) => <option key={c} value={c} />)}
                </datalist>
              </>)}

            <div className="grid grid-cols-2 gap-3">
              {field("Asian size",
                <>
                  <Input value={sizeAsian} onChange={(e) => setSizeAsian(e.target.value)} placeholder="L / 170" list="wh-sizes-asian" className="scroll-mb-24" />
                  <datalist id="wh-sizes-asian">
                    {(suggestions?.sizeAsian ?? []).map((s) => <option key={s} value={s} />)}
                  </datalist>
                </>)}
              {field("EU size",
                <>
                  <Input value={sizeEU} onChange={(e) => setSizeEU(e.target.value)} placeholder="XL / 42" list="wh-sizes-eu" className="scroll-mb-24" />
                  <datalist id="wh-sizes-eu">
                    {(suggestions?.sizeEU ?? []).map((s) => <option key={s} value={s} />)}
                  </datalist>
                </>)}
            </div>

            {field("Barcode",
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type — optional" className="font-mono scroll-mb-24" />,
              "The code on the garment's own label. Linked to this item so it counts next time.")}

            {/* D35 — the rack half of the address. Free text with autocomplete
                from racks already in use, never a fixed list: the room gets
                rearranged by people carrying boxes. Pre-filled with the last
                rack used, because a run of new items is almost always one shelf. */}
            {field("Rack",
              <>
                <Input
                  value={rackCode}
                  onChange={(e) => setRackCode(e.target.value.toUpperCase())}
                  placeholder="L1, C3, R2, T1"
                  list="wh-rack-codes"
                  className="font-mono scroll-mb-24"
                />
                <datalist id="wh-rack-codes">
                  {(suggestions?.rackCode ?? []).map((r) => <option key={r} value={r} />)}
                </datalist>
              </>,
              "Whereabouts in the building. L = left, C = centre, R = right, T = rear wall, numbered out from the entrance.")}

            {field("Our SKU",
              <Input
                value={sku}
                onChange={(e) => { setSku(e.target.value.toUpperCase()); setSkuTouched(true); }}
                placeholder="KELME-K12345-NAVY-L"
                className="font-mono scroll-mb-24"
              />,
              skuTouched ? "Uppercase letters, digits and dashes, 20 characters or fewer." : "Written for you from the details above — edit if you'd rather.")}

            {field("Notes",
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Damage, faded print, wrong labels, mixed box, sample only..."
                className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-white/20 scroll-mb-24"
              />)}
          </div>

          <div className="sticky bottom-0 bg-[#0f1216] border-t border-white/10 px-4 py-3 flex gap-2">
            <Button variant="ghost" onClick={onClose} className="flex-1">Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave} className="flex-1 gap-1.5">
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackagePlus className="w-4 h-4" />}
              Register and count 1
            </Button>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

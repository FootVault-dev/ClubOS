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
  PackageCheck, MapPin, X, ChevronRight, PackagePlus, Search,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
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
  // D29 — the apparel attributes, so a count of forty shirts reads as four
  // models rather than forty unrelated rows. Optional: a roll of vinyl has none.
  vendor?: string | null;
  vendorModel?: string | null;
  colour?: string | null;
  sizeAsian?: string | null;
  sizeEU?: string | null;
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

/** Lines that share a vendor + model are the same garment in different colours
 *  and sizes, and belong under one heading. Anything without those attributes
 *  (materials, older imported stock) stands on its own — grouping items we know
 *  nothing about would invent a relationship that isn't there. */
function groupKeyFor(l: CountLine): string {
  const v = (l.vendor ?? "").trim().toUpperCase();
  const m = (l.vendorModel ?? "").trim().toUpperCase();
  return v || m ? `attr:${v}|${m}` : `item:${l.itemId}`;
}

interface LineGroup {
  key: string;
  vendor: string | null;
  model: string | null;
  title: string;
  lines: CountLine[];
  total: number;
}

/**
 * The heading for a group of variants. Item names carry the whole description —
 * "KELME Football Shorts Adults Navy L" — so using the first one verbatim would
 * print the vendor twice next to the vendor chip, and would label a heading
 * covering Navy L, Navy M and Red L as "Navy L".
 *
 * The words every member shares ARE the garment; the words they don't are the
 * variant. So take the common leading words and drop the vendor off the front.
 */
function groupTitle(names: string[], vendor: string | null): string {
  const split = names.map((n) => n.trim().split(/\s+/));
  let common: string[] = split[0] ?? [];
  for (const words of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < words.length && common[i].toLowerCase() === words[i].toLowerCase()) i++;
    common = common.slice(0, i);
  }
  // Everything identical (one member, or true duplicates) — keep the whole name.
  if (!common.length) common = split[0] ?? [];
  if (vendor) {
    const v = vendor.trim().toLowerCase().split(/\s+/);
    if (v.every((w, i) => common[i]?.toLowerCase() === w)) common = common.slice(v.length);
  }
  return common.join(" ").trim() || (names[0] ?? "");
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
        title: l.name,
        lines: [],
        total: 0,
      };
      byKey.set(key, g);
      out.push(g);
    }
    g.lines.push(l);
    g.total += l.counted;
  }
  for (const g of out) g.title = groupTitle(g.lines.map((l) => l.name), g.vendor);
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
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => { saveDraft(locationId, lines); }, [locationId, lines]);

  const { data: locations } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const countable = (locations ?? []).filter((l) => l.kind !== "virtual" && l.active);

  const focusScanner = useCallback(() => {
    requestAnimationFrame(() => manualRef.current?.focus());
  }, []);

  /** An item already in ClubOS carries its attributes in wh_item_fields, not in
   *  the scan response. Fetched once when a line first appears — never per scan
   *  — and merged in when it lands, so scanning stays instant and the grouping
   *  still becomes correct for the ~2,900 items imported from the shops. */
  const hydrateAttrs = useCallback(async (itemId: number) => {
    try {
      const r = await (await apiRequest("GET", `/api/admin/warehouse/fields/item/${itemId}`)).json();
      const d = r?.display ?? {};
      const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
      const attrs = {
        vendor: str(d.vendor), vendorModel: str(d.vendor_model), colour: str(d.colour),
        sizeAsian: str(d.size_asian), sizeEU: str(d.size_eu),
      };
      if (!Object.values(attrs).some(Boolean)) return;
      setLines((prev) => prev.map((l) => (l.itemId === itemId ? { ...l, ...attrs } : l)));
    } catch { /* attributes are decoration on a count — never block the scan */ }
  }, []);

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
        setRegister({ barcode: trimmed });
        return;
      }
      if (r.kind !== "item") {
        // A bin label or an asset tag scanned during a count IS a mis-scan —
        // say which, so it's obvious what happened.
        const what = r.kind === "location" ? "a bin label" : "an asset tag";
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
      if (navigator.vibrate) navigator.vibrate(15);
    } catch {
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
    <div className="p-4 sm:p-6 max-w-5xl space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Stock take</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Scan what's there — the count builds itself. Scan the same thing twice and it reads 2.
          </p>
        </div>
        <div className="space-y-1 min-w-[220px]">
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
        <a
          href="/api/admin/warehouse/stock.csv"
          className="px-3 py-2 rounded-lg text-sm text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
        >
          <Download className="w-4 h-4" /> Export CSV
        </a>
        {lines.length > 0 && (
          <Button variant="ghost" onClick={() => { setLines([]); saveDraft("", []); }}>Clear</Button>
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
              <div className="text-center py-12">
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
                      <div className="grid grid-cols-[1.2fr_70px_70px_1.4fr_150px_40px] gap-2 px-2 py-1.5 text-[10px] uppercase tracking-wide text-white/30 font-bold">
                        <span>Colour</span><span>Asian</span><span>EU</span><span>Our SKU</span>
                        <span className="text-center">Qty</span><span />
                      </div>
                      {g.lines.map((l) => (
                        <div key={l.itemId} className="grid grid-cols-[1.2fr_70px_70px_1.4fr_150px_40px] gap-2 px-2 py-1.5 items-center rounded-lg hover:bg-white/[0.03]">
                          <span className="text-sm text-white/80 truncate">{l.colour ?? l.name}</span>
                          <span className="text-sm text-white/60 truncate">{l.sizeAsian ?? "—"}</span>
                          <span className="text-sm text-white/60 truncate">{l.sizeEU ?? "—"}</span>
                          <span className="text-[11px] text-white/35 font-mono truncate">{l.sku}</span>
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
          onClose={() => { setRegister(null); focusScanner(); }}
          onRegistered={(line) => {
            addLine({ ...line, counted: 1 }, false);
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
}: {
  barcode: string;
  onClose: () => void;
  onRegistered: (line: CountLine) => void;
}) {
  const { toast } = useToast();
  const [vendor, setVendor] = useState("");
  const [title, setTitle] = useState("");
  const [vendorModel, setVendorModel] = useState("");
  const [colour, setColour] = useState("");
  const [sizeAsian, setSizeAsian] = useState("");
  const [sizeEU, setSizeEU] = useState("");
  const [notes, setNotes] = useState("");
  const [code, setCode] = useState(barcode);
  const [sku, setSku] = useState("");
  const [skuTouched, setSkuTouched] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

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
      })).json(),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/items"] });
      toast({ title: "Registered", description: `${r.item.sku} — counted 1` });
      onRegistered({
        itemId: r.item.id, sku: r.item.sku, name: r.item.name, counted: 1,
        vendor: r.line?.vendor ?? null, vendorModel: r.line?.vendorModel ?? null,
        colour: r.line?.colour ?? null, sizeAsian: r.line?.sizeAsian ?? null, sizeEU: r.line?.sizeEU ?? null,
      });
    },
    onError: (e: any) => toast({ title: "Couldn't register that", description: e.message, variant: "destructive" }),
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
      <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center">
        <div className="absolute inset-0 bg-black/70" onClick={onClose} />
        <div className="relative w-full sm:max-w-lg sm:rounded-2xl bg-[#0f1216] border border-white/10 mt-auto sm:mt-0 max-h-[92vh] overflow-y-auto">
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
              {field("Vendor", <Input ref={firstRef} value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="KELME" className="scroll-mb-24" />)}
              {field("Vendor model", <Input value={vendorModel} onChange={(e) => setVendorModel(e.target.value)} placeholder="K123-45" className="scroll-mb-24" />)}
            </div>

            {field("Title", <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Football Shorts Adults" className="scroll-mb-24" />,
              "Left blank, we'll name it from the vendor, model and colour.")}

            {field("Colour", <Input value={colour} onChange={(e) => setColour(e.target.value)} placeholder="Navy" className="scroll-mb-24" />)}

            <div className="grid grid-cols-2 gap-3">
              {field("Asian size", <Input value={sizeAsian} onChange={(e) => setSizeAsian(e.target.value)} placeholder="L / 170" className="scroll-mb-24" />)}
              {field("EU size", <Input value={sizeEU} onChange={(e) => setSizeEU(e.target.value)} placeholder="XL / 42" className="scroll-mb-24" />)}
            </div>

            {field("Barcode",
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan or type — optional" className="font-mono scroll-mb-24" />,
              "The code on the garment's own label. Linked to this item so it counts next time.")}

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

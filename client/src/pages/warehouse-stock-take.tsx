// Stock take (D27) — walk the racks with a scanner and put real numbers in.
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
// Both input methods work: the phone camera and a USB/Bluetooth scanner
// (client/src/lib/wedge-scanner.ts — it types and presses Enter, so the page
// listens at document level and never steals what you're typing in a box).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ScanLine, Plus, Minus, Trash2, Loader2, Download, CheckCircle2, AlertTriangle,
  Keyboard, PackageCheck, MapPin, X,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { feedWedgeKey, shouldIgnoreWedgeTarget, EMPTY_WEDGE, type WedgeState } from "@/lib/wedge-scanner";
import { locationLabel } from "@shared/warehouse";
import type { WhLocation } from "@shared/schema";

interface CountLine {
  itemId: number;
  sku: string;
  name: string;
  counted: number;
}

/** Survives a reload / the phone locking mid-count — an hour of scanning must
 *  not be lost to a stray tab close before it's posted. */
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

export default function WarehouseStockTake() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const draft = useRef(loadDraft());

  const [locationId, setLocationId] = useState(draft.current?.locationId ?? "");
  const [lines, setLines] = useState<CountLine[]>(draft.current?.lines ?? []);
  const [manual, setManual] = useState("");
  const [lastScan, setLastScan] = useState<{ sku: string; counted: number } | null>(null);
  const [posted, setPosted] = useState<any | null>(null);
  const manualRef = useRef<HTMLInputElement>(null);

  useEffect(() => { saveDraft(locationId, lines); }, [locationId, lines]);

  const { data: locations } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const countable = (locations ?? []).filter((l) => l.kind !== "virtual" && l.active);

  /** Adds one scan to the tally. Same code twice = 2, not a duplicate row. */
  const addScan = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const r = await (await apiRequest("POST", "/api/admin/warehouse/scan", { code: trimmed })).json();
      if (r.kind !== "item") {
        // An asset tag or a bin label scanned during a count is a mis-scan,
        // not stock — say which so it's obvious what happened.
        const what = r.kind === "location" ? "a bin label" : r.kind === "instance" ? "an asset tag" : "not recognised";
        toast({ title: `That's ${what}`, description: trimmed, variant: "destructive" });
        return;
      }
      const item = r.item;
      // A case barcode counts as its pack quantity, not one (D5).
      const add = r.packQty && r.packQty > 1 ? r.packQty : 1;
      setLines((prev) => {
        const i = prev.findIndex((l) => l.itemId === item.id);
        if (i === -1) return [...prev, { itemId: item.id, sku: item.sku, name: item.name, counted: add }];
        const next = [...prev];
        next[i] = { ...next[i], counted: next[i].counted + add };
        return next;
      });
      setLastScan({ sku: item.sku, counted: 0 });
      if (navigator.vibrate) navigator.vibrate(15);
    } catch {
      toast({ title: "Couldn't look that code up", description: trimmed, variant: "destructive" });
    }
  }, [toast]);

  // USB / Bluetooth scanner, exactly as on the scan station.
  const wedge = useRef<WedgeState>(EMPTY_WEDGE);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (shouldIgnoreWedgeTarget(e.target)) return;
      const r = feedWedgeKey(wedge.current, { key: e.key, at: e.timeStamp || Date.now() });
      wedge.current = r.state;
      if (r.kind === "scan") { e.preventDefault(); addScan(r.code); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addScan]);

  const total = useMemo(() => lines.reduce((n, l) => n + l.counted, 0), [lines]);

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
  return (
    <div className="p-4 sm:p-6 max-w-2xl space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Stock take</h1>
          <p className="text-sm text-white/40 mt-0.5">
            Scan what's there — the count builds itself. Scan the same thing twice and it reads 2.
          </p>
        </div>
        <a
          href="/api/admin/warehouse/stock.csv"
          className="px-3 py-2 rounded-lg text-xs text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
        >
          <Download className="w-3.5 h-3.5" /> Export CSV
        </a>
      </div>

      <div className="space-y-1">
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

      <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04] p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-blue-200/80">
          <ScanLine className="w-4 h-4" /> Pull the scanner trigger, or type a code and press Enter
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
                requestAnimationFrame(() => manualRef.current?.focus());
              }
            }}
            placeholder="Scan or type a barcode / SKU"
            className="font-mono scroll-mb-24"
          />
          <Button
            onClick={() => { if (manual.trim()) { addScan(manual); setManual(""); manualRef.current?.focus(); } }}
            disabled={!manual.trim()}
          >
            Add
          </Button>
        </div>
        {lastScan && <div className="text-[11px] text-emerald-400/80">Last: {lastScan.sku}</div>}
      </div>

      {lines.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-white/10 rounded-xl">
          <PackageCheck className="w-8 h-8 text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/50">Nothing counted yet.</p>
          <p className="text-xs text-white/30 mt-1">Scan the first thing at this location.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
          <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between text-xs">
            <span className="text-white/50">{lines.length} product(s)</span>
            <span className="text-white/70">{total} item(s) counted</span>
          </div>
          {lines.map((l) => (
            <div key={l.itemId} className="px-3 py-2 flex items-center gap-2 border-b border-white/[0.04]">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white/85 truncate">{l.name}</div>
                <div className="text-[11px] text-white/30 font-mono truncate">{l.sku}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setQty(l.itemId, l.counted - 1)}
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/60"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <Input
                  type="number"
                  value={l.counted}
                  onChange={(e) => setQty(l.itemId, Number(e.target.value))}
                  className="w-16 text-center scroll-mb-24"
                />
                <button
                  onClick={() => setQty(l.itemId, l.counted + 1)}
                  className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white/60"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setLines((p) => p.filter((x) => x.itemId !== l.itemId))}
                  className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 sticky bottom-0 py-3 bg-[#0a0b0d]">
          <Button
            onClick={() => post.mutate()}
            disabled={!locationId || post.isPending}
            className="gap-1.5"
          >
            {post.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <PackageCheck className="w-4 h-4" />}
            Add {total} to the warehouse
          </Button>
          <Button variant="ghost" onClick={() => { setLines([]); saveDraft("", []); }}>Clear</Button>
          {!locationId && <span className="text-[11px] text-amber-400/70">Pick a location first</span>}
        </div>
      )}

      {lines.length > 0 && (
        <p className="text-[11px] text-white/30 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          This sets the quantity at that location to what you counted — it doesn't add to what's already recorded.
        </p>
      )}
    </div>
  );
}

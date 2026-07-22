// Label printing (T14, SPEC §4.4/D5). Renders QR codes CLIENT-SIDE as SVG
// (the `qrcode` npm package) — the server's label-payload endpoints
// (`GET /api/admin/warehouse/labels/items|locations`, T4) only ever hand back
// the string each QR should encode, never an image. Item labels encode the
// bare SKU; bin labels encode `LOC:<code>` (shared/warehouse.ts's
// `locationBarcodePayload`, the same helper T7's scan resolver decodes with).
//
// One page, two label KINDS (item / location) and two SHEET layouts:
//   - "single"  — one label per printed page, sized exactly 50x25mm, for a
//                 dedicated label printer (Dymo/Zebra-style, feeds one at a
//                 time).
//   - "grid"    — an A4 sheet tiled 4-across (200mm content width fits a
//                 5mm-margin A4 exactly), for United Print's own printers.
//
// The print area is real mm-sized boxes on screen too (a genuine WYSIWYG
// preview, not a separate "print view") — `@media print` just hides the
// picker chrome and lets the label boxes fill the printed page. Hiding via
// `visibility` (not `display`) on `body *` + `position: fixed` on the print
// area is the standard "print only this element" trick and is robust to
// whatever the surrounding admin layout/sidebar renders, since this page
// doesn't control that markup.
//
// T16a's future Items/Locations admin pages can deep-link here with
// `?kind=item|location&ids=1,2,3` to preselect a "Print label(s)" click —
// this page reads that on mount but doesn't require it (works standalone too).
// Route wiring (`App.tsx`) is T17's job, not this task's.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import QRCode from "qrcode";
import { Search, Printer, Tags, MapPin, CheckSquare, Square, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/lib/queryClient";
import { locationBarcodePayload } from "@shared/warehouse";
import type { WhItem, WhLocation } from "@shared/schema";

type LabelKind = "item" | "location";
type SheetLayout = "single" | "grid";

interface WhItemRow extends WhItem {
  defaultLocationCode: string | null;
}

function parseIdCsv(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function toggleId(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ── QR rendering — client-side SVG only, never a server-generated image ────
// A module-level cache: the same payload (e.g. re-selecting an item across a
// search-then-clear cycle) never re-renders the QR twice.
const qrSvgCache = new Map<string, string>();

function useQrSvg(value: string): string {
  const [svg, setSvg] = useState<string>(() => qrSvgCache.get(value) ?? "");
  useEffect(() => {
    if (!value) {
      setSvg("");
      return;
    }
    const cached = qrSvgCache.get(value);
    if (cached !== undefined) {
      setSvg(cached);
      return;
    }
    let cancelled = false;
    QRCode.toString(value, { type: "svg", margin: 0, errorCorrectionLevel: "M" })
      .then((s) => {
        qrSvgCache.set(value, s);
        if (!cancelled) setSvg(s);
      })
      .catch(() => {
        if (!cancelled) setSvg("");
      });
    return () => {
      cancelled = true;
    };
  }, [value]);
  return svg;
}

function QrGlyph({ value }: { value: string }) {
  const svg = useQrSvg(value);
  return <div className="wh-label-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function ItemLabelCard({ item }: { item: WhItemRow }) {
  return (
    <div className="wh-label">
      <QrGlyph value={item.sku} />
      <div className="wh-label-text">
        <div className="wh-label-primary">{item.sku}</div>
        <div className="wh-label-secondary">{item.name}</div>
      </div>
    </div>
  );
}

function LocationLabelCard({ location }: { location: WhLocation }) {
  return (
    <div className="wh-label">
      <QrGlyph value={locationBarcodePayload(location.code)} />
      <div className="wh-label-text">
        <div className="wh-label-primary">{location.code}</div>
        <div className="wh-label-secondary">{location.zone ?? location.kind}</div>
      </div>
    </div>
  );
}

export default function WarehouseLabels() {
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);

  const [kind, setKind] = useState<LabelKind>(() => (params.get("kind") === "location" ? "location" : "item"));
  const [layout, setLayout] = useState<SheetLayout>("grid");
  const [q, setQ] = useState("");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(
    () => new Set(params.get("kind") !== "location" ? parseIdCsv(params.get("ids")) : []),
  );
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<number>>(
    () => new Set(params.get("kind") === "location" ? parseIdCsv(params.get("ids")) : []),
  );

  const { data: items = [], isLoading: itemsLoading } = useQuery<WhItemRow[]>({
    queryKey: ["/api/admin/warehouse/items", "labels", "active"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/items?active=true")).json(),
  });
  const { data: locations = [], isLoading: locationsLoading } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations", "labels", "active"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations?active=true")).json(),
  });

  const filteredItems = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter(
      (i) =>
        i.sku.toLowerCase().includes(term) ||
        i.name.toLowerCase().includes(term) ||
        (i.category ?? "").toLowerCase().includes(term),
    );
  }, [items, q]);

  const filteredLocations = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return locations;
    return locations.filter(
      (l) => l.code.toLowerCase().includes(term) || (l.zone ?? "").toLowerCase().includes(term),
    );
  }, [locations, q]);

  const selectedItems = useMemo(() => items.filter((i) => selectedItemIds.has(i.id)), [items, selectedItemIds]);
  const selectedLocations = useMemo(
    () => locations.filter((l) => selectedLocationIds.has(l.id)),
    [locations, selectedLocationIds],
  );

  const isLoading = kind === "item" ? itemsLoading : locationsLoading;
  const activeCount = kind === "item" ? selectedItems.length : selectedLocations.length;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <style>{`
        .wh-label {
          width: 50mm;
          height: 25mm;
          box-sizing: border-box;
          padding: 2mm;
          display: flex;
          align-items: center;
          gap: 2mm;
          background: #fff;
          color: #000;
          overflow: hidden;
          border: 0.2mm dashed #999;
          break-inside: avoid;
        }
        .wh-label-qr { width: 19mm; height: 19mm; flex-shrink: 0; }
        .wh-label-qr svg { width: 100%; height: 100%; display: block; }
        .wh-label-text { min-width: 0; }
        .wh-label-primary {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-weight: 700;
          font-size: 3.6mm;
          line-height: 1.15;
          word-break: break-all;
        }
        .wh-label-secondary {
          font-size: 2.6mm;
          line-height: 1.2;
          margin-top: 0.6mm;
          color: #333;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .wh-sheet-grid {
          display: grid;
          grid-template-columns: repeat(4, 50mm);
          grid-auto-rows: 25mm;
        }
        .wh-sheet-singles { display: flex; flex-wrap: wrap; gap: 4mm; }
        .wh-label-page { break-inside: avoid; }
        @media print {
          .wh-print-hide { display: none !important; }
          body * { visibility: hidden; }
          .wh-print-area, .wh-print-area * { visibility: visible; }
          .wh-print-area {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
          }
          .wh-sheet-singles { gap: 0; }
          .wh-sheet-singles .wh-label-page { break-after: page; }
          .wh-sheet-singles .wh-label-page:last-child { break-after: auto; }
        }
      `}</style>
      {layout === "single" ? (
        <style>{`@media print { @page { size: 50mm 25mm; margin: 0; } }`}</style>
      ) : (
        <style>{`@media print { @page { size: A4; margin: 5mm; } }`}</style>
      )}

      <div className="wh-print-hide">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-white">Print labels</h1>
            <p className="text-sm text-white/40 mt-0.5">
              QR item labels (SKU) and bin labels (LOC:code) — 50×25mm singles or an A4 sheet.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setKind("item")}
              className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 border ${
                kind === "item"
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-white/[0.02] border-white/10 text-white/60 hover:bg-white/[0.06]"
              }`}
            >
              <Tags className="w-3.5 h-3.5" /> Item labels
            </button>
            <button
              onClick={() => setKind("location")}
              className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 border ${
                kind === "location"
                  ? "bg-blue-600 border-blue-600 text-white"
                  : "bg-white/[0.02] border-white/10 text-white/60 hover:bg-white/[0.06]"
              }`}
            >
              <MapPin className="w-3.5 h-3.5" /> Bin labels
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-5">
          {/* Picker */}
          <div className="lg:col-span-2 rounded-2xl border border-white/5 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
                <Input
                  type="text"
                  placeholder={kind === "item" ? "Search SKU, name, category..." : "Search bin code, zone..."}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="pl-10 bg-white/[0.02] border-white/10 text-white"
                />
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() =>
                    kind === "item"
                      ? setSelectedItemIds(new Set(filteredItems.map((i) => i.id)))
                      : setSelectedLocationIds(new Set(filteredLocations.map((l) => l.id)))
                  }
                  className="text-xs text-blue-400/80 hover:text-blue-400 flex items-center gap-1"
                >
                  <CheckSquare className="w-3.5 h-3.5" /> Select all
                </button>
                <button
                  onClick={() => (kind === "item" ? setSelectedItemIds(new Set()) : setSelectedLocationIds(new Set()))}
                  className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1"
                >
                  <Square className="w-3.5 h-3.5" /> Clear
                </button>
              </div>
            </div>

            {isLoading ? (
              <div className="py-10 flex items-center justify-center gap-2 text-white/40 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading...
              </div>
            ) : kind === "item" ? (
              filteredItems.length === 0 ? (
                <div className="py-10 text-center text-sm text-white/30">No items found.</div>
              ) : (
                <div className="max-h-[440px] overflow-y-auto space-y-1 pr-1">
                  {filteredItems.map((item) => {
                    const checked = selectedItemIds.has(item.id);
                    return (
                      <label
                        key={item.id}
                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/[0.04] cursor-pointer"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => setSelectedItemIds((prev) => toggleId(prev, item.id))}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-white font-mono truncate">{item.sku}</div>
                          <div className="text-[11px] text-white/40 truncate">{item.name}</div>
                        </div>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/50 flex-shrink-0">
                          {item.brandOwner}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )
            ) : filteredLocations.length === 0 ? (
              <div className="py-10 text-center text-sm text-white/30">No locations found.</div>
            ) : (
              <div className="max-h-[440px] overflow-y-auto space-y-1 pr-1">
                {filteredLocations.map((loc) => {
                  const checked = selectedLocationIds.has(loc.id);
                  return (
                    <label
                      key={loc.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/[0.04] cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => setSelectedLocationIds((prev) => toggleId(prev, loc.id))}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-white font-mono truncate">{loc.code}</div>
                        <div className="text-[11px] text-white/40 truncate">{loc.zone ?? loc.kind}</div>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/50 flex-shrink-0">
                        {loc.kind}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sheet options */}
          <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 space-y-4 h-fit">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2">Sheet layout</div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
                  <input
                    type="radio"
                    name="wh-layout"
                    checked={layout === "grid"}
                    onChange={() => setLayout("grid")}
                  />
                  A4 sheet (grid of labels)
                </label>
                <label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
                  <input
                    type="radio"
                    name="wh-layout"
                    checked={layout === "single"}
                    onChange={() => setLayout("single")}
                  />
                  Single labels (50×25mm each)
                </label>
              </div>
            </div>
            <div className="pt-2 border-t border-white/5">
              <div className="text-sm text-white/70 mb-3">
                {activeCount} label{activeCount === 1 ? "" : "s"} selected
              </div>
              <button
                onClick={() => window.print()}
                disabled={activeCount === 0}
                className="w-full px-3 py-2 rounded-lg text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Printer className="w-4 h-4" /> Print {activeCount > 0 ? activeCount : ""} label{activeCount === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className="wh-print-hide text-[10px] uppercase tracking-wider text-white/30 mb-3 px-1">
            Preview — what will print (actual size)
          </div>
          {activeCount === 0 && (
            <div className="wh-print-hide rounded-2xl border border-white/5 bg-black/30 p-10 text-center text-sm text-white/30">
              Select {kind === "item" ? "items" : "bins"} above to preview their labels.
            </div>
          )}
        </div>
      </div>

      {/* The actual print source — deliberately OUTSIDE .wh-print-hide (an
          ancestor's `display: none` unconditionally hides descendants, so
          this can't live inside the chrome that print hides). Nested here,
          not a sibling, so it doubles as the on-screen "actual size"
          preview: the wrapper below has no `wh-print-hide` class, so on
          screen it just renders as a bordered box; in print, `body * {
          visibility: hidden }` hides the wrapper's own border/background
          (visibility, not display, so its children CAN override it) while
          `.wh-print-area`'s `position: fixed` breaks it out of the
          wrapper's flow onto the page regardless. */}
      {activeCount > 0 && (
        <div className="rounded-2xl border border-white/5 bg-black/30 p-6 overflow-x-auto">
          <div className="wh-print-area" data-layout={layout}>
            {layout === "single" ? (
              <div className="wh-sheet-singles">
                {(kind === "item" ? selectedItems : selectedLocations).map((entry) => (
                  <div className="wh-label-page" key={entry.id}>
                    {kind === "item" ? (
                      <ItemLabelCard item={entry as WhItemRow} />
                    ) : (
                      <LocationLabelCard location={entry as WhLocation} />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="wh-sheet-grid">
                {(kind === "item" ? selectedItems : selectedLocations).map((entry) =>
                  kind === "item" ? (
                    <ItemLabelCard key={entry.id} item={entry as WhItemRow} />
                  ) : (
                    <LocationLabelCard key={entry.id} location={entry as WhLocation} />
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

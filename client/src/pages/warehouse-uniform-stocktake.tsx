// Uniform Stocktake — a faithful rebuild of Dima's own prototype
// (~/Downloads/stock-scanner.html, 12 Aug 2026), inside ClubOS.
//
// Everything he built is here: the navy scan panel, the big flash, the three
// stat tiles, the model → variant table with photos, "+ var.", the combined
// new-variant/new-model modal, the model editor, CSV export with a paste
// fallback, "New stocktake", the three sound cues, and the focus discipline
// that keeps the cursor in the scan box no matter what you click.
//
// Two deliberate differences from the prototype, both because this one is real:
//
//  1. 🔴 The catalogue lives in Postgres, not a localStorage blob. So two people
//     can count different racks, a model Dima registers survives his laptop, and
//     every scan has a named operator behind it.
//  2. 🔴 "New stocktake" POSTS the count to the append-only ledger before it
//     resets. His prototype zeroes the tally, which is right when the tally IS
//     the stock figure; here stock is derived from movements, so silently
//     discarding a finished count would lose real data. The confirm says so.
//
// The running tally itself is client-side with a localStorage draft — exactly
// like his — so a scan never waits on a round-trip and a reload mid-count loses
// nothing.
//
// It is LIGHT-THEMED on purpose, inside a dark admin: his design, and the right
// call for a screen read at arm's length in a warehouse. His tokens are used
// verbatim (see STYLES) rather than mapped onto ClubOS utilities, so it looks
// like the thing he approved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  isMuted, setMuted, primeAudio, soundCounted, soundUnknown, soundSaved, soundError,
} from "@/lib/scan-sounds";

// ── His CSS, verbatim where it matters ──────────────────────────────────────
const STYLES = `
.ust{--navy:#12233f;--blue:#1d3a68;--blue-mid:#3660a5;--blue-light:#eaf0fa;--paper:#f7f8fb;
  --ink:#141a24;--amber:#e0a030;--green:#2f9e58;--red:#c94b3f;--line:#dbe2ee;
  --mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace;
  --sans:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--paper);color:var(--ink);font-family:var(--sans);min-height:100%;
  -webkit-font-smoothing:antialiased;}
.ust *{box-sizing:border-box;}
.ust .app{max-width:1100px;margin:0 auto;padding:20px 20px 80px;}
.ust header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap;}
.ust header h1{font-size:19px;margin:0;letter-spacing:.2px;color:var(--navy);display:flex;align-items:center;gap:10px;}
.ust header h1 .badge{background:var(--blue);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;letter-spacing:.6px;}
.ust .session-meta{font-size:12px;color:#5b6472;}
.ust .scan-panel{background:var(--navy);border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:10px;margin-bottom:18px;box-shadow:0 8px 22px -12px rgba(18,35,63,.55);}
.ust .scan-label{color:#a9bbdb;font-size:12px;text-transform:uppercase;letter-spacing:1.2px;font-weight:600;}
.ust .scan-input{width:100%;font-family:var(--mono);font-size:22px;padding:14px 16px;border-radius:9px;border:2px solid transparent;outline:none;background:#0d1a2e;color:#f0f4fb;letter-spacing:1px;}
.ust .scan-input:focus{border-color:var(--amber);}
.ust .scan-input::placeholder{color:#5c6f92;}
.ust .flash{min-height:52px;display:flex;align-items:center;gap:14px;font-family:var(--mono);color:#fff;font-size:14px;opacity:0;transform:translateY(-4px);transition:opacity .18s ease,transform .18s ease;}
.ust .flash.show{opacity:1;transform:translateY(0);}
.ust .flash .qty-pop{font-size:30px;font-weight:800;color:var(--amber);min-width:52px;text-align:center;background:rgba(224,160,48,.12);border-radius:8px;padding:2px 10px;}
.ust .flash .flash-name{font-weight:600;font-size:15px;}
.ust .flash .flash-sub{color:#9fb0cf;font-size:12px;}
.ust .flash.new .qty-pop{color:var(--green);background:rgba(47,158,88,.14);}
.ust .stats{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;}
.ust .stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 16px;flex:1;min-width:120px;}
.ust .stat .n{font-family:var(--mono);font-size:22px;font-weight:700;color:var(--navy);}
.ust .stat .l{font-size:11px;color:#6a7383;text-transform:uppercase;letter-spacing:.6px;margin-top:2px;}
.ust .toolbar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;}
.ust .search{flex:1;min-width:160px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);font-size:14px;background:#fff;color:var(--ink);}
.ust button{font-family:var(--sans);cursor:pointer;border:none;border-radius:8px;padding:10px 14px;font-size:13px;font-weight:600;transition:filter .12s ease;}
.ust button:hover:not(:disabled){filter:brightness(.94);} .ust button:active:not(:disabled){filter:brightness(.88);}
.ust button:disabled{opacity:.55;cursor:default;}
.ust .btn-primary{background:var(--blue);color:#fff;}
.ust .btn-ghost{background:#fff;color:var(--blue);border:1px solid var(--line);}
.ust .btn-danger{background:#fff;color:var(--red);border:1px solid #f0d3cf;}
.ust .btn-warn{background:var(--amber);color:#3a2600;}
.ust .table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--line);background:#fff;}
.ust table{width:100%;border-collapse:collapse;min-width:860px;}
.ust thead th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6a7383;background:var(--blue-light);padding:10px 12px;font-weight:700;white-space:nowrap;}
.ust tbody td{padding:10px 12px;border-top:1px solid var(--line);font-size:13.5px;vertical-align:middle;}
.ust tr.product-row{cursor:pointer;}
.ust tr.product-row:hover{background:#fbfcfe;}
.ust tr.product-row.expanded{background:var(--blue-light);}
.ust .chevron{display:inline-block;transition:transform .15s ease;color:#8a93a3;width:14px;}
.ust tr.product-row.expanded .chevron{transform:rotate(90deg);color:var(--blue);}
.ust td.vendor{font-weight:700;color:var(--navy);}
.ust td.model{font-family:var(--mono);font-weight:600;}
.ust td.sku{font-family:var(--mono);color:#6a7383;font-size:12px;}
.ust .qty-total{font-family:var(--mono);font-weight:800;font-size:16px;}
.ust .variant-count{font-size:11px;color:#8a93a3;}
.ust .thumb{width:36px;height:36px;border-radius:7px;object-fit:cover;display:block;border:1px solid var(--line);background:#f1f3f8;}
.ust .thumb-placeholder{width:36px;height:36px;border-radius:7px;border:1px dashed var(--line);display:flex;align-items:center;justify-content:center;color:#c3cadb;font-size:14px;}
.ust .variants-cell{padding:0 !important;border-top:none !important;}
.ust .variants-box{padding:6px 12px 16px 46px;background:#fcfdff;}
.ust .variants-box table{min-width:0;background:transparent;border:1px solid var(--line);border-radius:8px;overflow:hidden;}
.ust .variants-box thead th{background:#f1f4fa;font-size:10px;padding:7px 10px;}
.ust .variants-box tbody td{padding:7px 10px;font-size:13px;}
.ust .variants-box tbody tr:hover{background:#f4f7fc;}
.ust .no-variants{padding:14px 4px;color:#8a93a3;font-size:12.5px;}
.ust .barcode-cell{font-family:var(--mono);color:#8a93a3;font-size:12px;}
.ust .loc-tag{font-family:var(--mono);font-weight:700;font-size:12px;color:var(--blue-mid);background:var(--blue-light);padding:2px 7px;border-radius:5px;}
.ust .qty-cell{display:flex;align-items:center;gap:6px;}
.ust .qty-cell .q{font-family:var(--mono);font-weight:800;font-size:15px;min-width:28px;text-align:center;}
.ust .mini{width:24px;height:24px;border-radius:6px;padding:0;font-size:13px;line-height:1;}
.ust .row-actions{display:flex;gap:6px;}
.ust .row-actions button{padding:5px 8px;font-size:12px;}
.ust .empty-row td{text-align:center;color:#8a93a3;padding:30px;font-size:13px;}
.ust .notes-flag{color:var(--amber);font-size:13px;margin-left:4px;cursor:help;}
.ust .overlay{position:fixed;inset:0;background:rgba(18,26,36,.55);display:flex;align-items:center;justify-content:center;z-index:60;padding:16px;}
.ust .modal{background:#fff;border-radius:12px;padding:24px;width:100%;max-width:440px;box-shadow:0 20px 50px -20px rgba(0,0,0,.4);max-height:90vh;overflow-y:auto;}
.ust .modal.wide{max-width:640px;}
.ust .modal h2{margin:0 0 4px;font-size:16px;color:var(--navy);}
.ust .modal .msub{font-family:var(--mono);font-size:12px;color:#8a93a3;margin-bottom:16px;}
.ust .field{margin-bottom:12px;}
.ust .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#6a7383;margin-bottom:4px;font-weight:700;}
.ust .field input,.ust .field select{width:100%;padding:9px 11px;border-radius:7px;border:1px solid var(--line);font-size:14px;font-family:var(--sans);background:#fff;color:var(--ink);}
.ust .field textarea{width:100%;padding:9px 11px;border-radius:7px;border:1px solid var(--line);font-size:14px;font-family:var(--sans);background:#fff;color:var(--ink);resize:vertical;min-height:56px;}
.ust .field-row{display:flex;gap:10px;} .ust .field-row .field{flex:1;}
.ust .modal-actions{display:flex;gap:8px;margin-top:18px;} .ust .modal-actions button{flex:1;}
.ust .section-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--blue-mid);font-weight:800;margin:16px 0 8px;border-top:1px solid var(--line);padding-top:14px;}
.ust .photo-field{display:flex;align-items:center;gap:12px;}
.ust .photo-preview{width:60px;height:60px;border-radius:9px;object-fit:cover;border:1px solid var(--line);background:#f1f3f8;flex-shrink:0;}
.ust .photo-ph{width:60px;height:60px;border-radius:9px;border:1px dashed var(--line);display:flex;align-items:center;justify-content:center;color:#c3cadb;font-size:20px;flex-shrink:0;}
.ust .photo-actions{display:flex;flex-direction:column;gap:6px;}
.ust .photo-actions input[type=file]{font-size:12px;} .ust .photo-actions button{padding:6px 10px;font-size:12px;}
.ust .export-ta{width:100%;height:160px;font-family:var(--mono);font-size:11px;padding:10px;border-radius:7px;border:1px solid var(--line);resize:vertical;}
@media (max-width:640px){
  .ust .app{padding:14px 12px 70px;}
  .ust .scan-input{font-size:19px;}
  .ust .variants-box{padding:6px 8px 14px 12px;}
}
`;

// ── Types ───────────────────────────────────────────────────────────────────
type Model = {
  id: number; vendor: string | null; title: string; vendorModel: string | null;
  sku: string | null; notes: string | null; imageUrl: string | null; variantCount: number;
};
type Item = {
  id: number; sku: string; name: string; modelId: number | null;
  rackCode: string | null; notes: string | null; trackingMode: string; active: boolean;
};
type VariantDetail = {
  itemId: number; modelId: number | null; modelTitle: string | null; modelVendor: string | null;
  modelVendorModel: string | null; colour: string | null; sizeAsian: string | null;
  sizeEU: string | null; rackCode: string | null; locationId: number | null; barcode: string | null;
};
type WhLocation = { id: number; code: string; name: string | null; kind: string; active: boolean };
type Suggestions = { vendor: string[]; colour: string[]; sizeAsian: string[]; sizeEU: string[]; rackCode: string[] };

type Variant = Item & { colour: string | null; sizeAsian: string | null; sizeEU: string | null; barcode: string | null };

const DRAFT_KEY = "wh_uniform_stocktake_v1";
type Draft = { counts: Record<number, number>; sessionStart: string };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && typeof d.counts === "object") return { counts: d.counts, sessionStart: d.sessionStart || new Date().toISOString() };
    }
  } catch { /* corrupt draft is not worth a crash */ }
  return { counts: {}, sessionStart: new Date().toISOString() };
}
function saveDraft(d: Draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* private mode */ }
}

/** 12/08/2026 19:39 — his format, en-GB, no Date maths. */
function sessionLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB")} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** His resize: longest edge 300px, JPEG 0.7 — ~15–25KB, small enough to store inline. */
function resizeImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const max = 300;
        let w = img.width, h = img.height;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d")!.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.7));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function Datalist({ id, values }: { id: string; values: string[] }) {
  return <datalist id={id}>{values.map((v) => <option key={v} value={v} />)}</datalist>;
}

export default function WarehouseUniformStocktake() {
  const { toast } = useToast();
  const scanRef = useRef<HTMLInputElement>(null);

  const [draft] = useState<Draft>(() => loadDraft());
  const [counts, setCounts] = useState<Record<number, number>>(draft.counts);
  const [sessionStart, setSessionStart] = useState(draft.sessionStart);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [muted, setMutedState] = useState(isMuted);
  const [flash, setFlash] = useState<{ kind: "show" | "new"; qty: string; name: string; sub: string } | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [locationId, setLocationId] = useState<string>("");

  const [variantModal, setVariantModal] = useState<
    | { mode: "new"; barcode: string; lockModelId: number | null }
    | { mode: "edit"; variant: Variant }
    | null
  >(null);
  const [modelModal, setModelModal] = useState<Model | null>(null);
  const [exportCsv, setExportCsv] = useState<string | null>(null);
  const [confirmAsk, setConfirmAsk] = useState<{ title: string; msg: string; onYes: () => void } | null>(null);

  useEffect(() => { saveDraft({ counts, sessionStart }); }, [counts, sessionStart]);

  // ── Data ────────────────────────────────────────────────────────────────
  const { data: models = [], isLoading: loadingModels } = useQuery<Model[]>({
    queryKey: ["/api/admin/warehouse/models"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/models")).json(),
  });
  const { data: items = [], isLoading: loadingItems } = useQuery<Item[]>({
    queryKey: ["/api/admin/warehouse/items"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/items")).json(),
  });
  // 🔴 The ledger post requires a REAL location: a count says "there are N of
  // this at this place". Dima's prototype has a free-text location per variant
  // (kept, as rackCode) but no session location, so this picks one up — his
  // rack codes stay the fine-grained detail, this is where the movement lands.
  const { data: locations = [] } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });
  const countable = useMemo(() => locations.filter((l) => l.kind !== "virtual" && l.active), [locations]);

  const { data: suggestions } = useQuery<Suggestions>({
    queryKey: ["/api/admin/warehouse/suggestions"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/suggestions")).json(),
  });

  useEffect(() => {
    if (!locationId && countable.length) setLocationId(String(countable[0].id));
  }, [countable, locationId]);

  const stockItems = useMemo(() => items.filter((i) => i.trackingMode === "stock" && i.active), [items]);

  const { data: details = [] } = useQuery<VariantDetail[]>({
    queryKey: ["/api/admin/warehouse/variant-details", stockItems.length],
    enabled: stockItems.length > 0,
    queryFn: async () => {
      // 🔴 The endpoint answers { details: [...] }, not a bare array.
      const r = await (await apiRequest("POST", "/api/admin/warehouse/variant-details", { itemIds: stockItems.map((i) => i.id) })).json();
      return Array.isArray(r?.details) ? r.details : [];
    },
  });

  const variants: Variant[] = useMemo(() => {
    const byId = new Map(details.map((d) => [d.itemId, d]));
    return stockItems.map((i) => {
      const d = byId.get(i.id);
      return {
        ...i,
        colour: d?.colour ?? null,
        sizeAsian: d?.sizeAsian ?? null,
        sizeEU: d?.sizeEU ?? null,
        barcode: d?.barcode ?? null,
      };
    });
  }, [stockItems, details]);

  const variantsByModel = useMemo(() => {
    const m = new Map<number | "none", Variant[]>();
    variants.forEach((v) => {
      const k = v.modelId ?? "none";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(v);
    });
    m.forEach((list) => list.sort((a, b) => (a.colour ?? "").localeCompare(b.colour ?? "")));
    return m;
  }, [variants]);

  // 🔴 Barcodes are resolved by the SERVER, not from a map built here.
  // A local map only works if every barcode is already loaded, and the items
  // list is capped — the first real barcode I tested (34643646363) belonged to
  // an item outside the loaded page, so it silently read as unknown and offered
  // to register a garment that was already in the catalogue. The server checks
  // SKUs and every alias, and knows about pack quantities.
  const byId = useMemo(() => new Map(variants.map((v) => [v.id, v])), [variants]);

  // Models plus a synthetic bucket for variants that belong to no model yet, so
  // nothing counted is ever invisible.
  const rows = useMemo(() => {
    const list: { model: Model | null; variants: Variant[] }[] = models.map((m) => ({
      model: m, variants: variantsByModel.get(m.id) ?? [],
    }));
    const orphans = variantsByModel.get("none") ?? [];
    if (orphans.length) list.push({ model: null, variants: orphans });
    return list.sort((a, b) =>
      (a.model?.vendor ?? "zzz").localeCompare(b.model?.vendor ?? "zzz") ||
      (a.model?.vendorModel ?? "").localeCompare(b.model?.vendorModel ?? ""));
  }, [models, variantsByModel]);

  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return rows;
    return rows.filter(({ model, variants: vs }) => {
      const base = [model?.vendor, model?.title, model?.vendorModel, model?.sku, model?.notes].join(" ").toLowerCase();
      if (base.includes(q)) return true;
      return vs.some((v) => [v.colour, v.sizeAsian, v.sizeEU, v.rackCode, v.notes, v.barcode, v.sku, v.name]
        .join(" ").toLowerCase().includes(q));
    });
  }, [rows, q]);

  const totalUnits = useMemo(() => Object.values(counts).reduce((a, b) => a + b, 0), [counts]);

  // ── Focus discipline — his behaviour ────────────────────────────────────
  const anyModalOpen = !!variantModal || !!modelModal || !!exportCsv || !!confirmAsk;
  const focusScan = useCallback(() => { if (!anyModalOpen) scanRef.current?.focus(); }, [anyModalOpen]);
  useEffect(() => {
    if (anyModalOpen) return;
    const t = window.setInterval(() => {
      const a = document.activeElement as HTMLElement | null;
      if (a && ["INPUT", "SELECT", "TEXTAREA"].includes(a.tagName)) return;
      scanRef.current?.focus();
    }, 1200);
    return () => window.clearInterval(t);
  }, [anyModalOpen]);

  // ── Scanning ────────────────────────────────────────────────────────────
  const bump = useCallback((v: Variant, delta = 1) => {
    setCounts((prev) => {
      const next = Math.max(0, (prev[v.id] ?? 0) + delta);
      return { ...prev, [v.id]: next };
    });
  }, []);

  const variantSub = (v: Variant) => [
    v.colour, v.sizeAsian ? `Asian ${v.sizeAsian}` : "", v.sizeEU ? `EU ${v.sizeEU}` : "",
    v.rackCode ? `📍${v.rackCode}` : "",
  ].filter(Boolean).join(" · ");

  const modelNameFor = (v: Variant) => {
    const m = models.find((x) => x.id === v.modelId);
    return m ? [m.vendor, m.title || m.vendorModel].filter(Boolean).join(" ") : v.name;
  };

  const handleScan = async (raw: string) => {
    const code = raw.trim();
    if (!code) return;
    setScanValue("");
    let resolved: any = null;
    try {
      resolved = await (await apiRequest("POST", "/api/admin/warehouse/scan", { code })).json();
    } catch {
      // A dropped connection must not look like an unknown barcode — offering to
      // register a garment that already exists is how you get duplicate SKUs.
      soundError();
      toast({ title: "Couldn't reach the catalogue", description: "Scan again in a moment.", variant: "destructive" });
      return;
    }

    if (resolved?.kind === "item" && resolved.item?.id) {
      const id = Number(resolved.item.id);
      // packQty: a case barcode counts as the whole case (server's own number).
      const step = Number(resolved.packQty) > 0 ? Number(resolved.packQty) : 1;
      const known = byId.get(id);
      const qty = (counts[id] ?? 0) + step;
      setCounts((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] ?? 0) + step) }));
      primeAudio(); soundCounted();
      setFlash({
        kind: "show",
        qty: String(qty),
        name: known ? modelNameFor(known) : (resolved.item.name ?? resolved.item.sku),
        sub: known ? variantSub(known) : (resolved.item.sku ?? ""),
      });
      if (known?.modelId) setExpanded((e) => new Set(e).add(known.modelId!));
      return;
    }

    // Unknown → his "New variant (barcode not found)" sheet, pre-filled.
    primeAudio(); soundUnknown();
    setVariantModal({ mode: "new", barcode: code, lockModelId: null });
  };

  // ── Mutations ───────────────────────────────────────────────────────────
  const postCount = useMutation({
    mutationFn: async () => {
      const lines = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([itemId, counted]) => ({ itemId: Number(itemId), counted }));
      if (!lines.length) return { skipped: true };
      if (!locationId) throw new Error("Pick which location you counted before posting.");
      // 🔴 Keyed on the SESSION, not the moment of clicking: a double-tap or a
      // retry after a dropped connection must not post the count twice.
      const idempotencyKey = `uniform-stocktake:${sessionStart}:${locationId}`;
      return (await apiRequest("POST", "/api/admin/warehouse/stock-take", {
        locationId: Number(locationId), lines, idempotencyKey,
      })).json();
    },
  });

  const saveVariant = useMutation({
    mutationFn: async (payload: any) => {
      if (payload.__edit) {
        const { __edit, itemId, ...rest } = payload;
        return (await apiRequest("PATCH", `/api/admin/warehouse/items/${itemId}`, rest)).json();
      }
      return (await apiRequest("POST", "/api/admin/warehouse/quick-item", payload)).json();
    },
  });

  const saveModel = useMutation({
    mutationFn: async (payload: any) => {
      if (payload.id) {
        const { id, ...rest } = payload;
        return (await apiRequest("PATCH", `/api/admin/warehouse/models/${id}`, rest)).json();
      }
      return (await apiRequest("POST", "/api/admin/warehouse/models", payload)).json();
    },
  });

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/models"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/items"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/variant-details"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/suggestions"] });
  };

  // ── CSV — his 13 columns, his order ─────────────────────────────────────
  const buildCsv = () => {
    const head = ["ID", "Vendor", "Title", "Vendor Model", "Our SKU", "Item Notes",
      "Colour", "Asian size", "EU size", "Location", "Barcode", "Quantity", "Variant Notes"];
    const out: string[][] = [head];
    rows.forEach(({ model, variants: vs }) => {
      if (!vs.length) {
        out.push([String(model?.id ?? ""), model?.vendor ?? "", model?.title ?? "", model?.vendorModel ?? "",
          model?.sku ?? "", model?.notes ?? "", "", "", "", "", "", "", ""]);
        return;
      }
      vs.forEach((v) => out.push([
        String(model?.id ?? ""), model?.vendor ?? "", model?.title ?? "", model?.vendorModel ?? "",
        model?.sku ?? "", model?.notes ?? "", v.colour ?? "", v.sizeAsian ?? "", v.sizeEU ?? "",
        v.rackCode ?? "", v.barcode ?? v.sku, String(counts[v.id] ?? 0), v.notes ?? "",
      ]));
    });
    return out.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  };

  const doExport = () => {
    const csv = buildCsv();
    try {
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stocktake_${new Date().toISOString().slice(0, 10)}.csv`;
      a.style.display = "none";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { /* fall through to the textarea */ }
    setExportCsv(csv);
  };

  // ── New stocktake — POST first, then reset ──────────────────────────────
  const newStocktake = () => {
    const doReset = () => {
      setCounts({});
      setSessionStart(new Date().toISOString());
      setFlash({ kind: "new", qty: "–", name: "New session started", sub: "Catalogue kept, quantities reset" });
      toast({ title: "New stocktake started" });
      focusScan();
    };
    if (totalUnits === 0) { doReset(); return; }
    setConfirmAsk({
      title: "Start a new stocktake?",
      msg: `The ${totalUnits} units you've counted will be POSTED to the stock ledger first, then the count resets. ` +
           `The catalogue (models and variants) is kept. Export the CSV first if you want a copy.`,
      onYes: async () => {
        setConfirmAsk(null);
        try {
          const r: any = await postCount.mutateAsync();
          if (!r?.skipped) {
            toast({ title: "Count posted to the ledger", description: "Stock levels updated." });
            queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/dashboard"] });
          }
          doReset();
        } catch (e: any) {
          soundError();
          toast({ title: "Couldn't post the count — nothing was reset", description: e.message, variant: "destructive" });
        }
      },
    });
  };

  const loading = loadingModels || loadingItems;

  return (
    <div className="ust">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="app">
        <header>
          <h1>Uniform Stocktake <span className="badge">CUFC / SIUFC</span></h1>
          <div className="session-meta">Session started: {sessionLabel(sessionStart)}</div>
        </header>

        {/* ── Scan panel ── */}
        <div className="scan-panel">
          <div className="scan-label">Scan a variant barcode</div>
          <input
            ref={scanRef}
            className="scan-input"
            autoComplete="off"
            placeholder="Cursor is here — just scan..."
            value={scanValue}
            onChange={(e) => setScanValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleScan(scanValue); } }}
          />
          <div className={`flash ${flash ? "show" : ""} ${flash?.kind === "new" ? "new" : ""}`}>
            <div className="qty-pop">{flash?.qty ?? "–"}</div>
            <div>
              <div className="flash-name">{flash?.name ?? "Waiting for a scan"}</div>
              <div className="flash-sub">{flash?.sub ?? ""}</div>
            </div>
          </div>
        </div>

        {/* ── Stats ── */}
        <div className="stats">
          <div className="stat"><div className="n">{models.length}</div><div className="l">Models</div></div>
          <div className="stat"><div className="n">{variants.length}</div><div className="l">Variants (SKU)</div></div>
          <div className="stat"><div className="n">{totalUnits}</div><div className="l">Units counted</div></div>
        </div>

        {/* ── Toolbar ── */}
        <div className="toolbar">
          <input
            className="search"
            placeholder="Search by vendor, model, SKU, colour, size, barcode..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="search"
            style={{ flex: "0 0 auto", minWidth: 150, maxWidth: 220 }}
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            title="Where the counted quantities get posted"
          >
            {countable.length === 0 && <option value="">No countable locations</option>}
            {countable.map((l) => <option key={l.id} value={String(l.id)}>{l.code}{l.name ? ` — ${l.name}` : ""}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => { const m = !muted; setMuted(m); setMutedState(m); if (!m) { primeAudio(); soundCounted(); } focusScan(); }}>
            {muted ? "🔇 Sound: Off" : "🔊 Sound: On"}
          </button>
          <button className="btn-ghost" onClick={() => setVariantModal({ mode: "new", barcode: "", lockModelId: null })}>+ New model</button>
          <button className="btn-ghost" onClick={doExport}>Export CSV</button>
          <button className="btn-warn" onClick={newStocktake} disabled={postCount.isPending}>
            {postCount.isPending ? "Posting..." : "New stocktake"}
          </button>
        </div>

        {/* ── Table ── */}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th /><th /><th>Vendor</th><th>Title</th><th>Vendor Model</th><th>Our SKU</th>
                <th>Variants</th><th>Total Qty</th><th />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr className="empty-row"><td colSpan={9}>Loading the catalogue…</td></tr>
              ) : filtered.length === 0 ? (
                <tr className="empty-row"><td colSpan={9}>
                  {q ? "Nothing matches that search" : "Catalogue is empty — scan the first variant or add a model manually"}
                </td></tr>
              ) : filtered.map(({ model, variants: vs }) => {
                const key = model?.id ?? -1;
                const isOpen = !!q || expanded.has(key);
                const qtyTotal = vs.reduce((a, v) => a + (counts[v.id] ?? 0), 0);
                return (
                  <>
                    <tr
                      key={`m${key}`}
                      className={`product-row ${isOpen ? "expanded" : ""}`}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest("button")) return;
                        setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
                      }}
                    >
                      <td><span className="chevron">▶</span></td>
                      <td>{model?.imageUrl
                        ? <img className="thumb" src={model.imageUrl} alt="" />
                        : <div className="thumb-placeholder">📷</div>}</td>
                      <td className="vendor">{model?.vendor || "—"}</td>
                      <td>
                        {model?.title || (model ? "—" : "Not in a model yet")}
                        {model?.notes ? <span className="notes-flag" title={model.notes}>📝</span> : null}
                      </td>
                      <td className="model">{model?.vendorModel || "—"}</td>
                      <td className="sku">{model?.sku || "—"}</td>
                      <td><span className="variant-count">{vs.length}</span></td>
                      <td><span className="qty-total">{qtyTotal}</span></td>
                      <td>
                        <div className="row-actions">
                          {model && (
                            <>
                              <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setVariantModal({ mode: "new", barcode: "", lockModelId: model.id }); }}>+ var.</button>
                              <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setModelModal(model); }}>✎</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr key={`v${key}`}>
                        <td colSpan={9} className="variants-cell">
                          <div className="variants-box">
                            {vs.length === 0 ? (
                              <div className="no-variants">No variants yet — add one via "+ var."</div>
                            ) : (
                              <table>
                                <thead><tr><th>Barcode</th><th>Colour</th><th>Asian</th><th>EU</th><th>Location</th><th>Qty</th><th /></tr></thead>
                                <tbody>
                                  {vs.map((v) => (
                                    <tr key={v.id}>
                                      <td className="barcode-cell">{v.barcode ?? v.sku}</td>
                                      <td>{v.colour || "—"}{v.notes ? <span className="notes-flag" title={v.notes}>📝</span> : null}</td>
                                      <td>{v.sizeAsian || "—"}</td>
                                      <td>{v.sizeEU || "—"}</td>
                                      <td><span className="loc-tag">{v.rackCode || "—"}</span></td>
                                      <td>
                                        <div className="qty-cell">
                                          <button className="mini btn-ghost" onClick={(e) => { e.stopPropagation(); bump(v, -1); }}>−</button>
                                          <span className="q">{counts[v.id] ?? 0}</span>
                                          <button className="mini btn-ghost" onClick={(e) => { e.stopPropagation(); bump(v, 1); }}>+</button>
                                        </div>
                                      </td>
                                      <td>
                                        <div className="row-actions">
                                          <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setVariantModal({ mode: "edit", variant: v }); }}>✎</button>
                                        </div>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Variant modal (new / edit), with inline new model ── */}
      {variantModal && (
        <VariantModal
          state={variantModal}
          models={models}
          suggestions={suggestions}
          variants={variants}
          onClose={() => { setVariantModal(null); focusScan(); }}
          onSaved={(v, isNew) => {
            refreshAll();
            if (isNew && v?.itemId) {
              setCounts((prev) => ({ ...prev, [v.itemId]: (prev[v.itemId] ?? 0) + 1 }));
              setFlash({ kind: "new", qty: "1", name: v.name ?? "New variant", sub: v.sub ?? "" });
            }
            primeAudio(); soundSaved();
            setVariantModal(null);
            focusScan();
          }}
          saveVariant={saveVariant}
          saveModel={saveModel}
        />
      )}

      {/* ── Model edit modal ── */}
      {modelModal && (
        <ModelModal
          model={modelModal}
          suggestions={suggestions}
          onClose={() => { setModelModal(null); focusScan(); }}
          onSaved={() => { refreshAll(); primeAudio(); soundSaved(); setModelModal(null); focusScan(); }}
          saveModel={saveModel}
        />
      )}

      {/* ── Export modal ── */}
      {exportCsv !== null && (
        <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) { setExportCsv(null); focusScan(); } }}>
          <div className="modal wide">
            <h2>Export CSV</h2>
            <div className="msub">If the file didn't download automatically, copy the text below and paste it into Excel/Google Sheets</div>
            <textarea className="export-ta" readOnly value={exportCsv} />
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => { setExportCsv(null); focusScan(); }}>Close</button>
              <button className="btn-primary" onClick={async () => {
                try { await navigator.clipboard.writeText(exportCsv); toast({ title: "Copied to clipboard" }); }
                catch { toast({ title: "Select the text and copy it manually" }); }
              }}>Copy</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm ── */}
      {confirmAsk && (
        <div className="overlay">
          <div className="modal">
            <h2>{confirmAsk.title}</h2>
            <div style={{ fontSize: 14, color: "var(--ink)", marginBottom: 4 }}>{confirmAsk.msg}</div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => { setConfirmAsk(null); focusScan(); }}>Cancel</button>
              <button className="btn-warn" style={{ flex: 1 }} onClick={confirmAsk.onYes}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function VariantModal({
  state, models, suggestions, variants, onClose, onSaved, saveVariant, saveModel,
}: {
  state: { mode: "new"; barcode: string; lockModelId: number | null } | { mode: "edit"; variant: Variant };
  models: Model[]; suggestions?: Suggestions; variants: Variant[];
  onClose: () => void;
  onSaved: (v: { itemId: number; name?: string; sub?: string } | null, isNew: boolean) => void;
  saveVariant: any; saveModel: any;
}) {
  const { toast } = useToast();
  const isEdit = state.mode === "edit";
  const editing = isEdit ? state.variant : null;

  // "" = pick one · "__new__" = create a model inline · otherwise a model id
  const [modelSel, setModelSel] = useState<string>(
    isEdit ? String(editing!.modelId ?? "")
      : state.lockModelId ? String(state.lockModelId)
      : models.length ? "" : "__new__",
  );
  const locked = isEdit || (state.mode === "new" && !!state.lockModelId);

  const [nm, setNm] = useState({ vendor: "", vendorModel: "", title: "", sku: "", notes: "", imageUrl: "" as string | null });
  const [v, setV] = useState({
    barcode: isEdit ? (editing!.barcode ?? "") : state.barcode,
    colour: editing?.colour ?? "",
    sizeAsian: editing?.sizeAsian ?? "",
    sizeEU: editing?.sizeEU ?? "",
    // His touch: a new variant inherits the last location used on that model —
    // you count a shelf at a time, not a product at a time.
    rackCode: editing?.rackCode ?? (() => {
      const mid = state.mode === "new" ? state.lockModelId : null;
      if (!mid) return "";
      const sib = variants.filter((x) => x.modelId === mid && x.rackCode);
      return sib.length ? (sib[sib.length - 1].rackCode ?? "") : "";
    })(),
    notes: editing?.notes ?? "",
  });

  const modelLabel = (m: Model) =>
    `${m.vendor || "—"} — ${m.title || m.vendorModel || "—"} (${m.vendorModel || "—"}${m.sku ? `, ${m.sku}` : ""})`;
  const current = models.find((m) => String(m.id) === modelSel);

  const submit = async () => {
    try {
      let modelId: number | null = null;
      if (modelSel === "__new__") {
        if (!nm.vendor.trim() && !nm.vendorModel.trim() && !nm.title.trim()) {
          toast({ title: "Enter a vendor, model or title for the new model", variant: "destructive" }); return;
        }
        const created = await saveModel.mutateAsync({
          title: nm.title.trim() || [nm.vendor, nm.vendorModel].filter(Boolean).join(" ").trim() || "Untitled model",
          vendor: nm.vendor.trim() || null,
          vendorModel: nm.vendorModel.trim() || null,
          sku: nm.sku.trim() || null,
          notes: nm.notes.trim() || null,
          imageUrl: nm.imageUrl || null,
        });
        modelId = created?.id ?? null;
      } else if (modelSel) {
        modelId = Number(modelSel);
      } else if (!isEdit) {
        toast({ title: "Select a model or create a new one", variant: "destructive" }); return;
      }

      if (isEdit) {
        await saveVariant.mutateAsync({
          __edit: true, itemId: editing!.id,
          rackCode: v.rackCode.trim() || null,
          notes: v.notes.trim() || null,
          ...(modelId ? { modelId } : {}),
        });
        onSaved(null, false);
        return;
      }

      const res = await saveVariant.mutateAsync({
        modelId,
        barcode: v.barcode.trim() || null,
        colour: v.colour.trim() || null,
        sizeAsian: v.sizeAsian.trim() || null,
        sizeEU: v.sizeEU.trim() || null,
        rackCode: v.rackCode.trim() || null,
        notes: v.notes.trim() || null,
        vendor: (current?.vendor ?? nm.vendor) || null,
        vendorModel: (current?.vendorModel ?? nm.vendorModel) || null,
        title: current?.title ?? (nm.title || null),
      });
      const itemId = res?.item?.id ?? res?.id;
      const sub = [v.colour, v.sizeAsian ? `Asian ${v.sizeAsian}` : "", v.sizeEU ? `EU ${v.sizeEU}` : "",
        v.rackCode ? `📍${v.rackCode}` : ""].filter(Boolean).join(" · ");
      onSaved(itemId ? { itemId, name: res?.item?.name ?? res?.name, sub } : null, true);
    } catch (e: any) {
      soundError();
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    }
  };

  const pickPhoto = async (f: File | undefined) => {
    if (!f) return;
    try {
      const dataUrl = await resizeImage(f);
      setNm((p) => ({ ...p, imageUrl: dataUrl }));
    } catch { toast({ title: "Couldn't read that photo", variant: "destructive" }); }
  };

  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>{isEdit ? "Edit variant" : state.barcode ? "New variant (barcode not found)" : "New variant"}</h2>
        <div className="msub">
          {isEdit || locked ? [current?.vendor, current?.title || current?.vendorModel].filter(Boolean).join(" — ")
            : state.barcode ? `Barcode: ${state.barcode}` : ""}
        </div>

        <div className="field">
          <label>Product model</label>
          <select value={modelSel} onChange={(e) => setModelSel(e.target.value)} disabled={locked}>
            <option value="">— select a model —</option>
            <option value="__new__">➕ New model</option>
            {models.map((m) => <option key={m.id} value={String(m.id)}>{modelLabel(m)}</option>)}
          </select>
        </div>

        {modelSel === "__new__" && (
          <>
            <div className="section-label">New model</div>
            <div className="field">
              <label>Photo</label>
              <div className="photo-field">
                {nm.imageUrl ? <img className="photo-preview" src={nm.imageUrl} alt="" /> : <div className="photo-ph">📷</div>}
                <div className="photo-actions">
                  <input type="file" accept="image/*" onChange={(e) => pickPhoto(e.target.files?.[0])} />
                  <button type="button" className="btn-ghost" onClick={() => setNm((p) => ({ ...p, imageUrl: null }))}>Remove photo</button>
                </div>
              </div>
            </div>
            <div className="field-row">
              <div className="field"><label>Vendor</label>
                <input list="ustVendor" value={nm.vendor} onChange={(e) => setNm({ ...nm, vendor: e.target.value })} placeholder="KELME / New Balance / Healy" /></div>
              <div className="field"><label>Vendor Model</label>
                <input value={nm.vendorModel} onChange={(e) => setNm({ ...nm, vendorModel: e.target.value })} placeholder="e.g. K123-45" /></div>
            </div>
            <div className="field"><label>Title</label>
              <input value={nm.title} onChange={(e) => setNm({ ...nm, title: e.target.value })} placeholder="e.g. Football Shorts Adults" /></div>
            <div className="field"><label>Our SKU</label>
              <input value={nm.sku} onChange={(e) => setNm({ ...nm, sku: e.target.value })} placeholder="internal model code" /></div>
            <div className="field"><label>Notes</label>
              <textarea value={nm.notes} onChange={(e) => setNm({ ...nm, notes: e.target.value })} placeholder="anything worth flagging about this model" /></div>
          </>
        )}

        <div className="section-label">Variant</div>
        <div className="field"><label>Barcode</label>
          <input value={v.barcode} onChange={(e) => setV({ ...v, barcode: e.target.value })} placeholder="scan or enter manually" disabled={isEdit} />
          {isEdit && <div style={{ fontSize: 11, color: "#8a93a3", marginTop: 4 }}>Barcodes are managed on the item — scanning a new one registers it.</div>}
        </div>
        <div className="field"><label>Colour</label>
          <input list="ustColour" value={v.colour} onChange={(e) => setV({ ...v, colour: e.target.value })} placeholder="e.g. Blue" disabled={isEdit} /></div>
        <div className="field-row">
          <div className="field"><label>Asian size</label>
            <input list="ustAsian" value={v.sizeAsian} onChange={(e) => setV({ ...v, sizeAsian: e.target.value })} placeholder="e.g. L / 14" disabled={isEdit} /></div>
          <div className="field"><label>EU size</label>
            <input list="ustEU" value={v.sizeEU} onChange={(e) => setV({ ...v, sizeEU: e.target.value })} placeholder="e.g. XL / 42" disabled={isEdit} /></div>
        </div>
        <div className="field"><label>Warehouse location</label>
          <input list="ustRack" value={v.rackCode} onChange={(e) => setV({ ...v, rackCode: e.target.value })} placeholder="e.g. L1, C3, R2, T1" /></div>
        <div className="field"><label>Notes</label>
          <textarea value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} placeholder="anything worth flagging about this variant" /></div>

        <Datalist id="ustVendor" values={suggestions?.vendor ?? []} />
        <Datalist id="ustColour" values={suggestions?.colour ?? []} />
        <Datalist id="ustAsian" values={suggestions?.sizeAsian ?? []} />
        <Datalist id="ustEU" values={suggestions?.sizeEU ?? []} />
        <Datalist id="ustRack" values={suggestions?.rackCode ?? []} />

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saveVariant.isPending || saveModel.isPending}>
            {saveVariant.isPending || saveModel.isPending ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function ModelModal({ model, suggestions, onClose, onSaved, saveModel }: {
  model: Model; suggestions?: Suggestions; onClose: () => void; onSaved: () => void; saveModel: any;
}) {
  const { toast } = useToast();
  const [f, setF] = useState({
    vendor: model.vendor ?? "", vendorModel: model.vendorModel ?? "", title: model.title ?? "",
    sku: model.sku ?? "", notes: model.notes ?? "", imageUrl: model.imageUrl ?? null as string | null,
  });
  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file);
      setF((p) => ({ ...p, imageUrl: dataUrl }));
    } catch { toast({ title: "Couldn't read that photo", variant: "destructive" }); }
  };
  return (
    <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Edit model</h2>
        <div className="field">
          <label>Photo</label>
          <div className="photo-field">
            {f.imageUrl ? <img className="photo-preview" src={f.imageUrl} alt="" /> : <div className="photo-ph">📷</div>}
            <div className="photo-actions">
              <input type="file" accept="image/*" onChange={(e) => pickPhoto(e.target.files?.[0])} />
              <button type="button" className="btn-ghost" onClick={() => setF((p) => ({ ...p, imageUrl: null }))}>Remove photo</button>
            </div>
          </div>
        </div>
        <div className="field-row">
          <div className="field"><label>Vendor</label>
            <input list="ustVendor2" value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></div>
          <div className="field"><label>Vendor Model</label>
            <input value={f.vendorModel} onChange={(e) => setF({ ...f, vendorModel: e.target.value })} /></div>
        </div>
        <div className="field"><label>Title</label>
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Short Sleeve Football Shirt" /></div>
        <div className="field"><label>Our SKU</label>
          <input value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} /></div>
        <div className="field"><label>Notes</label>
          <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="anything worth flagging about this model" /></div>
        <Datalist id="ustVendor2" values={suggestions?.vendor ?? []} />
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={saveModel.isPending} onClick={async () => {
            if (!f.title.trim()) { toast({ title: "A model needs a title", variant: "destructive" }); return; }
            try {
              await saveModel.mutateAsync({
                id: model.id, vendor: f.vendor.trim() || null, vendorModel: f.vendorModel.trim() || null,
                title: f.title.trim(), sku: f.sku.trim() || null, notes: f.notes.trim() || null,
                imageUrl: f.imageUrl,
              });
              onSaved();
            } catch (e: any) { soundError(); toast({ title: "Couldn't save", description: e.message, variant: "destructive" }); }
          }}>{saveModel.isPending ? "Saving..." : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

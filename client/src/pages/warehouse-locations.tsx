// Warehouse locations (T16a, SPEC §4.4) — list/filter/CRUD over
// `wh_locations` (bins, named zones, the 4 seeded virtuals) + a bulk-select
// deep-link into `warehouse-labels.tsx` (T14) for bin-label printing, same
// `?kind=location&ids=1,2,3` contract `warehouse-items.tsx` uses for items.
// `zone` is always server-derived from `code`+`kind` (T4's
// `deriveLocationZone` — never a client-editable field) so the form doesn't
// offer it at all; it's shown read-only wherever a location is displayed.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Search, Plus, X, Printer, Trash2, MapPin } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOCATION_KINDS, LOCATION_KIND_LABELS, LOCATION_NAME_MAX, locationLabel, type LocationKind } from "@shared/warehouse";
import type { WhLocation } from "@shared/schema";

const ALL = "__all__";

// Was a second copy of the label map living here. It is now imported from
// shared/warehouse.ts so adding a location kind can never leave this page
// rendering a blank chip — which is exactly what tsc caught when 'person' and
// 'vehicle' arrived (D20).
const KIND_LABEL: Record<LocationKind, string> = LOCATION_KIND_LABELS;

function toggleId(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function EditModal({
  open, onClose, location,
}: { open: boolean; onClose: () => void; location: WhLocation | null }) {
  const { toast } = useToast();
  const isNew = location === null;
  const [code, setCode] = useState(location?.code ?? "");
  const [name, setName] = useState(location?.name ?? "");
  const [kind, setKind] = useState<LocationKind>((location?.kind as LocationKind) ?? "bin");
  const [active, setActive] = useState(location?.active ?? true);

  const save = useMutation({
    mutationFn: async () => {
      const payload = { code, name, kind, active };
      if (isNew) return (await apiRequest("POST", "/api/admin/warehouse/locations", payload)).json();
      return (await apiRequest("PATCH", `/api/admin/warehouse/locations/${location!.id}`, payload)).json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/locations"] });
      toast({ title: isNew ? "Location created" : "Saved" });
      // The "New location" instance below is always mounted with
      // `location={null}` (no key to force a remount per record, unlike the
      // editing instance which IS keyed by id) — without this reset, its
      // code/kind/active fields would carry the just-created values into
      // the NEXT "New location" click instead of starting blank (same
      // reset-on-success move as warehouse-items.tsx's CreateItemModal).
      if (isNew) {
        setCode("");
        setName("");
        setKind("bin");
        setActive(true);
      }
      onClose();
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/warehouse/locations/${location!.id}`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/locations"] });
      toast({ title: "Location deleted" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-[#02060E] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{isNew ? "New location" : locationLabel(location!)}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={LOCATION_NAME_MAX}
              placeholder="e.g. United Sports Centre Warehouse"
              className="bg-white/[0.02] border-white/10 text-white"
            />
            <div className="text-[10px] text-white/30 mt-1">
              Optional — what staff see when they pick this place. Leave it blank and they see the code.
            </div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Code</label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. A-01-2, RECEIVING, QUARANTINE" className="bg-white/[0.02] border-white/10 text-white font-mono" />
            <div className="text-[10px] text-white/30 mt-1">A virtual code, a named zone, or a shallow ZONE-AISLE-BAY-LEVEL bin code.</div>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Kind</label>
            <Select value={kind} onValueChange={(v) => setKind(v as LocationKind)}>
              <SelectTrigger className="bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LOCATION_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {!isNew && location?.zone && (
            <div className="text-xs text-white/40">Zone (derived): <span className="font-mono text-white/60">{location.zone}</span></div>
          )}
          <label className="flex items-center gap-2 text-sm text-white/70">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </div>
        <div className="flex justify-between items-center mt-5">
          {!isNew ? (
            <button
              onClick={() => { if (confirm(`Delete ${locationLabel(location!)}? This can't be undone.`)) remove.mutate(); }}
              disabled={remove.isPending}
              className="text-xs text-red-400/70 hover:text-red-400 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !code} className="bg-blue-600 hover:bg-blue-700">
              {save.isPending ? "Saving..." : isNew ? "Create" : "Save changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WarehouseLocations() {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<string>(ALL);
  const [activeOnly, setActiveOnly] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<WhLocation | null>(null);
  const [creating, setCreating] = useState(false);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (kind !== ALL) params.set("kind", kind);
  if (activeOnly) params.set("active", "true");

  const { data: locations = [], isLoading } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations", "list", q, kind, activeOnly],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/locations?${params.toString()}`)).json(),
  });

  const printSelected = () => setLocation(`/admin/warehouse/labels?kind=location&ids=${Array.from(selected).join(",")}`);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Locations</h1>
          <p className="text-sm text-white/40 mt-0.5">Everywhere stock can sit — the warehouse, its zones and bins, plus the virtual SUPPLIER/CUSTOMER/SCRAP/PRODUCTION endpoints.</p>
        </div>
        <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New location
        </Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input placeholder="Search name or code..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 bg-white/[0.02] border-white/10 text-white" />
        </div>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {LOCATION_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-white/60 flex-shrink-0">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
        </label>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <span className="text-sm text-white/80">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setSelected(new Set())} className="text-xs text-white/50 hover:text-white/80">Clear</button>
            <button onClick={printSelected} className="px-3 py-1.5 rounded-lg text-xs text-white bg-blue-600 hover:bg-blue-700 flex items-center gap-1.5">
              <Printer className="w-3.5 h-3.5" /> Print labels
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : locations.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <MapPin className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No locations match this filter.
        </div>
      ) : (
        <div className="rounded-2xl border border-white/5 overflow-hidden">
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2 bg-white/[0.03] text-[10px] uppercase tracking-wider text-white/40">
            <span></span>
            <span>Location</span>
            <span>Kind</span>
            <span>Zone</span>
            <span></span>
          </div>
          {locations.map((loc) => (
            <div
              key={loc.id}
              className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-3 px-4 py-2.5 items-center border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
              onClick={() => setEditing(loc)}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox checked={selected.has(loc.id)} onCheckedChange={() => setSelected((prev) => toggleId(prev, loc.id))} />
              </span>
              <div className="min-w-0">
                <div className="text-sm text-white truncate">
                  {locationLabel(loc)}{!loc.active ? <span className="text-white/30"> · inactive</span> : ""}
                </div>
                {loc.name ? <div className="text-[11px] text-white/30 font-mono truncate">{loc.code}</div> : null}
              </div>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.04] text-white/50 whitespace-nowrap">
                {KIND_LABEL[loc.kind as LocationKind] ?? loc.kind}
              </span>
              <span className="text-xs text-white/50 font-mono whitespace-nowrap">{loc.zone ?? "—"}</span>
              <button
                onClick={(e) => { e.stopPropagation(); setLocation(`/admin/warehouse/labels?kind=location&ids=${loc.id}`); }}
                className="text-white/30 hover:text-white/70"
                title="Print label"
              >
                <Printer className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <EditModal open={creating} onClose={() => setCreating(false)} location={null} />
      <EditModal open={editing !== null} onClose={() => setEditing(null)} location={editing} key={editing?.id ?? "none"} />
    </div>
  );
}

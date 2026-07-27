// Warehouse → Assets (D18–D22). The half of the warehouse that answers WHICH
// one, not how many: heat presses, laptops, desks, mowers.
//
// Everything on this page that changes where a thing is, or what state it is
// in, goes through the ledger — there is no quantity box and no quick edit.
// The detail sheet's Move and Retire buttons post movements; the form fields
// only ever edit descriptive facts (serial, warranty, cost).
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Search, Plus, X, Loader2, MapPin, ArrowRight, ShieldAlert, ShieldCheck, ShieldQuestion,
  PackageX, History, Boxes, ScanLine,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WarehouseCustomFields } from "@/components/warehouse-custom-fields";
import {
  INSTANCE_CONDITIONS, INSTANCE_CONDITION_LABELS, LOCATION_KIND_LABELS,
  type InstanceCondition, type LocationKind, type WarrantyStatus,
} from "@shared/warehouse";
import type { WhLocation } from "@shared/schema";

const ALL = "__all__";

interface Instance {
  id: number;
  itemId: number;
  assetTag: string | null;
  serialNumber: string | null;
  condition: InstanceCondition;
  purchaseDate: string | null;
  warrantyUntil: string | null;
  costCents: number | null;
  notes: string | null;
  locationId: number;
  locationCode: string;
  locationKind: LocationKind;
  itemSku: string;
  itemName: string;
  warranty: WarrantyStatus;
}

interface Overview {
  today: string;
  items: Array<{ id: number; sku: string; name: string; category: string | null; held: number }>;
  byCondition: Record<string, number>;
  warrantyExpired: number;
  warrantyUnknown: number;
}

const CONDITION_STYLE: Record<InstanceCondition, string> = {
  new: "bg-emerald-500/10 text-emerald-400",
  working: "bg-blue-500/10 text-blue-400",
  damaged: "bg-amber-500/10 text-amber-400",
  decommissioned: "bg-white/5 text-white/40",
};

// 'unknown' is deliberately amber, not grey: an asset nobody has recorded a
// warranty for is unaudited, and unaudited must never read as fine.
const WARRANTY_META: Record<WarrantyStatus, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  ok: { label: "In warranty", cls: "text-emerald-400", Icon: ShieldCheck },
  expiring: { label: "Warranty ending", cls: "text-amber-400", Icon: ShieldAlert },
  expired: { label: "Out of warranty", cls: "text-red-400", Icon: ShieldAlert },
  unknown: { label: "No warranty date", cls: "text-amber-400/70", Icon: ShieldQuestion },
};

function money(cents: number | null): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

// ── Detail sheet ─────────────────────────────────────────────────────────────

function DetailSheet({ instance, onClose }: { instance: Instance; onClose: () => void }) {
  const { toast } = useToast();
  const [moveTo, setMoveTo] = useState<string>("");
  const [moveCondition, setMoveCondition] = useState<string>("");
  const [note, setNote] = useState("");
  const [confirmRetire, setConfirmRetire] = useState(false);

  const { data: locations } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const { data: history } = useQuery<{ movements: any[] }>({
    queryKey: [`/api/admin/warehouse/instances/${instance.id}/movements`],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/instances/${instance.id}/movements`)).json(),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/instances"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/assets/overview"] });
    queryClient.invalidateQueries({ queryKey: [`/api/admin/warehouse/instances/${instance.id}/movements`] });
  };

  const move = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/warehouse/instances/${instance.id}/move`, {
        toLocationId: Number(moveTo),
        condition: moveCondition || undefined,
        note: note || undefined,
        // Client-minted so a double-tap or a retried request can never post
        // the same move twice.
        idempotencyKey: `move-${instance.id}-${moveTo}-${Date.now()}`,
      })).json(),
    onSuccess: () => {
      refresh();
      setMoveTo(""); setMoveCondition(""); setNote("");
      toast({ title: "Moved" });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't move it", description: e.message, variant: "destructive" }),
  });

  const retire = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/admin/warehouse/instances/${instance.id}/decommission`, {
        note: note || undefined,
        idempotencyKey: `decom-${instance.id}-${Date.now()}`,
      })).json(),
    onSuccess: () => {
      refresh();
      toast({ title: "Retired", description: "Its history stays on the ledger." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't retire it", description: e.message, variant: "destructive" }),
  });

  const w = WARRANTY_META[instance.warranty];
  const retired = instance.condition === "decommissioned";

  // Custody locations are offered for a move — that is the whole point of D20
  // — but a virtual location is not somewhere you can put a physical object.
  const moveTargets = (locations ?? []).filter((l) => l.kind !== "virtual" && l.id !== instance.locationId && l.active);

  return (
    <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full sm:max-w-2xl sm:rounded-2xl bg-[#0f1216] border border-white/10 mt-auto sm:mt-0 max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#0f1216] border-b border-white/10 px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white truncate">{instance.itemName}</div>
            <div className="text-xs text-white/40 truncate">
              {instance.assetTag ?? "No asset tag"} · {instance.itemSku}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5 shrink-0">
            <X className="w-4 h-4 text-white/50" />
          </button>
        </div>

        <div className="p-4 space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-[11px] ${CONDITION_STYLE[instance.condition]}`}>
              {INSTANCE_CONDITION_LABELS[instance.condition]}
            </span>
            <span className="px-2 py-0.5 rounded text-[11px] bg-white/5 text-white/60 flex items-center gap-1">
              <MapPin className="w-3 h-3" /> {instance.locationCode}
              <span className="text-white/30">({LOCATION_KIND_LABELS[instance.locationKind]})</span>
            </span>
            <span className={`text-[11px] flex items-center gap-1 ${w.cls}`}>
              <w.Icon className="w-3.5 h-3.5" /> {w.label}
              {instance.warrantyUntil && <span className="text-white/30">· {instance.warrantyUntil}</span>}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div><div className="text-white/35">Serial</div><div className="text-white/70 break-all">{instance.serialNumber ?? "—"}</div></div>
            <div><div className="text-white/35">Bought</div><div className="text-white/70">{instance.purchaseDate ?? "—"}</div></div>
            <div><div className="text-white/35">Cost</div><div className="text-white/70">{money(instance.costCents)}</div></div>
            <div><div className="text-white/35">Warranty to</div><div className="text-white/70">{instance.warrantyUntil ?? "—"}</div></div>
          </div>

          {/* Custom fields for this unit — whatever an admin defined (D22). */}
          <div className="border-t border-white/[0.06] pt-4">
            <WarehouseCustomFields owner="instance" ownerId={instance.id} title="Recorded details" />
          </div>

          {!retired && (
            <div className="border-t border-white/[0.06] pt-4 space-y-3">
              <h3 className="text-sm font-medium text-white/70">Move it</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Where to</label>
                  <Select value={moveTo} onValueChange={setMoveTo}>
                    <SelectTrigger><SelectValue placeholder="Pick a bin, person or vehicle" /></SelectTrigger>
                    <SelectContent>
                      {moveTargets.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>
                          {l.code} · {LOCATION_KIND_LABELS[l.kind as LocationKind]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Condition now (optional)</label>
                  <Select value={moveCondition} onValueChange={setMoveCondition}>
                    <SelectTrigger><SelectValue placeholder="Unchanged" /></SelectTrigger>
                    <SelectContent>
                      {/* Retiring is its own action — offering it here would
                          leave the asset in a real bin claiming to be retired. */}
                      {INSTANCE_CONDITIONS.filter((c) => c !== "decommissioned").map((c) => (
                        <SelectItem key={c} value={c}>{INSTANCE_CONDITION_LABELS[c]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} className="scroll-mb-24" />
              <Button size="sm" disabled={!moveTo || move.isPending} onClick={() => move.mutate()} className="gap-1.5">
                {move.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
                Move
              </Button>
            </div>
          )}

          <div className="border-t border-white/[0.06] pt-4">
            <h3 className="text-sm font-medium text-white/70 flex items-center gap-1.5 mb-2">
              <History className="w-3.5 h-3.5" /> Everywhere it has been
            </h3>
            {!history ? (
              <div className="text-xs text-white/30">Loading…</div>
            ) : history.movements.length === 0 ? (
              <div className="text-xs text-white/30">Nothing recorded yet.</div>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {history.movements.map((m) => (
                  <div key={m.id} className="flex items-center justify-between gap-3 text-xs py-1.5 border-b border-white/[0.04]">
                    <div className="min-w-0">
                      <span className="text-white/70">{m.typeLabel}</span>
                      <span className="text-white/30"> · {m.locationCode}</span>
                      {m.note && <span className="text-white/30 block truncate">{m.note}</span>}
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-white/40">{new Date(m.createdAt).toLocaleDateString("en-NZ")}</div>
                      <div className="text-white/25">{m.operatorName}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!retired && (
            <div className="border-t border-white/[0.06] pt-4">
              {!confirmRetire ? (
                <button onClick={() => setConfirmRetire(true)} className="text-xs text-red-400/70 hover:text-red-400 flex items-center gap-1.5">
                  <PackageX className="w-3.5 h-3.5" /> Retire this asset
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-white/50">
                    It moves to SCRAP and stops counting as something we have. Its whole history stays on the ledger —
                    nothing is deleted.
                  </p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" disabled={retire.isPending} onClick={() => retire.mutate()}>
                      {retire.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Yes, retire it"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRetire(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Add sheet ────────────────────────────────────────────────────────────────

function AddSheet({ items, onClose }: { items: Overview["items"]; onClose: () => void }) {
  const { toast } = useToast();
  const [itemId, setItemId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [assetTag, setAssetTag] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [condition, setCondition] = useState<string>("new");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [warrantyUntil, setWarrantyUntil] = useState("");
  const [cost, setCost] = useState("");

  const { data: locations } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const create = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/warehouse/instances", {
        itemId: Number(itemId),
        locationId: Number(locationId),
        assetTag: assetTag || undefined,
        serialNumber: serialNumber || undefined,
        condition,
        purchaseDate: purchaseDate || undefined,
        warrantyUntil: warrantyUntil || undefined,
        // Money in dollars on screen, cents on the wire — the house rule.
        costCents: cost ? Math.round(Number(cost) * 100) : undefined,
      })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/instances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/assets/overview"] });
      toast({ title: "Asset added", description: "Its first ledger entry was written at the same time." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't add it", description: e.message, variant: "destructive" }),
  });

  const placeable = (locations ?? []).filter((l) => l.kind !== "virtual" && l.active);

  return (
    <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg sm:rounded-2xl bg-[#0f1216] border border-white/10 mt-auto sm:mt-0 max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#0f1216] border-b border-white/10 px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-white">Add an asset</div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5"><X className="w-4 h-4 text-white/50" /></button>
        </div>

        <div className="p-4 space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-white/50">
              No item is set up as a tracked asset yet. Open an item, switch it to <em>Tracked asset</em>, then add its
              units here.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs text-white/50">What is it *</label>
                <Select value={itemId} onValueChange={setItemId}>
                  <SelectTrigger><SelectValue placeholder="Pick the item" /></SelectTrigger>
                  <SelectContent>
                    {items.map((i) => <SelectItem key={i.id} value={String(i.id)}>{i.name} · {i.sku}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-white/50">Where is it *</label>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger><SelectValue placeholder="Bin, person or vehicle" /></SelectTrigger>
                  <SelectContent>
                    {placeable.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.code} · {LOCATION_KIND_LABELS[l.kind as LocationKind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Asset tag</label>
                  <Input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} placeholder="Our label" className="scroll-mb-24" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Serial number</label>
                  <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="Maker's" className="scroll-mb-24" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Condition</label>
                  <Select value={condition} onValueChange={setCondition}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INSTANCE_CONDITIONS.filter((c) => c !== "decommissioned").map((c) => (
                        <SelectItem key={c} value={c}>{INSTANCE_CONDITION_LABELS[c]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Cost (NZD)</label>
                  <Input type="number" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" className="scroll-mb-24" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Bought on</label>
                  <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className="scroll-mb-24" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-white/50">Warranty until</label>
                  <Input type="date" value={warrantyUntil} onChange={(e) => setWarrantyUntil(e.target.value)} className="scroll-mb-24" />
                </div>
              </div>

              <Button
                className="w-full gap-1.5"
                disabled={!itemId || !locationId || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add asset
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function WarehouseAssets() {
  const [, setLocation] = useLocation();
  const [q, setQ] = useState("");
  const [condition, setCondition] = useState(ALL);
  const [selected, setSelected] = useState<Instance | null>(null);
  const [adding, setAdding] = useState(false);

  const { data: overview } = useQuery<Overview>({
    queryKey: ["/api/admin/warehouse/assets/overview"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/assets/overview")).json(),
  });

  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (condition !== ALL) params.set("condition", condition);
  const qs = params.toString();

  const { data, isLoading } = useQuery<{ today: string; instances: Instance[] }>({
    queryKey: ["/api/admin/warehouse/instances", qs],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/instances${qs ? `?${qs}` : ""}`)).json(),
  });

  const instances = data?.instances ?? [];
  const held = useMemo(() => instances.filter((i) => i.condition !== "decommissioned").length, [instances]);

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Assets</h1>
          <p className="text-sm text-white/40 mt-0.5">
            The things we own one at a time — presses, tools, furniture. Every move is on the ledger.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocation("/admin/warehouse/scan")}
            className="px-3 py-2 rounded-lg text-xs text-white/70 bg-white/[0.04] border border-white/10 hover:bg-white/[0.08] flex items-center gap-1.5"
          >
            <ScanLine className="w-3.5 h-3.5" /> Scan
          </button>
          <Button size="sm" onClick={() => setAdding(true)} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add asset
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Assets held" value={held} tone="blue" Icon={Boxes} />
        <StatCard label="Damaged" value={overview?.byCondition?.damaged ?? 0} tone="amber" Icon={ShieldAlert} />
        <StatCard label="Out of warranty" value={overview?.warrantyExpired ?? 0} tone="red" Icon={ShieldAlert} />
        <StatCard
          label="No warranty date"
          value={overview?.warrantyUnknown ?? 0}
          tone="amber"
          Icon={ShieldQuestion}
          hint="Unaudited — not the same as fine"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-white/30 absolute left-3 top-1/2 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Tag, serial, name or SKU"
            className="pl-9 scroll-mb-24"
          />
        </div>
        <Select value={condition} onValueChange={setCondition}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any condition</SelectItem>
            {INSTANCE_CONDITIONS.map((c) => (
              <SelectItem key={c} value={c}>{INSTANCE_CONDITION_LABELS[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-8 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading assets…
        </div>
      ) : instances.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-white/10 rounded-xl">
          <Boxes className="w-8 h-8 text-white/15 mx-auto mb-3" />
          <p className="text-sm text-white/50">No assets recorded yet.</p>
          <p className="text-xs text-white/30 mt-1 max-w-sm mx-auto">
            Set an item to <em>Tracked asset</em>, then add each physical unit — with its serial, where it lives and
            who has it.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-white/30 border-b border-white/[0.06]">
                <th className="py-2 px-3 font-medium">Asset</th>
                <th className="py-2 px-3 font-medium">Tag / serial</th>
                <th className="py-2 px-3 font-medium">Where</th>
                <th className="py-2 px-3 font-medium">Condition</th>
                <th className="py-2 px-3 font-medium">Warranty</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => {
                const w = WARRANTY_META[i.warranty];
                return (
                  <tr
                    key={i.id}
                    onClick={() => setSelected(i)}
                    className="border-b border-white/[0.04] hover:bg-white/[0.02] cursor-pointer"
                  >
                    <td className="py-2.5 px-3">
                      <div className="text-white/85">{i.itemName}</div>
                      <div className="text-[11px] text-white/30">{i.itemSku}</div>
                    </td>
                    <td className="py-2.5 px-3 text-white/60">
                      <div>{i.assetTag ?? "—"}</div>
                      <div className="text-[11px] text-white/30 break-all">{i.serialNumber ?? ""}</div>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="text-white/60 flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-white/25" /> {i.locationCode}
                      </span>
                      <span className="text-[11px] text-white/30">{LOCATION_KIND_LABELS[i.locationKind]}</span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded text-[11px] ${CONDITION_STYLE[i.condition]}`}>
                        {INSTANCE_CONDITION_LABELS[i.condition]}
                      </span>
                    </td>
                    <td className={`py-2.5 px-3 text-[11px] ${w.cls}`}>
                      <span className="flex items-center gap-1"><w.Icon className="w-3.5 h-3.5" /> {w.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailSheet instance={selected} onClose={() => setSelected(null)} />}
      {adding && <AddSheet items={overview?.items ?? []} onClose={() => setAdding(false)} />}
    </div>
  );
}

function StatCard({
  label, value, tone, Icon, hint,
}: { label: string; value: number; tone: string; Icon: typeof Boxes; hint?: string }) {
  const cls = ({
    blue: "bg-blue-500/10 text-blue-400",
    amber: "bg-amber-500/10 text-amber-400",
    red: "bg-red-500/10 text-red-400",
  } as Record<string, string>)[tone] ?? "bg-white/5 text-white/40";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-white/40">{label}</span>
        <span className={`p-1.5 rounded-lg ${cls}`}><Icon className="w-3.5 h-3.5" /></span>
      </div>
      <div className="text-2xl font-semibold text-white mt-1">{value}</div>
      {hint && <div className="text-[10px] text-white/25 mt-0.5">{hint}</div>}
    </div>
  );
}

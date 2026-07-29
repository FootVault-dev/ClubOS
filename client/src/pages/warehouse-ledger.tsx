// Warehouse ledger (T16c, SPEC §4.4/D1) — the full cross-item movement audit
// trail. GET /api/admin/warehouse/items/:id/movements (T16a) was always
// scoped to one item, with its own comment naming this exact page as the
// place for "any item/location/date" filtering — GET /movements (added this
// task, server/warehouse-routes.ts) is that endpoint. Read-only: the ledger
// is append-only (AGENTS.md) and nothing on this page ever posts a movement.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Search } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MOVEMENT_TYPES, MOVEMENT_TYPE_LABELS, REASON_CODES, REASON_CODE_LABELS, REF_KINDS, locationLabelWithCode } from "@shared/warehouse";
import type { WhLocation } from "@shared/schema";

const ALL = "__all__";

interface MovementRow {
  id: number;
  groupId: string;
  itemId: number;
  locationId: number;
  delta: string;
  movementType: string;
  reasonCode: string | null;
  refKind: string | null;
  refId: number | null;
  note: string | null;
  createdAt: string;
  itemSku: string;
  itemName: string;
  locationCode: string;
  operatorName: string;
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
function fmtDateTime(d: string): string {
  return new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function WarehouseLedger() {
  const [q, setQ] = useState("");
  const [locationId, setLocationId] = useState<string>(ALL);
  const [movementType, setMovementType] = useState<string>(ALL);
  const [reasonCode, setReasonCode] = useState<string>(ALL);
  const [refKind, setRefKind] = useState<string>(ALL);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { data: locations = [] } = useQuery<WhLocation[]>({
    queryKey: ["/api/admin/warehouse/locations", "all"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/locations")).json(),
  });

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (locationId !== ALL) params.set("locationId", locationId);
  if (movementType !== ALL) params.set("movementType", movementType);
  if (reasonCode !== ALL) params.set("reasonCode", reasonCode);
  if (refKind !== ALL) params.set("refKind", refKind);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  params.set("limit", "300");

  const { data: movements = [], isLoading } = useQuery<MovementRow[]>({
    queryKey: ["/api/admin/warehouse/movements", q, locationId, movementType, reasonCode, refKind, dateFrom, dateTo],
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/movements?${params.toString()}`)).json(),
  });

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-white">Ledger</h1>
        <p className="text-sm text-white/40 mt-0.5">Every stock movement, across every item and bin — append-only, newest first.</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input placeholder="SKU, item name, or bin code..." value={q} onChange={(e) => setQ(e.target.value)} className="pl-10 bg-white/[0.02] border-white/10 text-white" />
        </div>
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/10 text-white"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All locations</SelectItem>
            {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{locationLabelWithCode(l)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={movementType} onValueChange={setMovementType}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/10 text-white"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {MOVEMENT_TYPES.map((t) => <SelectItem key={t} value={t}>{MOVEMENT_TYPE_LABELS[t]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={reasonCode} onValueChange={setReasonCode}>
          <SelectTrigger className="w-40 bg-white/[0.02] border-white/10 text-white"><SelectValue placeholder="Reason" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All reasons</SelectItem>
            {REASON_CODES.map((r) => <SelectItem key={r} value={r}>{REASON_CODE_LABELS[r]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={refKind} onValueChange={setRefKind}>
          <SelectTrigger className="w-36 bg-white/[0.02] border-white/10 text-white"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All sources</SelectItem>
            {REF_KINDS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm"
          style={{ colorScheme: "dark" }}
        />
        <span className="text-white/30 text-xs">to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9 px-3 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm"
          style={{ colorScheme: "dark" }}
        />
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm py-10 text-center">Loading...</div>
      ) : movements.length === 0 ? (
        <div className="py-16 text-center text-sm text-white/30">
          <Boxes className="w-8 h-8 text-white/15 mx-auto mb-2" />
          No movements match this filter.
        </div>
      ) : (
        <div className="space-y-1.5">
          {movements.map((m) => {
            const delta = Number(m.delta);
            return (
              <div key={m.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/5">
                <span className={`text-sm font-mono w-20 flex-shrink-0 ${delta >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {delta >= 0 ? "+" : ""}{qty(delta)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{m.itemSku} <span className="text-white/40">· {m.itemName}</span></div>
                  <div className="text-[11px] text-white/40 truncate">
                    {m.locationCode} · {m.operatorName}
                    {m.reasonCode && ` · ${REASON_CODE_LABELS[m.reasonCode as keyof typeof REASON_CODE_LABELS] ?? m.reasonCode}`}
                    {m.refKind && ` · ${m.refKind}#${m.refId}`}
                    {m.note && ` · ${m.note}`}
                  </div>
                </div>
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.04] text-white/60 flex-shrink-0">
                  {MOVEMENT_TYPE_LABELS[m.movementType as keyof typeof MOVEMENT_TYPE_LABELS] ?? m.movementType}
                </span>
                <span className="text-[11px] text-white/30 flex-shrink-0 w-32 text-right">{fmtDateTime(m.createdAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

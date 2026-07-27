// Barcode editor for an item — the thing that makes a manufacturer's barcode
// (the EAN printed on a KELME box) resolve to OUR item when someone scans it.
//
// Without this the scan station can only recognise labels we printed
// ourselves, which means relabelling every box that already has a perfectly
// good barcode on it. Link it once and the supplier's own barcode works
// forever after (D5).
//
// Two modes, one component:
//   • itemId given  — live. Reads and writes the API immediately.
//   • itemId null   — draft. Holds the list in memory for a NEW item that
//                     doesn't exist yet; the parent saves them after create.
//
// The input is the point of the whole screen: it is focused on open and it
// clears and refocuses after every add, so a USB scanner can be pointed at a
// row of boxes and pull the trigger repeatedly without touching the keyboard.
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Barcode, Plus, Trash2, Loader2, ScanLine } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { normaliseAliasCode } from "@shared/warehouse";

export interface DraftBarcode {
  code: string;
  /** A case barcode can stand for many eaches — one scan of it posts
   *  packQty units, never one (D5). Defaults to 1. */
  packQty: number;
}

interface AliasRow {
  id: number;
  code: string;
  packQty: string | number;
  note: string | null;
}

/** Shared entry row — scan or type, Enter adds. */
function BarcodeEntry({
  onAdd,
  busy,
  autoFocus = true,
}: {
  onAdd: (code: string, packQty: number) => void;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  const [code, setCode] = useState("");
  const [packQty, setPackQty] = useState("1");
  const ref = useRef<HTMLInputElement>(null);

  const submit = () => {
    const clean = normaliseAliasCode(code);
    if (!clean) return;
    const qty = Number(packQty);
    onAdd(clean, Number.isFinite(qty) && qty > 0 ? qty : 1);
    setCode("");
    setPackQty("1");
    // Straight back to ready, so a scanner can work down a row of boxes
    // without anyone touching the keyboard between them.
    requestAnimationFrame(() => ref.current?.focus());
  };

  return (
    <div className="flex gap-2 items-end">
      <div className="flex-1 space-y-1">
        <label className="text-[11px] text-white/40 flex items-center gap-1">
          <ScanLine className="w-3 h-3" /> Scan the barcode, or type it
        </label>
        <Input
          ref={ref}
          autoFocus={autoFocus}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              // A scanner sends Enter itself — this is the whole hardware path.
              e.preventDefault();
              submit();
            }
          }}
          placeholder="e.g. 9421023610112"
          className="font-mono scroll-mb-24"
        />
      </div>
      <div className="w-20 space-y-1">
        <label className="text-[11px] text-white/40">Units</label>
        <Input
          type="number"
          min="1"
          value={packQty}
          onChange={(e) => setPackQty(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="scroll-mb-24"
        />
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={!code.trim() || busy}
        className="h-10 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm flex items-center gap-1.5 shrink-0"
      >
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        Add
      </button>
    </div>
  );
}

function Hint() {
  return (
    <p className="text-[11px] text-white/30">
      One scan of a case barcode posts that many units — set <span className="text-white/50">Units</span> to
      how many are in the box (leave it at 1 for a single item).
    </p>
  );
}

/** Draft mode — for an item that doesn't exist yet. */
export function BarcodeDraftEditor({
  value,
  onChange,
}: {
  value: DraftBarcode[];
  onChange: (next: DraftBarcode[]) => void;
}) {
  const add = (code: string, packQty: number) => {
    // Adding the same code twice would 409 on save; catch it here where it can
    // still be explained rather than after the item is created.
    if (value.some((b) => b.code === code)) return;
    onChange([...value, { code, packQty }]);
  };

  return (
    <div className="space-y-2">
      <label className="text-xs uppercase tracking-wider text-white/40 flex items-center gap-1.5">
        <Barcode className="w-3.5 h-3.5" /> Barcodes
      </label>
      <BarcodeEntry onAdd={add} autoFocus={false} />
      <Hint />
      {value.length > 0 && (
        <div className="space-y-1 pt-1">
          {value.map((b) => (
            <div key={b.code} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 text-sm">
              <span className="text-white/70 font-mono truncate">{b.code}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-white/40 text-xs">× {b.packQty}</span>
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x.code !== b.code))}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Live mode — for an item that already exists. */
export function BarcodeEditor({ itemId }: { itemId: number }) {
  const { toast } = useToast();
  const key = [`/api/admin/warehouse/items/${itemId}/aliases`];

  const { data, isLoading } = useQuery<AliasRow[]>({
    queryKey: key,
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/items/${itemId}/aliases`)).json(),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: key });
    // The items list embeds each item's aliases, so it goes stale too.
    queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/items"] });
  };

  const add = useMutation({
    mutationFn: async (b: DraftBarcode) =>
      (await apiRequest("POST", `/api/admin/warehouse/items/${itemId}/aliases`, b)).json(),
    onSuccess: () => { invalidate(); toast({ title: "Barcode linked" }); },
    onError: (e: any) =>
      toast({
        title: "Couldn't link that barcode",
        // The most likely failure by far is the code already pointing at a
        // different item — say so rather than showing a raw 409.
        description: /already in use/i.test(e.message || "")
          ? "That barcode is already linked to another item."
          : e.message,
        variant: "destructive",
      }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) => (await apiRequest("DELETE", `/api/admin/warehouse/aliases/${id}`)).json(),
    onSuccess: () => { invalidate(); toast({ title: "Barcode unlinked" }); },
  });

  const rows = data ?? [];

  return (
    <div className="space-y-2">
      <BarcodeEntry onAdd={(code, packQty) => add.mutate({ code, packQty })} busy={add.isPending} autoFocus={false} />
      <Hint />
      {isLoading ? (
        <div className="text-white/30 text-sm py-3 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-white/30 py-4 text-center rounded-lg bg-white/[0.02] border border-white/5">
          No barcode linked yet — scan the one on the box above.
        </div>
      ) : (
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
          {rows.map((a) => (
            <div key={a.id} className="flex items-center justify-between p-2 rounded-lg bg-white/[0.02] border border-white/5 text-sm">
              <span className="text-white/70 font-mono truncate">{a.code}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-white/40 text-xs">× {Number(a.packQty)}</span>
                <button
                  onClick={() => remove.mutate(a.id)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400"
                  title="Unlink this barcode"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

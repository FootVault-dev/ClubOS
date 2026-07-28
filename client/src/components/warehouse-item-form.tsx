// The New-item flow (D26): pick what kind of thing it is, then fill in a form
// the admin arranged.
//
// Step 1 exists because the answer changes the item's shape permanently — an
// asset gets individually-tracked units, stock gets a counted quantity — and
// it cannot be changed once the item has any history (D18). Asking it as a
// dropdown buried in a long form invites the wrong answer; asking it first, in
// plain English with examples, does not.
//
// Step 2 renders whatever order the admin saved (shared/warehouse-form.ts).
// Nothing here hardcodes a field list.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Boxes, Wrench, ArrowLeft, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarcodeDraftEditor, type DraftBarcode } from "@/components/warehouse-barcodes";
import {
  ITEM_KINDS, ITEM_KIND_LABELS, BRAND_OWNERS, BRAND_OWNER_LABELS, UNITS, UNIT_LABELS,
  type TrackingMode, type ItemKind, type BrandOwner, type Unit,
} from "@shared/warehouse";
import { TRACKING_MODE_CHOICES, visibleFields, type LayoutField } from "@shared/warehouse-form";
import type { WhLocation } from "@shared/schema";

const NONE = "__none__";

export interface ItemDraft {
  sku: string; name: string; kind: ItemKind; brandOwner: BrandOwner; category: string;
  unit: Unit; minQty: string; costCents: string; defaultLocationId: string;
  active: boolean; allowNegative: boolean; isLoanable: boolean; notes: string;
}

export const EMPTY_DRAFT: ItemDraft = {
  sku: "", name: "", kind: "merch", brandOwner: "club", category: "", unit: "ea",
  minQty: "", costCents: "", defaultLocationId: "", active: true, allowNegative: false,
  isLoanable: false, notes: "",
};

export function draftToPayload(d: ItemDraft, trackingMode: TrackingMode) {
  return {
    sku: d.sku, name: d.name, kind: d.kind, brandOwner: d.brandOwner,
    category: d.category || null, unit: d.unit,
    minQty: d.minQty === "" ? null : d.minQty,
    // Entered in dollars, stored in cents — the house rule.
    costCents: d.costCents === "" ? null : Math.round(Number(d.costCents) * 100),
    defaultLocationId: d.defaultLocationId === "" ? null : parseInt(d.defaultLocationId, 10),
    active: d.active, allowNegative: d.allowNegative, isLoanable: d.isLoanable,
    notes: d.notes || null,
    trackingMode,
  };
}

// ── Step 1 — what kind of thing is this? ─────────────────────────────────────

export function TrackingModeChooser({ onPick }: { onPick: (m: TrackingMode) => void }) {
  const Icon = { stock: Boxes, asset: Wrench } as const;
  return (
    <div className="space-y-3">
      <p className="text-sm text-white/50">
        What are we adding? This decides how the warehouse tracks it, and it can't be changed later.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TRACKING_MODE_CHOICES.map((c) => {
          const I = Icon[c.mode];
          return (
            <button
              key={c.mode}
              type="button"
              onClick={() => onPick(c.mode)}
              className="text-left p-4 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-blue-500/40 transition-colors"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className="p-1.5 rounded-lg bg-blue-500/10 text-blue-400"><I className="w-4 h-4" /></span>
                <span className="text-white font-semibold">{c.title}</span>
              </div>
              <p className="text-xs text-white/60 leading-relaxed">{c.blurb}</p>
              <p className="text-[11px] text-white/35 mt-2">{c.examples}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 2 — the admin's form ────────────────────────────────────────────────

function FieldLabel({ f }: { f: LayoutField }) {
  return (
    <label className="text-[10px] uppercase tracking-wider text-white/40">
      {f.label}
      {f.required && <span className="text-amber-400/70 ml-1">*</span>}
    </label>
  );
}

export function DynamicItemForm({
  mode, value, onChange, locations, barcodes, onBarcodesChange, customValues, onCustomChange,
}: {
  mode: TrackingMode;
  value: ItemDraft;
  onChange: (v: ItemDraft) => void;
  locations: WhLocation[];
  barcodes: DraftBarcode[];
  onBarcodesChange: (b: DraftBarcode[]) => void;
  customValues: Record<string, string | boolean>;
  onCustomChange: (v: Record<string, string | boolean>) => void;
}) {
  // The layout depends on the category, because custom fields hang off it —
  // so it refetches as soon as one is typed.
  const { data, isLoading } = useQuery<{ layout: LayoutField[] }>({
    queryKey: ["/api/admin/warehouse/form-layout", mode, value.category],
    queryFn: async () =>
      (await apiRequest(
        "GET",
        `/api/admin/warehouse/form-layout?mode=${mode}${value.category ? `&category=${encodeURIComponent(value.category)}` : ""}`,
      )).json(),
  });

  if (isLoading) {
    return <div className="py-6 text-white/40 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading the form…</div>;
  }

  const fields = visibleFields(data?.layout ?? []);
  const set = (patch: Partial<ItemDraft>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-3">
      {fields.map((f) => {
        if (f.control === "barcodes") {
          return (
            <div key={f.id} className="pt-1">
              <BarcodeDraftEditor value={barcodes} onChange={onBarcodesChange} />
            </div>
          );
        }

        if (f.control === "custom") {
          return (
            <div key={f.id} className="space-y-1">
              <FieldLabel f={f} />
              <Input
                value={String(customValues[f.fieldKey] ?? "")}
                onChange={(e) => onCustomChange({ ...customValues, [f.fieldKey]: e.target.value })}
                className="bg-white/[0.02] border-white/10 text-white scroll-mb-24"
              />
              {f.hint && <p className="text-[11px] text-white/30">{f.hint}</p>}
            </div>
          );
        }

        const key = f.coreField!;

        if (f.control === "checkbox") {
          return (
            <label key={f.id} className="flex items-center gap-2 text-sm text-white/70 min-h-[44px] cursor-pointer">
              <Checkbox
                checked={Boolean((value as any)[key])}
                onCheckedChange={(c) => set({ [key]: c === true } as Partial<ItemDraft>)}
              />
              {f.label}
            </label>
          );
        }

        if (f.control === "select") {
          const options =
            key === "kind" ? ITEM_KINDS.map((k) => ({ v: k, l: ITEM_KIND_LABELS[k] }))
            : key === "brandOwner" ? BRAND_OWNERS.map((b) => ({ v: b, l: BRAND_OWNER_LABELS[b] }))
            : key === "unit" ? UNITS.map((u) => ({ v: u, l: UNIT_LABELS[u] }))
            : locations.filter((l) => l.active).map((l) => ({ v: String(l.id), l: l.code }));
          const isLocation = key === "defaultLocationId";
          return (
            <div key={f.id} className="space-y-1">
              <FieldLabel f={f} />
              <Select
                value={(value as any)[key] || (isLocation ? NONE : undefined)}
                onValueChange={(v) => set({ [key]: isLocation && v === NONE ? "" : v } as Partial<ItemDraft>)}
              >
                <SelectTrigger className="bg-white/[0.02] border-white/10 text-white"><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  {isLocation && <SelectItem value={NONE}>None</SelectItem>}
                  {options.map((o) => <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>)}
                </SelectContent>
              </Select>
              {f.hint && <p className="text-[11px] text-white/30">{f.hint}</p>}
            </div>
          );
        }

        if (f.control === "textarea") {
          return (
            <div key={f.id} className="space-y-1">
              <FieldLabel f={f} />
              <textarea
                rows={3}
                value={(value as any)[key] ?? ""}
                onChange={(e) => set({ [key]: e.target.value } as Partial<ItemDraft>)}
                className="w-full rounded-lg bg-white/[0.02] border border-white/10 px-3 py-2 text-sm text-white/80 scroll-mb-24"
              />
            </div>
          );
        }

        return (
          <div key={f.id} className="space-y-1">
            <FieldLabel f={f} />
            <Input
              type={f.control === "number" || f.control === "money" ? "number" : "text"}
              step={f.control === "money" ? "0.01" : undefined}
              placeholder={f.control === "money" ? "0.00" : undefined}
              value={(value as any)[key] ?? ""}
              onChange={(e) => set({ [key]: e.target.value } as Partial<ItemDraft>)}
              className={`bg-white/[0.02] border-white/10 text-white scroll-mb-24 ${key === "sku" ? "font-mono" : ""}`}
            />
            {f.hint && <p className="text-[11px] text-white/30">{f.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Back-to-step-1 header, so the mode is always visible and reversible while
 *  the form is still a draft. */
export function ModeHeader({ mode, onBack }: { mode: TrackingMode; onBack: () => void }) {
  const choice = TRACKING_MODE_CHOICES.find((c) => c.mode === mode)!;
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-2 text-xs text-white/50 hover:text-white/80 mb-3"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-400">{choice.title}</span>
      <span className="text-white/30">change</span>
    </button>
  );
}

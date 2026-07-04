import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plus, Edit, X, Search, Package2, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { centsToDollarInput, dollarInputToCents } from "@/lib/format";
import type { PrintMaterial } from "@shared/schema";

const CATEGORY_LABEL: Record<string, string> = {
  banner: "Banner",
  corflute: "Corflute",
  vinyl_decal: "Vinyl Decal",
  aluminium: "Aluminium",
  garment: "Garment",
  rollup: "Roll-up",
  poster: "Poster",
  sticker: "Sticker",
  custom: "Custom",
};

const PRICING_LABEL: Record<string, string> = {
  per_m2: "Per m²",
  per_piece: "Per piece",
  per_piece_tiered: "Tiered (stock sizes)",
  garment_decoration: "Garment + decoration",
  bundle: "Bundle",
};

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function EditModal({
  open, onClose, material, orgId,
}: { open: boolean; onClose: () => void; material: PrintMaterial | null; orgId: number }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => material ? {
    name: material.name,
    baseRate: centsToDollarInput(material.baseRateCents),
    substrateCostPerM2: centsToDollarInput(material.substrateCostPerM2Cents),
    minCharge: centsToDollarInput(material.minChargeCents),
    turnaroundDays: material.turnaroundDays,
    isActive: material.isActive,
    rushAvailable: material.rushAvailable,
    humanQuoteRequired: material.humanQuoteRequired,
    description: material.description ?? "",
  } : null);

  const save = useMutation({
    mutationFn: async () => {
      if (!material || !form) throw new Error("No material");
      const { baseRate, substrateCostPerM2, minCharge, ...rest } = form;
      const payload = {
        ...rest,
        baseRateCents: dollarInputToCents(baseRate),
        substrateCostPerM2Cents: dollarInputToCents(substrateCostPerM2),
        minChargeCents: dollarInputToCents(minCharge),
      };
      const res = await apiRequest("PATCH", `/api/admin/print-materials/${material.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-materials"] });
      toast({ title: "Saved" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  if (!open || !material || !form) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">{material.name}</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Name</label>
            <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="bg-white/[0.02] border-white/10 text-white" />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Description</label>
            <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[60px]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Base rate</label>
              <MoneyInput value={form.baseRate} onChange={v => setForm({ ...form, baseRate: v })} className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Substrate cost / m²</label>
              <MoneyInput value={form.substrateCostPerM2} onChange={v => setForm({ ...form, substrateCostPerM2: v })} className="bg-white/[0.02] border-white/10 text-white" />
              <div className="text-[10px] text-white/30 mt-0.5">for margin tracking</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Min charge</label>
              <MoneyInput value={form.minCharge} onChange={v => setForm({ ...form, minCharge: v })} className="bg-white/[0.02] border-white/10 text-white" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Turnaround (days)</label>
              <Input type="number" value={form.turnaroundDays} onChange={e => setForm({ ...form, turnaroundDays: parseInt(e.target.value) || 1 })} className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-2">
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} />
              Active
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.rushAvailable} onChange={e => setForm({ ...form, rushAvailable: e.target.checked })} />
              Rush available
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input type="checkbox" checked={form.humanQuoteRequired} onChange={e => setForm({ ...form, humanQuoteRequired: e.target.checked })} />
              Human quote
            </label>
          </div>
          <div className="text-xs text-white/40 pt-2 border-t border-white/5">
            For complex add-ons, qty tiers, or stock-size tables, edit the <code>addons_json</code>, <code>qty_tiers_json</code>, and <code>size_tiers_json</code> fields directly via the database for now. v2 will give you a richer editor.
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending} className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function PrintsMaterials() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<PrintMaterial | null>(null);

  const { data: materials = [], isLoading } = useQuery<PrintMaterial[]>({
    queryKey: ["/api/admin/print-materials", { orgId }],
    queryFn: () => fetch(`/api/admin/print-materials?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId,
  });

  const filtered = materials.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.slug.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Materials catalog</h1>
          <p className="text-sm text-white/40 mt-0.5">Every product the public order page can quote.</p>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <Input
            type="text"
            placeholder="Search materials..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10 bg-white/[0.02] border-white/10 text-white w-72"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(m => (
            <div
              key={m.id}
              onClick={() => setEditing(m)}
              className="rounded-xl border border-white/5 bg-white/[0.02] p-4 hover:border-white/10 hover:bg-white/[0.04] cursor-pointer transition"
            >
              <div className="flex items-start justify-between mb-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-white/40">{CATEGORY_LABEL[m.category]}</div>
                  <div className="font-bold text-white text-sm mt-0.5">{m.name}</div>
                </div>
                {!m.isActive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400">Inactive</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                <div>
                  <div className="text-[10px] uppercase text-white/30">Method</div>
                  <div className="text-white/70">{PRICING_LABEL[m.pricingMethod]}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-white/30">Base rate</div>
                  <div className="text-white/70 font-mono">{money(m.baseRateCents)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-white/30">Min charge</div>
                  <div className="text-white/70 font-mono">{money(m.minChargeCents)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase text-white/30">Turnaround</div>
                  <div className="text-white/70">{m.turnaroundDays}d{m.rushAvailable ? " · rush ok" : ""}</div>
                </div>
              </div>
              {m.substrateCostPerM2Cents > 0 && m.pricingMethod === "per_m2" && (
                <div className="mt-3 pt-3 border-t border-white/5 text-[10px] text-white/40">
                  Margin at base rate: {Math.round(((m.baseRateCents - m.substrateCostPerM2Cents) / m.baseRateCents) * 100)}%
                </div>
              )}
              <div className="mt-3 text-[10px] text-white/30 font-mono truncate">/{m.slug}</div>
            </div>
          ))}
        </div>
      )}

      <EditModal
        open={!!editing}
        onClose={() => setEditing(null)}
        material={editing}
        orgId={orgId ?? 0}
        key={editing?.id ?? "new"}
      />
    </div>
  );
}

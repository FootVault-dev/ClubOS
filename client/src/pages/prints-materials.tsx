// Materials catalog — United Prints.
//
// Since 2026-08-12 this page is ALSO the price list on unitedprints.co.nz.
// A material with "Show on the website quote" ticked appears in the Instant
// Quote generator, and its base rate is what the public gets quoted. Editing
// a price here changes the public price within a minute; there is no deploy
// and nothing to ask Daniel for. That is the whole point of the change, so
// the page says so out loud rather than hiding it behind a checkbox label.

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Plus, X, Search, Globe, ExternalLink, Info } from "lucide-react";
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

// What "base rate" actually means depends on the pricing method, and getting
// that wrong is how you publish a $145 price as if it were $145 per sign.
const RATE_HINT: Record<string, string> = {
  per_m2: "per square metre",
  per_piece: "per item",
  per_piece_tiered: "per m² for custom sizes",
  garment_decoration: "per blank garment",
  bundle: "per bundle",
};

const QUOTE_PAGE_URL = "https://unitedprints.co.nz/instant-quote";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

type FormState = {
  name: string;
  description: string;
  category: string;
  pricingMethod: string;
  baseRate: string;
  substrateCostPerM2: string;
  minCharge: string;
  turnaroundDays: number;
  maxRollWidthMm: string;
  isActive: boolean;
  rushAvailable: boolean;
  humanQuoteRequired: boolean;
  quoteOnWebsite: boolean;
};

function blankForm(): FormState {
  return {
    name: "",
    description: "",
    category: "banner",
    pricingMethod: "per_m2",
    baseRate: "",
    substrateCostPerM2: "",
    minCharge: "",
    turnaroundDays: 3,
    // The shop's printer. Blank for panels/garments, which aren't roll-fed.
    maxRollWidthMm: "1600",
    isActive: true,
    rushAvailable: true,
    humanQuoteRequired: false,
    // Off by default even here: a brand-new product should be priced and
    // checked before the public can be quoted from it.
    quoteOnWebsite: false,
  };
}

function formFrom(material: PrintMaterial): FormState {
  return {
    name: material.name,
    description: material.description ?? "",
    category: material.category,
    pricingMethod: material.pricingMethod,
    baseRate: centsToDollarInput(material.baseRateCents),
    substrateCostPerM2: centsToDollarInput(material.substrateCostPerM2Cents),
    minCharge: centsToDollarInput(material.minChargeCents),
    turnaroundDays: material.turnaroundDays,
    maxRollWidthMm: (material as any).maxRollWidthMm != null ? String((material as any).maxRollWidthMm) : "",
    isActive: material.isActive,
    rushAvailable: material.rushAvailable,
    humanQuoteRequired: material.humanQuoteRequired,
    quoteOnWebsite: (material as any).quoteOnWebsite ?? false,
  };
}

function EditModal({
  open, onClose, material, isNew,
}: { open: boolean; onClose: () => void; material: PrintMaterial | null; isNew: boolean }) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() =>
    isNew ? blankForm() : (material ? formFrom(material) : blankForm())
  );

  const save = useMutation({
    mutationFn: async () => {
      const { baseRate, substrateCostPerM2, minCharge, maxRollWidthMm, ...rest } = form;
      const rollWidth = parseInt(maxRollWidthMm, 10);
      const payload = {
        ...rest,
        baseRateCents: dollarInputToCents(baseRate),
        substrateCostPerM2Cents: dollarInputToCents(substrateCostPerM2),
        minChargeCents: dollarInputToCents(minCharge),
        // Blank means "not a roll product" — send null, never 0. A 0 would
        // read as a limit and refuse every size.
        maxRollWidthMm: Number.isFinite(rollWidth) && rollWidth > 0 ? rollWidth : null,
      };
      const res = isNew
        // The server derives the slug and takes the org from the workspace —
        // neither is asked for here.
        ? await apiRequest("POST", `/api/admin/print-materials`, payload)
        : await apiRequest("PATCH", `/api/admin/print-materials/${material!.id}`, payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/print-materials"] });
      toast({
        title: isNew ? "Product added" : "Saved",
        description: form.quoteOnWebsite && form.isActive
          ? "unitedprints.co.nz will quote this price within a minute."
          : undefined,
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  if (!open || (!isNew && !material)) return null;

  const onWebsite = form.quoteOnWebsite && form.isActive;
  const rateHint = RATE_HINT[form.pricingMethod] ?? "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-white">
            {isNew ? "Add a product" : material!.name}
          </h3>
          <button onClick={onClose} className="text-white/40 hover:text-white" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">
              Name {onWebsite && <span className="text-blue-300 normal-case tracking-normal">— customers see this on the website</span>}
            </label>
            <Input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Self-Adhesive Vinyl"
              className="bg-white/[0.02] border-white/10 text-white"
            />
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Description</label>
            <textarea
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="The spec — thickness, finishing, how long it lasts outdoors."
              className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm min-h-[60px]"
            />
            <div className="text-[10px] text-white/30 mt-0.5">Shown under the product on the website quote form.</div>
          </div>

          {isNew && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">Category</label>
                <select
                  value={form.category}
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm"
                >
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k} className="bg-[#02060E]">{v}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-white/40">How it's priced</label>
                <select
                  value={form.pricingMethod}
                  onChange={e => setForm({ ...form, pricingMethod: e.target.value })}
                  className="w-full px-3 py-2 rounded-md bg-white/[0.02] border border-white/10 text-white text-sm"
                >
                  {Object.entries(PRICING_LABEL).map(([k, v]) => <option key={k} value={k} className="bg-[#02060E]">{v}</option>)}
                </select>
                <div className="text-[10px] text-white/30 mt-0.5">Can't be changed later.</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Base rate</label>
              <MoneyInput value={form.baseRate} onChange={v => setForm({ ...form, baseRate: v })} className="bg-white/[0.02] border-white/10 text-white" />
              <div className="text-[10px] text-white/30 mt-0.5">{rateHint}, ex GST</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Substrate cost / m²</label>
              <MoneyInput value={form.substrateCostPerM2} onChange={v => setForm({ ...form, substrateCostPerM2: v })} className="bg-white/[0.02] border-white/10 text-white" />
              <div className="text-[10px] text-white/30 mt-0.5">Your cost — never shown publicly</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Min charge</label>
              <MoneyInput value={form.minCharge} onChange={v => setForm({ ...form, minCharge: v })} className="bg-white/[0.02] border-white/10 text-white" />
              <div className="text-[10px] text-white/30 mt-0.5">Small jobs get topped up to this</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-white/40">Turnaround (days)</label>
              <Input type="number" value={form.turnaroundDays} onChange={e => setForm({ ...form, turnaroundDays: parseInt(e.target.value) || 1 })} className="bg-white/[0.02] border-white/10 text-white" />
            </div>
          </div>

          {/* The machine limit. Explained rather than labelled, because the
              non-obvious part is that it applies to the SHORTER side. */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-white/40">Printer roll width (mm)</label>
            <Input
              type="number"
              value={form.maxRollWidthMm}
              onChange={e => setForm({ ...form, maxRollWidthMm: e.target.value })}
              placeholder="1600"
              className="bg-white/[0.02] border-white/10 text-white"
            />
            <div className="text-[10px] text-white/30 mt-0.5">
              {form.maxRollWidthMm && parseInt(form.maxRollWidthMm, 10) > 0
                ? `One side of the sign must be ${(parseInt(form.maxRollWidthMm, 10) / 1000).toFixed(2).replace(/0$/, "")}m or under — the other side can be any length. A ${(parseInt(form.maxRollWidthMm, 10) / 1000).toFixed(2).replace(/0$/, "")}m limit still allows a 5m long banner.`
                : "Leave blank for anything not printed off a roll — panels, garments."}
            </div>
          </div>

          {/* The website switch gets its own block — it is the one setting on
              this form with a consequence outside ClubOS. */}
          <div className={`rounded-xl border p-3 mt-1 transition ${onWebsite ? "border-blue-500/40 bg-blue-500/[0.07]" : "border-white/10 bg-white/[0.02]"}`}>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={form.quoteOnWebsite}
                onChange={e => setForm({ ...form, quoteOnWebsite: e.target.checked })}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-white">
                  <Globe className="w-3.5 h-3.5 text-blue-300" />
                  Show on the website quote
                </span>
                <span className="block text-xs text-white/50 mt-0.5">
                  Customers pick this on the Instant Quote page and get priced off the base rate above.
                  Saving publishes it — no deploy needed.
                </span>
              </span>
            </label>
            {form.quoteOnWebsite && !form.isActive && (
              <div className="mt-2 text-xs text-amber-300/90 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                Inactive products never show on the website, ticked or not. Turn Active on as well.
              </div>
            )}
            {form.quoteOnWebsite && form.humanQuoteRequired && (
              <div className="mt-2 text-xs text-amber-300/90 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                "Human quote" means the website shows no price for this and asks the customer to send it through.
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
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

          {!isNew && (
            <div className="text-xs text-white/40 pt-2 border-t border-white/5">
              For add-ons, quantity discounts, or stock-size tables, edit the <code>addons_json</code>,{" "}
              <code>qty_tiers_json</code>, and <code>size_tiers_json</code> fields directly via the database for now.
              v2 will give you a richer editor.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className="bg-blue-600 hover:bg-blue-700">
            {save.isPending ? "Saving..." : isNew ? "Add product" : "Save changes"}
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
  const [creating, setCreating] = useState(false);

  const { data: materials = [], isLoading } = useQuery<PrintMaterial[]>({
    queryKey: ["/api/admin/print-materials", { orgId }],
    queryFn: () => fetch(`/api/admin/print-materials?orgId=${orgId}`, { credentials: "include" }).then(r => r.json()),
    enabled: !!orgId,
  });

  const filtered = materials.filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase()) || m.slug.toLowerCase().includes(search.toLowerCase())
  );

  const onWebsiteCount = materials.filter(m => (m as any).quoteOnWebsite && m.isActive).length;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Materials catalog</h1>
          <p className="text-sm text-white/40 mt-0.5">Every product we can quote — and the prices the website uses.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <Input
              type="text"
              placeholder="Search materials..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 bg-white/[0.02] border-white/10 text-white w-56 sm:w-72"
            />
          </div>
          <Button onClick={() => setCreating(true)} className="bg-blue-600 hover:bg-blue-700 shrink-0">
            <Plus className="w-4 h-4 mr-1.5" />
            Add product
          </Button>
        </div>
      </div>

      {/* States the connection plainly, so nobody edits a price without
          realising the public sees it. */}
      <div className="rounded-xl border border-blue-500/25 bg-blue-500/[0.06] p-3.5 flex items-start gap-3">
        <Globe className="w-4 h-4 text-blue-300 mt-0.5 shrink-0" />
        <div className="text-sm text-white/70 min-w-0">
          <span className="text-white font-semibold">
            {onWebsiteCount} {onWebsiteCount === 1 ? "product is" : "products are"} live on the website quote.
          </span>{" "}
          Change a base rate here and unitedprints.co.nz quotes the new price within a minute — no deploy, no developer.
          <a
            href={QUOTE_PAGE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 ml-1.5 text-blue-300 hover:text-blue-200 underline decoration-blue-300/40"
          >
            See the page <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm">Loading...</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(m => {
            const onWebsite = (m as any).quoteOnWebsite && m.isActive;
            return (
              <div
                key={m.id}
                onClick={() => setEditing(m)}
                className={`rounded-xl border p-4 cursor-pointer transition ${
                  onWebsite
                    ? "border-blue-500/30 bg-blue-500/[0.04] hover:border-blue-500/50 hover:bg-blue-500/[0.07]"
                    : "border-white/5 bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-white/40">{CATEGORY_LABEL[m.category]}</div>
                    <div className="font-bold text-white text-sm mt-0.5">{m.name}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {!m.isActive && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/20 text-zinc-400">Inactive</span>
                    )}
                    {onWebsite && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-200 inline-flex items-center gap-1">
                        <Globe className="w-2.5 h-2.5" /> On website
                      </span>
                    )}
                  </div>
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
            );
          })}
        </div>
      )}

      <EditModal
        open={!!editing || creating}
        onClose={() => { setEditing(null); setCreating(false); }}
        material={editing}
        isNew={creating}
        key={creating ? "new" : (editing?.id ?? "none")}
      />
    </div>
  );
}

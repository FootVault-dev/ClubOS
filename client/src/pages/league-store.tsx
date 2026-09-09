/**
 * Store — native e-commerce admin (Shopify replacement pilot). Shared by
 * every shop_* brand (MFL, CIC, CUFC…) — org-aware via useWorkspace().
 *
 * Three sections: Products (catalogue with colours, per-colour images and the
 * size/stock matrix), Orders (the fulfilment pipeline), Settings (shipping
 * options + discount codes). Dark-launched super-admin-only via the "store"
 * tab lock in shared/tabs.ts.
 *
 * Money: DB is integer cents; every input is dollars via MoneyInput and every
 * display goes through formatCurrency. costUsd is a supplier reference only.
 */
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  ShoppingCart, Plus, Search, Pencil, Trash2, X, ArrowUp, ArrowDown,
  ImagePlus, Package, Truck, Tag, RefreshCw, Copy, Mail, Phone, Printer, Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoneyInput } from "@/components/ui/money-input";
import { formatCurrency, centsToDollarInput, dollarInputToCents } from "@/lib/format";

// ── Types (admin API shapes) ────────────────────────────────────────────────

type ShopVariantT = { id: number; colourId: number; size: string; sku: string | null; stock: number; active: boolean };
type ShopImageT = { id: number; colourId: number | null; url: string; alt: string | null; sortOrder: number };
type ShopColourT = {
  id: number; name: string; swatchHex: string | null; sortOrder: number; active: boolean;
  images: ShopImageT[]; variants: ShopVariantT[];
};
type ShopProductT = {
  id: number; slug: string; title: string; subtitle: string | null; description: string | null;
  type: string; priceCents: number; compareAtCents: number | null; costUsd: string | null;
  badge: string | null; status: string; sortOrder: number;
  colours: ShopColourT[]; images: ShopImageT[]; totalStock: number;
};
type SponsorSlotT = { text?: string; logoUrl?: string }; // logoUrl wins if both
type KitCustomisationT = {
  teamLogo?: SponsorSlotT; frontSponsor?: SponsorSlotT; backTopSponsor?: SponsorSlotT; backBottomSponsor?: SponsorSlotT;
};
type UnitPersonalisationT = { name?: string; number?: string };
type ShopOrderRowT = {
  id: number; orderNumber: string | null; status: string; firstName: string; lastName: string;
  email: string; phone: string; totalCents: number; itemsCount: number; createdAt: string;
  shippingLabel: string | null;
  paymentMode: string; teamName: string | null; playerCount: number; paidCount: number;
};
type ShopOrderItemT = {
  id: number; title: string; colourName: string | null; size: string | null; imageUrl: string | null;
  unitCents: number; qty: number; lineCents: number;
  customisation: KitCustomisationT | null; units: UnitPersonalisationT[] | null;
};
type ShopShareT = {
  id: number; playerName: string; playerEmail: string; playerPhone: string | null;
  size: string; shirtName: string | null; shirtNumber: string | null; amountCents: number;
  status: string; paidAt: string | null; payUrl: string | null; shareToken: string;
};
type ShopOrderDetailT = ShopOrderRowT & {
  shippingCents: number; subtotalCents: number; discountCents: number; discountCode: string | null;
  gstCents: number; addressLine1: string | null; addressLine2: string | null; suburb: string | null;
  city: string | null; postcode: string | null; stripePaymentIntentId: string | null;
  utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
  utmContent: string | null; utmTerm: string | null; fbclid: string | null; gclid: string | null;
  visitorId: string | null; notes: string | null; paidAt: string | null; allPaidAt: string | null; source: string;
  items: ShopOrderItemT[]; shares: ShopShareT[];
};
type ShippingOptionT = {
  id: number; label: string; description: string | null; priceCents: number;
  requiresAddress: boolean; active: boolean; sortOrder: number;
};
type DiscountCodeT = {
  id: number; code: string; kind: string; value: number; active: boolean;
  startsAt: string | null; endsAt: string | null; maxUses: number | null; usedCount: number;
};

// ── Shared bits ─────────────────────────────────────────────────────────────

const jget = (url: string) => apiRequest("GET", url).then((r) => r.json());

async function uploadImage(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/admin/uploads/image", { method: "POST", body: fd, credentials: "include" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || "Upload failed");
  return body.url as string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-amber-400/10 text-amber-400 border-amber-400/20" },
  awaiting_players: { label: "Players paying", cls: "bg-amber-400/10 text-amber-400 border-amber-400/20" },
  paid: { label: "Paid", cls: "bg-emerald-400/10 text-emerald-400 border-emerald-400/20" },
  processing: { label: "Processing", cls: "bg-blue-400/10 text-blue-400 border-blue-400/20" },
  ready_for_pickup: { label: "Ready for pickup", cls: "bg-purple-400/10 text-purple-400 border-purple-400/20" },
  shipped: { label: "Shipped", cls: "bg-cyan-400/10 text-cyan-400 border-cyan-400/20" },
  completed: { label: "Completed", cls: "bg-white/10 text-white/70 border-white/20" },
  cancelled: { label: "Cancelled", cls: "bg-red-400/10 text-red-400 border-red-400/20" },
  refunded: { label: "Refunded", cls: "bg-orange-400/10 text-orange-400 border-orange-400/20" },
};

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] || { label: status, cls: "bg-white/5 text-white/50 border-white/10" };
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

/** Order pill — 'awaiting_players' shows live Player Pay progress in amber. */
function OrderStatusPill({ order }: { order: { status: string; paidCount?: number; playerCount?: number } }) {
  if (order.status === "awaiting_players") {
    return (
      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap uppercase tracking-wide bg-amber-400/10 text-amber-400 border-amber-400/20">
        Players paying ({order.paidCount ?? 0}/{order.playerCount ?? 0})
      </span>
    );
  }
  return <StatusPill status={order.status} />;
}

function ProductStatusPill({ status }: { status: string }) {
  const cls = status === "active"
    ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
    : status === "archived"
      ? "bg-white/5 text-white/40 border-white/10"
      : "bg-amber-400/10 text-amber-400 border-amber-400/20";
  return <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border capitalize ${cls}`}>{status}</span>;
}

const thCls = "text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold px-5 py-3";

// ── Page ────────────────────────────────────────────────────────────────────

export default function LeagueStore() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const [section, setSection] = useState<"products" | "orders" | "settings">("products");

  const { data: stats } = useQuery<{ revenueCents: number; ordersCount: number; unitsSold: number; byStatus: Record<string, number> }>({
    queryKey: ["/api/admin/shop/stats", { orgId }],
    queryFn: () => jget(`/api/admin/shop/stats?orgId=${orgId}`),
    enabled: !!orgId,
  });

  if (!orgId) return null;

  const sections = [
    { key: "products" as const, label: "Products", icon: Package },
    { key: "orders" as const, label: "Orders", icon: ShoppingCart },
    { key: "settings" as const, label: "Settings", icon: Tag },
  ];

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white" data-testid="text-store-title">Store</h1>
          <p className="text-sm text-white/40 mt-1">Native e-commerce — products, orders and fulfilment. Pilot replacement for Shopify.</p>
        </div>
        <div className="flex items-center gap-3">
          {[
            { label: "Revenue", value: formatCurrency(stats?.revenueCents ?? 0, { fromCents: true }) },
            { label: "Orders", value: String(stats?.ordersCount ?? 0) },
            { label: "Units", value: String(stats?.unitsSold ?? 0) },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-blue-500/10 bg-white/[0.02] px-4 py-2.5 min-w-[92px]">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">{s.label}</p>
              <p className="text-base font-bold text-white mt-0.5" data-testid={`stat-${s.label.toLowerCase()}`}>{s.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {sections.map((s) => (
          <button
            key={s.key}
            onClick={() => setSection(s.key)}
            data-testid={`tab-${s.key}`}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors border ${
              section === s.key
                ? "bg-blue-600 text-white border-blue-500"
                : "bg-white/[0.02] text-white/50 border-blue-500/10 hover:text-white/80"
            }`}
          >
            <s.icon className="w-4 h-4" />
            {s.label}
            {s.key === "orders" && (stats?.byStatus?.paid || 0) > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-400/20 text-emerald-300">
                {stats!.byStatus.paid}
              </span>
            )}
          </button>
        ))}
      </div>

      {section === "products" && <ProductsSection orgId={orgId} />}
      {section === "orders" && <OrdersSection orgId={orgId} />}
      {section === "settings" && <SettingsSection orgId={orgId} />}
    </div>
  );
}

// ═══ Products ═══════════════════════════════════════════════════════════════

function ProductsSection({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | "new" | null>(null);

  const { data: products = [], isLoading } = useQuery<ShopProductT[]>({
    queryKey: ["/api/admin/shop/products", { orgId }],
    queryFn: () => jget(`/api/admin/shop/products?orgId=${orgId}`),
    enabled: !!orgId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/products", { orgId }] });

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) => apiRequest("POST", "/api/admin/shop/products/reorder", { ids }),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/shop/products/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Product deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const move = (index: number, dir: -1 | 1) => {
    const ids = products.map((p) => p.id);
    const target = index + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorderMut.mutate(ids);
  };

  const thumbFor = (p: ShopProductT): string | null => {
    const colourImage = p.colours.flatMap((c) => c.images)[0];
    return p.images[0]?.url || colourImage?.url || null;
  };

  const editing = editingId === "new" ? "new" : products.find((p) => p.id === editingId) || null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/40">{products.length} product{products.length !== 1 ? "s" : ""}</p>
        <Button onClick={() => setEditingId("new")} className="bg-blue-600 hover:bg-blue-700 text-white gap-2" data-testid="button-new-product">
          <Plus className="w-4 h-4" /> New Product
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-2xl bg-white/[0.02] animate-pulse" />)}</div>
      ) : products.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <Package className="w-12 h-12 mb-3" />
            <p className="text-sm">No products yet</p>
            <p className="text-xs mt-1">Create your first product — kit, shirt, whatever you're selling</p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className={thCls}>Product</th>
                <th className={`${thCls} hidden sm:table-cell`}>Type</th>
                <th className={thCls}>Price</th>
                <th className={`${thCls} hidden md:table-cell`}>Stock</th>
                <th className={thCls}>Status</th>
                <th className="w-32" />
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={p.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors" data-testid={`product-row-${p.id}`}>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      {thumbFor(p) ? (
                        <img src={thumbFor(p)!} alt={p.title} className="w-10 h-10 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                          <Package className="w-4 h-4 text-white/20" />
                        </div>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white/80 truncate">{p.title}</p>
                        <p className="text-xs text-white/30 truncate">/{p.slug}{p.badge ? ` · ${p.badge}` : ""}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 hidden sm:table-cell">
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-white/60 border border-white/10 capitalize">{p.type}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="text-sm text-white/80">{formatCurrency(p.priceCents, { fromCents: true })}</p>
                    {p.compareAtCents != null && (
                      <p className="text-xs text-white/30 line-through">{formatCurrency(p.compareAtCents, { fromCents: true })}</p>
                    )}
                  </td>
                  <td className="px-5 py-3.5 text-sm hidden md:table-cell">
                    <span className={p.totalStock === 0 ? "text-red-400/80" : "text-white/50"}>{p.totalStock}</span>
                  </td>
                  <td className="px-5 py-3.5"><ProductStatusPill status={p.status} /></td>
                  <td className="px-3 py-3.5">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30 disabled:opacity-20"><ArrowUp className="w-3.5 h-3.5" /></button>
                      <button onClick={() => move(i, 1)} disabled={i === products.length - 1} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30 disabled:opacity-20"><ArrowDown className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditingId(p.id)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30" data-testid={`button-edit-product-${p.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                      <button
                        onClick={() => { if (confirm(`Delete "${p.title}"? Existing orders keep their snapshots.`)) deleteMut.mutate(p.id); }}
                        className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400"
                      ><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingId !== null && (
        <ProductModal
          orgId={orgId}
          product={editing === "new" ? undefined : editing || undefined}
          onCreated={(id) => setEditingId(id)}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}

function ProductModal({ orgId, product, onCreated, onClose }: {
  orgId: number;
  product?: ShopProductT;
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    title: product?.title || "",
    type: product?.type || "shirt",
    status: product?.status || "draft",
    price: centsToDollarInput(product?.priceCents ?? null),
    compareAt: centsToDollarInput(product?.compareAtCents ?? null),
    costUsd: product?.costUsd || "",
    subtitle: product?.subtitle || "",
    badge: product?.badge || "",
    description: product?.description || "",
  });
  // Re-seed money/detail fields only when switching to a different product.
  useEffect(() => {
    setForm({
      title: product?.title || "",
      type: product?.type || "shirt",
      status: product?.status || "draft",
      price: centsToDollarInput(product?.priceCents ?? null),
      compareAt: centsToDollarInput(product?.compareAtCents ?? null),
      costUsd: product?.costUsd || "",
      subtitle: product?.subtitle || "",
      badge: product?.badge || "",
      description: product?.description || "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/products", { orgId }] });

  const payload = () => ({
    organizationId: orgId,
    title: form.title,
    type: form.type,
    status: form.status,
    priceCents: dollarInputToCents(form.price),
    compareAtCents: form.compareAt ? dollarInputToCents(form.compareAt) : null,
    costUsd: form.costUsd || null,
    subtitle: form.subtitle,
    badge: form.badge,
    description: form.description,
  });

  const createMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/shop/products", payload()).then((r) => r.json()),
    onSuccess: (created: any) => { invalidate(); toast({ title: "Product created", description: "Now add colours, images and sizes." }); onCreated(created.id); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/shop/products/${product!.id}`, payload()),
    onSuccess: () => { invalidate(); toast({ title: "Product saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saving = createMut.isPending || updateMut.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5 sticky top-0 bg-[#0a0e1a] z-10">
          <h2 className="text-lg font-semibold text-white">{product ? "Edit Product" : "New Product"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60" data-testid="button-close-product-modal"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="text-xs text-white/40 mb-1 block">Title</label>
              <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} className="premium-input text-white" placeholder="2026 Home Shirt" data-testid="input-product-title" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Type</label>
              <Input value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className="premium-input text-white" placeholder="kit, shirt…" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Status</label>
              <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger className="premium-input text-white" data-testid="select-product-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft (hidden)</SelectItem>
                  <SelectItem value="active">Active (live in store)</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Price (NZD, incl. GST)</label>
              <MoneyInput value={form.price} onChange={(v) => setForm((f) => ({ ...f, price: v }))} data-testid="input-product-price" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Compare-at price (optional)</label>
              <MoneyInput value={form.compareAt} onChange={(v) => setForm((f) => ({ ...f, compareAt: v }))} />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-white/40 mb-1 block">Cost (USD, ex shipping/duties) — reference only</label>
              <Input
                inputMode="decimal"
                value={form.costUsd}
                onChange={(e) => setForm((f) => ({ ...f, costUsd: e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1") }))}
                className="premium-input text-white"
                placeholder="e.g. 8.50"
                data-testid="input-product-cost-usd"
              />
              <p className="text-[11px] text-white/25 mt-1">Supplier cost note for margin awareness. Never shown to customers, never used in pricing.</p>
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Subtitle (optional)</label>
              <Input value={form.subtitle} onChange={(e) => setForm((f) => ({ ...f, subtitle: e.target.value }))} className="premium-input text-white" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Badge (optional)</label>
              <Input value={form.badge} onChange={(e) => setForm((f) => ({ ...f, badge: e.target.value }))} className="premium-input text-white" placeholder="New, Limited…" />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-white/40 mb-1 block">Description</label>
              <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="premium-input text-white min-h-[90px]" />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="text-white/40">Close</Button>
            <Button
              onClick={() => (product ? updateMut.mutate() : createMut.mutate())}
              disabled={!form.title || saving}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="button-save-product"
            >
              {saving ? "Saving…" : product ? "Save changes" : "Create product"}
            </Button>
          </div>

          {product ? (
            <ColoursManager orgId={orgId} product={product} />
          ) : (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 text-sm text-white/30">
              Create the product first — then add colours, images and the size/stock matrix here.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Colours + per-colour images + the size/stock matrix.
function ColoursManager({ orgId, product }: { orgId: number; product: ShopProductT }) {
  const { toast } = useToast();
  const [newColour, setNewColour] = useState({ name: "", swatchHex: "#111111" });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/products", { orgId }] });

  const addColourMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/shop/products/${product.id}/colours`, newColour),
    onSuccess: () => { invalidate(); setNewColour({ name: "", swatchHex: "#111111" }); toast({ title: "Colour added" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4 pt-2 border-t border-white/5">
      <div>
        <h3 className="text-sm font-semibold text-white">Colours, images & sizes</h3>
        <p className="text-xs text-white/30 mt-0.5">Each colour has its own photos and its own size/stock matrix. Customers pick colour → size.</p>
      </div>

      {product.colours.map((c) => (
        <ColourCard key={c.id} orgId={orgId} productId={product.id} colour={c} />
      ))}

      <div className="rounded-xl border border-dashed border-white/10 p-4 flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs text-white/40 mb-1 block">New colour name</label>
          <Input value={newColour.name} onChange={(e) => setNewColour((f) => ({ ...f, name: e.target.value }))} className="premium-input text-white" placeholder="Black / Gold" data-testid="input-new-colour-name" />
        </div>
        <div>
          <label className="text-xs text-white/40 mb-1 block">Swatch</label>
          <Input type="color" value={newColour.swatchHex} onChange={(e) => setNewColour((f) => ({ ...f, swatchHex: e.target.value }))} className="h-9 w-16 p-1 bg-transparent border border-white/10 rounded-lg" />
        </div>
        <Button onClick={() => addColourMut.mutate()} disabled={!newColour.name || addColourMut.isPending} className="bg-white/5 hover:bg-white/10 text-white border border-white/10 gap-2" data-testid="button-add-colour">
          <Plus className="w-4 h-4" /> Add colour
        </Button>
      </div>
    </div>
  );
}

function ColourCard({ orgId, productId, colour }: { orgId: number; productId: number; colour: ShopColourT }) {
  const { toast } = useToast();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/products", { orgId }] });

  // Size/stock matrix — local rows, saved declaratively in one PUT.
  const seedRows = () => colour.variants.filter((v) => v.active).map((v) => ({ size: v.size, stock: String(v.stock) }));
  const [rows, setRows] = useState<{ size: string; stock: string }[]>(seedRows);
  const [newSize, setNewSize] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setRows(seedRows()); setDirty(false); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [colour.id]);

  const [uploading, setUploading] = useState(false);

  const deleteColourMut = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/shop/colours/${colour.id}`),
    onSuccess: () => { invalidate(); toast({ title: "Colour removed" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const deleteImageMut = useMutation({
    mutationFn: (imageId: number) => apiRequest("DELETE", `/api/admin/shop/images/${imageId}`),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const saveVariantsMut = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/admin/shop/colours/${colour.id}/variants`, {
      sizes: rows.filter((r) => r.size.trim()).map((r) => ({ size: r.size.trim(), stock: parseInt(r.stock) || 0 })),
    }),
    onSuccess: () => { invalidate(); setDirty(false); toast({ title: "Sizes & stock saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const onUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const url = await uploadImage(file);
        await apiRequest("POST", `/api/admin/shop/products/${productId}/images`, { url, colourId: colour.id, alt: colour.name });
      }
      invalidate();
      toast({ title: files.length > 1 ? `${files.length} images uploaded` : "Image uploaded" });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const addSize = () => {
    const size = newSize.trim();
    if (!size || rows.some((r) => r.size.toLowerCase() === size.toLowerCase())) return;
    setRows((r) => [...r, { size, stock: "0" }]);
    setNewSize("");
    setDirty(true);
  };

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-4" data-testid={`colour-card-${colour.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-5 h-5 rounded-full border border-white/20 flex-shrink-0" style={{ backgroundColor: colour.swatchHex || "#333" }} />
          <p className="text-sm font-semibold text-white truncate">{colour.name}</p>
        </div>
        <button
          onClick={() => { if (confirm(`Remove colour "${colour.name}" and its images/sizes?`)) deleteColourMut.mutate(); }}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400 flex-shrink-0"
        ><Trash2 className="w-3.5 h-3.5" /></button>
      </div>

      {/* Images */}
      <div className="flex items-center gap-2 flex-wrap">
        {colour.images.map((im) => (
          <div key={im.id} className="relative group">
            <img src={im.url} alt={im.alt || colour.name} className="w-16 h-16 rounded-lg object-cover border border-white/10" />
            <button
              onClick={() => deleteImageMut.mutate(im.id)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/90 text-white items-center justify-center hidden group-hover:flex"
            ><X className="w-3 h-3" /></button>
          </div>
        ))}
        <label className={`w-16 h-16 rounded-lg border border-dashed border-white/15 flex flex-col items-center justify-center gap-1 cursor-pointer hover:border-blue-400/40 hover:bg-blue-500/5 transition-colors ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
          <ImagePlus className="w-4 h-4 text-white/30" />
          <span className="text-[9px] text-white/30">{uploading ? "…" : "Add"}</span>
          <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { onUpload(e.target.files); e.target.value = ""; }} data-testid={`input-upload-image-${colour.id}`} />
        </label>
      </div>

      {/* Size / stock matrix */}
      <div className="space-y-2">
        <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Sizes & stock</p>
        <div className="flex flex-wrap gap-2">
          {rows.map((r, i) => (
            <div key={r.size} className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/20 pl-2.5 pr-1 py-1">
              <span className="text-xs font-semibold text-white/70">{r.size}</span>
              <Input
                inputMode="numeric"
                value={r.stock}
                onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setRows((rs) => rs.map((x, xi) => xi === i ? { ...x, stock: v } : x)); setDirty(true); }}
                className="premium-input text-white h-6 w-14 text-xs text-center px-1"
                data-testid={`input-stock-${colour.id}-${r.size}`}
              />
              <button onClick={() => { setRows((rs) => rs.filter((_, xi) => xi !== i)); setDirty(true); }} className="w-5 h-5 flex items-center justify-center rounded hover:bg-red-500/10 text-white/25 hover:text-red-400"><X className="w-3 h-3" /></button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <Input
              value={newSize}
              onChange={(e) => setNewSize(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addSize(); } }}
              placeholder="Add size (S, M, 7-8y…)"
              className="premium-input text-white h-8 w-40 text-xs"
              data-testid={`input-new-size-${colour.id}`}
            />
            <Button onClick={addSize} disabled={!newSize.trim()} size="sm" className="h-8 bg-white/5 hover:bg-white/10 text-white/70 border border-white/10">Add</Button>
          </div>
        </div>
        {dirty && (
          <Button onClick={() => saveVariantsMut.mutate()} disabled={saveVariantsMut.isPending} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white" data-testid={`button-save-sizes-${colour.id}`}>
            {saveVariantsMut.isPending ? "Saving…" : "Save sizes & stock"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ═══ Orders ═════════════════════════════════════════════════════════════════

function OrdersSection({ orgId }: { orgId: number }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);

  const { data: orders = [], isLoading } = useQuery<ShopOrderRowT[]>({
    queryKey: ["/api/admin/shop/orders", { orgId }],
    queryFn: () => jget(`/api/admin/shop/orders?orgId=${orgId}`),
    enabled: !!orgId,
  });

  const filtered = useMemo(() => orders
    .filter((o) => statusFilter === "all" || o.status === statusFilter)
    .filter((o) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return `${o.firstName} ${o.lastName}`.toLowerCase().includes(q)
        || o.email.toLowerCase().includes(q)
        || (o.orderNumber || "").toLowerCase().includes(q)
        || (o.teamName || "").toLowerCase().includes(q);
    }), [orders, statusFilter, search]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20" />
          <Input placeholder="Search name, email or order #…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 premium-input text-white" data-testid="input-search-orders" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="premium-input text-white w-[190px]" data-testid="select-order-status-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS_META).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="h-16 rounded-2xl bg-white/[0.02] animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <ShoppingCart className="w-12 h-12 mb-3" />
            <p className="text-sm">No orders{statusFilter !== "all" || search ? " match your filters" : " yet"}</p>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] overflow-hidden overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className={thCls}>Order</th>
                <th className={`${thCls} hidden sm:table-cell`}>Date</th>
                <th className={thCls}>Customer</th>
                <th className={`${thCls} hidden md:table-cell`}>Items</th>
                <th className={thCls}>Total</th>
                <th className={thCls}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr key={o.id} onClick={() => setOpenId(o.id)} className="border-b border-white/[0.03] hover:bg-white/[0.03] transition-colors cursor-pointer" data-testid={`order-row-${o.id}`}>
                  <td className="px-5 py-3.5 text-sm font-mono text-white/70">{o.orderNumber || `#${o.id}`}</td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden sm:table-cell whitespace-nowrap">
                    {new Date(o.createdAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}
                  </td>
                  <td className="px-5 py-3.5">
                    <p className="text-sm font-medium text-white/80">{o.firstName} {o.lastName}</p>
                    <p className="text-xs text-white/30">{o.teamName ? `${o.teamName} · ` : ""}{o.email}</p>
                  </td>
                  <td className="px-5 py-3.5 text-sm text-white/40 hidden md:table-cell">{o.itemsCount}</td>
                  <td className="px-5 py-3.5 text-sm font-semibold text-white/80 whitespace-nowrap">{formatCurrency(o.totalCents, { fromCents: true })}</td>
                  <td className="px-5 py-3.5"><OrderStatusPill order={o} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId != null && <OrderDetailModal orgId={orgId} orderId={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function OrderDetailModal({ orgId, orderId, onClose }: { orgId: number; orderId: number; onClose: () => void }) {
  const { toast } = useToast();
  const { data: order } = useQuery<ShopOrderDetailT>({
    queryKey: ["/api/admin/shop/orders", orderId],
    queryFn: () => jget(`/api/admin/shop/orders/${orderId}`),
  });
  const [notes, setNotes] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/orders", orderId] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/orders", { orgId }] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/stats", { orgId }] });
  };

  const statusMut = useMutation({
    mutationFn: (status: string) => apiRequest("PATCH", `/api/admin/shop/orders/${orderId}/status`, { status }),
    onSuccess: () => { invalidate(); toast({ title: "Order updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const notesMut = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/shop/orders/${orderId}`, { notes }),
    onSuccess: () => { invalidate(); setNotes(null); toast({ title: "Notes saved" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const resendMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/shop/orders/${orderId}/resend-confirmation`),
    onSuccess: () => toast({ title: "Confirmation email re-sent" }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (!order) return null;

  const isPickup = !order.addressLine1;
  const address = [order.addressLine1, order.addressLine2, order.suburb, order.city, order.postcode].filter(Boolean).join(", ");
  const attribution = [
    order.utmSource && `source: ${order.utmSource}`,
    order.utmMedium && `medium: ${order.utmMedium}`,
    order.utmCampaign && `campaign: ${order.utmCampaign}`,
    order.utmContent && `content: ${order.utmContent}`,
    order.utmTerm && `term: ${order.utmTerm}`,
    order.fbclid && "fbclid ✓",
    order.gclid && "gclid ✓",
  ].filter(Boolean) as string[];

  // The happy-path pipeline for the current status.
  const nextActions: { label: string; status: string }[] =
    order.status === "paid" ? [{ label: "Start processing", status: "processing" }]
    : order.status === "processing" ? (isPickup
        ? [{ label: "Ready for pickup", status: "ready_for_pickup" }]
        : [{ label: "Mark shipped", status: "shipped" }])
    : order.status === "ready_for_pickup" || order.status === "shipped" ? [{ label: "Complete order", status: "completed" }]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5 sticky top-0 bg-[#0a0e1a] z-10">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-white font-mono">{order.orderNumber || `#${order.id}`}</h2>
            <OrderStatusPill order={order} />
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60" data-testid="button-close-order-modal"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* Pipeline actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {nextActions.map((a) => (
              <Button key={a.status} onClick={() => statusMut.mutate(a.status)} disabled={statusMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid={`button-status-${a.status}`}>
                {a.label}
              </Button>
            ))}
            {order.status !== "pending" && (
              <Button onClick={() => resendMut.mutate()} disabled={resendMut.isPending} variant="ghost" className="text-white/40 gap-2">
                <RefreshCw className="w-3.5 h-3.5" /> Resend confirmation
              </Button>
            )}
            <div className="ml-auto">
              <Select value="" onValueChange={(v) => { if (v && confirm(`Set order to "${STATUS_META[v]?.label || v}"?`)) statusMut.mutate(v); }}>
                <SelectTrigger className="premium-input text-white/50 h-8 w-[150px] text-xs"><SelectValue placeholder="More…" /></SelectTrigger>
                <SelectContent>
                  {["processing", "ready_for_pickup", "shipped", "completed", "cancelled", "refunded"].map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Lines */}
          <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden">
            {order.items.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.03] last:border-0">
                {i.imageUrl ? (
                  <img src={i.imageUrl} alt={i.title} className="w-11 h-11 rounded-lg object-cover border border-white/10 flex-shrink-0" />
                ) : (
                  <div className="w-11 h-11 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center flex-shrink-0">
                    <Package className="w-4 h-4 text-white/20" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-white/80 truncate">{i.title}</p>
                  <p className="text-xs text-white/35">{[i.colourName, i.size].filter(Boolean).join(" · ")} — {i.qty} × {formatCurrency(i.unitCents, { fromCents: true })}</p>
                </div>
                <p className="text-sm font-semibold text-white/80 whitespace-nowrap">{formatCurrency(i.lineCents, { fromCents: true })}</p>
              </div>
            ))}
            <div className="px-4 py-3 space-y-1 bg-black/20">
              <Row label="Subtotal" value={formatCurrency(order.subtotalCents, { fromCents: true })} />
              {order.discountCents > 0 && <Row label={`Discount${order.discountCode ? ` (${order.discountCode})` : ""}`} value={`−${formatCurrency(order.discountCents, { fromCents: true })}`} />}
              <Row label={order.shippingLabel || "Shipping"} value={order.shippingCents > 0 ? formatCurrency(order.shippingCents, { fromCents: true }) : "Free"} />
              <Row label="GST content (incl.)" value={formatCurrency(order.gstCents, { fromCents: true })} muted />
              <div className="flex items-center justify-between pt-1.5 border-t border-white/10">
                <span className="text-sm font-semibold text-white">Total</span>
                <span className="text-sm font-bold text-white">{formatCurrency(order.totalCents, { fromCents: true })}</span>
              </div>
            </div>
          </div>

          {/* Print spec (kit customisation + roster) — Dima's source of truth */}
          <PrintSpecPanel order={order} />

          {/* Player Pay — who's paid their share */}
          <PlayerPayPanel order={order} />

          {/* Customer + delivery */}
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-1.5">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold mb-1">Customer</p>
              <p className="text-sm font-medium text-white/80">{order.firstName} {order.lastName}</p>
              <a href={`mailto:${order.email}`} className="flex items-center gap-1.5 text-sm text-blue-400/80 hover:text-blue-300"><Mail className="w-3.5 h-3.5" />{order.email}</a>
              <a href={`tel:${order.phone}`} className="flex items-center gap-1.5 text-sm text-blue-400/80 hover:text-blue-300"><Phone className="w-3.5 h-3.5" />{order.phone}</a>
            </div>
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-1.5">
              <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold mb-1">{isPickup ? "Pickup" : "Delivery"}</p>
              <p className="text-sm text-white/70 flex items-start gap-1.5">
                <Truck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-white/30" />
                <span>{order.shippingLabel || (isPickup ? "Pickup" : "Courier")}{!isPickup && address ? ` — ${address}` : ""}</span>
              </p>
              <p className="text-xs text-white/30">
                Placed {new Date(order.createdAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                {order.paidAt ? ` · paid ${new Date(order.paidAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
              </p>
            </div>
          </div>

          {/* Attribution + Stripe */}
          {(attribution.length > 0 || order.stripePaymentIntentId) && (
            <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-2">
              {attribution.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[10px] text-white/30 uppercase tracking-wider font-semibold mr-1">Attribution</span>
                  {attribution.map((a) => (
                    <span key={a} className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-white/50 border border-white/10">{a}</span>
                  ))}
                </div>
              )}
              {order.stripePaymentIntentId && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Stripe</span>
                  <code className="text-xs text-white/50 truncate">{order.stripePaymentIntentId}</code>
                  <button
                    onClick={() => { navigator.clipboard?.writeText(order.stripePaymentIntentId!); toast({ title: "Payment intent id copied" }); }}
                    className="w-6 h-6 flex items-center justify-center rounded hover:bg-white/5 text-white/30"
                  ><Copy className="w-3 h-3" /></button>
                </div>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-2">
            <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold">Notes</p>
            <Textarea
              value={notes ?? order.notes ?? ""}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes on this order…"
              className="premium-input text-white min-h-[70px]"
              data-testid="textarea-order-notes"
            />
            {notes != null && notes !== (order.notes ?? "") && (
              <Button onClick={() => notesMut.mutate()} disabled={notesMut.isPending} size="sm" className="bg-blue-600 hover:bg-blue-700 text-white">Save notes</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`text-xs ${muted ? "text-white/25" : "text-white/40"}`}>{label}</span>
      <span className={`text-xs ${muted ? "text-white/25" : "text-white/60"}`}>{value}</span>
    </div>
  );
}

// ── Print spec — sponsor slots + roster, monospace clarity for Dima ─────────

const SPONSOR_SLOT_LABELS: { key: keyof KitCustomisationT; label: string }[] = [
  { key: "teamLogo", label: "Team logo (chest crest)" },
  { key: "frontSponsor", label: "Front sponsor" },
  { key: "backTopSponsor", label: "Back top sponsor" },
  { key: "backBottomSponsor", label: "Back bottom sponsor" },
];

function PrintSpecPanel({ order }: { order: ShopOrderDetailT }) {
  const isPlayerPay = order.paymentMode === "player_pay";
  const specItems = order.items.filter((i) => i.customisation || (i.units && i.units.length > 0));
  if (specItems.length === 0 && !(isPlayerPay && (order.shares?.length ?? 0) > 0)) return null;

  // Roster: player_pay orders carry sizes on the shares; standard orders carry
  // one size per line item with per-shirt units.
  const roster: { name: string; number: string; size: string }[] = isPlayerPay
    ? (order.shares || []).map((s) => ({
        name: s.shirtName || s.playerName,
        number: s.shirtNumber ? `#${s.shirtNumber}` : "",
        size: s.size,
      }))
    : order.items.flatMap((i) =>
        (i.units || []).map((u) => ({
          name: u.name || "",
          number: u.number ? `#${u.number}` : "",
          size: i.size || "",
        })),
      ).filter((r) => r.name || r.number);

  const sponsorSlots = specItems.flatMap((i) =>
    SPONSOR_SLOT_LABELS
      .map(({ key, label }) => ({ label, slot: i.customisation?.[key] }))
      .filter((s) => s.slot && (s.slot.text || s.slot.logoUrl)),
  );

  return (
    <div className="rounded-xl border border-amber-400/15 bg-amber-400/[0.03] p-4 space-y-3" data-testid="panel-print-spec">
      <p className="text-[10px] text-amber-400/90 uppercase tracking-wider font-semibold flex items-center gap-1.5">
        <Printer className="w-3.5 h-3.5" /> Print spec
      </p>

      {sponsorSlots.length > 0 && (
        <div className="space-y-2">
          {sponsorSlots.map((s, i) => (
            <div key={`${s.label}-${i}`} className="flex items-center justify-between gap-3">
              <span className="text-xs text-white/40">{s.label}</span>
              {s.slot!.logoUrl ? (
                <a href={s.slot!.logoUrl} target="_blank" rel="noreferrer" title="Open full-size logo">
                  <img
                    src={s.slot!.logoUrl}
                    alt={`${s.label} logo`}
                    className="h-20 max-w-[180px] object-contain bg-white rounded-lg p-1.5 border border-white/10"
                  />
                </a>
              ) : (
                <span className="text-sm font-mono font-semibold text-white/90 text-right">{s.slot!.text}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {roster.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[13px]">
            <thead>
              <tr className="border-b border-white/10">
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold py-1.5 pr-3">#</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold py-1.5 pr-3">Name</th>
                <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-semibold py-1.5 pr-3">Number</th>
                <th className="text-right text-[10px] text-white/30 uppercase tracking-wider font-semibold py-1.5">Size</th>
              </tr>
            </thead>
            <tbody>
              {roster.map((r, i) => (
                <tr key={i} className="border-b border-white/[0.04] last:border-0">
                  <td className="py-1.5 pr-3 text-white/30">{i + 1}</td>
                  <td className="py-1.5 pr-3 text-white/90">{r.name || "—"}</td>
                  <td className="py-1.5 pr-3 text-amber-300/90">{r.number}</td>
                  <td className="py-1.5 text-right text-white/90">{r.size || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Player Pay — share progress + per-player pay links ──────────────────────

function PlayerPayPanel({ order }: { order: ShopOrderDetailT }) {
  const { toast } = useToast();
  if (order.paymentMode !== "player_pay") return null;
  const shares = order.shares || [];
  const paid = shares.filter((s) => s.status === "paid").length;
  const allPaid = shares.length > 0 && paid === shares.length;
  const pct = shares.length > 0 ? Math.round((paid / shares.length) * 100) : 0;

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3" data-testid="panel-player-pay">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-white/30 uppercase tracking-wider font-semibold flex items-center gap-1.5">
          <Users className="w-3.5 h-3.5" /> Player Pay{order.teamName ? ` — ${order.teamName}` : ""}
        </p>
        <span className={`text-xs font-semibold ${allPaid ? "text-emerald-400" : "text-amber-400"}`}>
          {paid}/{shares.length} paid
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${allPaid ? "bg-emerald-400" : "bg-amber-400"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <tbody>
            {shares.map((s) => (
              <tr key={s.id} className="border-b border-white/[0.04] last:border-0" data-testid={`share-row-${s.id}`}>
                <td className="py-2 pr-3">
                  <p className="text-sm text-white/80">{s.playerName}</p>
                  <p className="text-xs text-white/30">{s.playerEmail}</p>
                </td>
                <td className="py-2 pr-3 text-sm text-white/70 whitespace-nowrap">{formatCurrency(s.amountCents, { fromCents: true })}</td>
                <td className="py-2 pr-3">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                    s.status === "paid"
                      ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/20"
                      : "bg-amber-400/10 text-amber-400 border-amber-400/20"
                  }`}>
                    {s.status === "paid" ? "Paid" : "Awaiting"}
                  </span>
                </td>
                <td className="py-2 pr-3 text-xs text-white/30 whitespace-nowrap">
                  {s.paidAt ? new Date(s.paidAt).toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}
                </td>
                <td className="py-2 text-right">
                  {s.payUrl && (
                    <button
                      onClick={() => { navigator.clipboard?.writeText(s.payUrl!); toast({ title: "Pay link copied", description: s.playerName }); }}
                      className="w-7 h-7 inline-flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30 hover:text-white/70"
                      title={`Copy ${s.playerName}'s pay link`}
                      data-testid={`button-copy-payurl-${s.id}`}
                    ><Copy className="w-3.5 h-3.5" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══ Settings — shipping options + discount codes ═══════════════════════════

function SettingsSection({ orgId }: { orgId: number }) {
  return (
    <div className="grid lg:grid-cols-2 gap-5 items-start">
      <ShippingOptionsPanel orgId={orgId} />
      <DiscountCodesPanel orgId={orgId} />
    </div>
  );
}

function ShippingOptionsPanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<ShippingOptionT | "new" | null>(null);
  const { data: options = [] } = useQuery<ShippingOptionT[]>({
    queryKey: ["/api/admin/shop/shipping-options", { orgId }],
    queryFn: () => jget(`/api/admin/shop/shipping-options?orgId=${orgId}`),
    enabled: !!orgId,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/shipping-options", { orgId }] });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/shop/shipping-options/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Shipping option removed" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Truck className="w-4 h-4 text-blue-400" />
          <h2 className="text-base font-semibold text-white">Shipping & pickup</h2>
        </div>
        <Button onClick={() => setEditing("new")} size="sm" className="bg-white/5 hover:bg-white/10 text-white border border-white/10 gap-1.5" data-testid="button-new-shipping-option">
          <Plus className="w-3.5 h-3.5" /> Add
        </Button>
      </div>
      {options.length === 0 ? (
        <p className="text-sm text-white/25 py-4 text-center">No delivery options yet — customers can't check out without one.</p>
      ) : (
        <div className="space-y-2">
          {options.map((o) => (
            <div key={o.id} className={`flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 px-4 py-3 ${!o.active ? "opacity-50" : ""}`} data-testid={`shipping-option-${o.id}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white/80 truncate">
                  {o.label}
                  {!o.active && <span className="text-[10px] text-white/30 ml-2">(off)</span>}
                </p>
                <p className="text-xs text-white/30 truncate">{o.requiresAddress ? "Needs delivery address" : "No address needed"}{o.description ? ` · ${o.description}` : ""}</p>
              </div>
              <span className="text-sm font-semibold text-white/70 whitespace-nowrap">{o.priceCents > 0 ? formatCurrency(o.priceCents, { fromCents: true }) : "Free"}</span>
              <button onClick={() => setEditing(o)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => { if (confirm(`Remove "${o.label}"?`)) deleteMut.mutate(o.id); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      {editing !== null && (
        <ShippingOptionModal orgId={orgId} option={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function ShippingOptionModal({ orgId, option, onClose }: { orgId: number; option?: ShippingOptionT; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    label: option?.label || "",
    description: option?.description || "",
    price: centsToDollarInput(option?.priceCents ?? null),
    requiresAddress: option?.requiresAddress ?? false,
    active: option?.active ?? true,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/shipping-options", { orgId }] });
  const payload = () => ({
    organizationId: orgId,
    label: form.label,
    description: form.description,
    priceCents: dollarInputToCents(form.price),
    requiresAddress: form.requiresAddress,
    active: form.active,
  });
  const saveMut = useMutation({
    mutationFn: () => option
      ? apiRequest("PATCH", `/api/admin/shop/shipping-options/${option.id}`, payload())
      : apiRequest("POST", "/api/admin/shop/shipping-options", payload()),
    onSuccess: () => { invalidate(); toast({ title: option ? "Shipping option saved" : "Shipping option added" }); onClose(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{option ? "Edit shipping option" : "New shipping option"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Label</label>
            <Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className="premium-input text-white" placeholder="NZ Courier" data-testid="input-shipping-label" />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Description (optional)</label>
            <Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="premium-input text-white" placeholder="2–4 working days" />
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Price</label>
            <MoneyInput value={form.price} onChange={(v) => setForm((f) => ({ ...f, price: v }))} data-testid="input-shipping-price" />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-black/20 px-4 py-3">
            <div>
              <p className="text-sm text-white/70">Needs a delivery address</p>
              <p className="text-xs text-white/30">Off for pickup options</p>
            </div>
            <Switch checked={form.requiresAddress} onCheckedChange={(v) => setForm((f) => ({ ...f, requiresAddress: v }))} data-testid="switch-requires-address" />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-black/20 px-4 py-3">
            <p className="text-sm text-white/70">Active</p>
            <Switch checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={() => saveMut.mutate()} disabled={!form.label || saveMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-shipping-option">Save</Button>
        </div>
      </div>
    </div>
  );
}

function DiscountCodesPanel({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<DiscountCodeT | "new" | null>(null);
  const { data: codes = [] } = useQuery<DiscountCodeT[]>({
    queryKey: ["/api/admin/shop/discount-codes", { orgId }],
    queryFn: () => jget(`/api/admin/shop/discount-codes?orgId=${orgId}`),
    enabled: !!orgId,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/discount-codes", { orgId }] });
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/shop/discount-codes/${id}`),
    onSuccess: () => { invalidate(); toast({ title: "Discount code removed" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tag className="w-4 h-4 text-blue-400" />
          <h2 className="text-base font-semibold text-white">Discount codes</h2>
        </div>
        <Button onClick={() => setEditing("new")} size="sm" className="bg-white/5 hover:bg-white/10 text-white border border-white/10 gap-1.5" data-testid="button-new-discount-code">
          <Plus className="w-3.5 h-3.5" /> Add
        </Button>
      </div>
      {codes.length === 0 ? (
        <p className="text-sm text-white/25 py-4 text-center">No discount codes yet.</p>
      ) : (
        <div className="space-y-2">
          {codes.map((c) => (
            <div key={c.id} className={`flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 px-4 py-3 ${!c.active ? "opacity-50" : ""}`} data-testid={`discount-code-${c.id}`}>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-mono font-semibold text-white/80 truncate">{c.code}{!c.active && <span className="text-[10px] text-white/30 ml-2 font-sans">(off)</span>}</p>
                <p className="text-xs text-white/30">
                  Used {c.usedCount}{c.maxUses ? ` / ${c.maxUses}` : ""}
                  {c.endsAt ? ` · ends ${new Date(c.endsAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}` : ""}
                </p>
              </div>
              <span className="text-sm font-semibold text-white/70 whitespace-nowrap">
                {c.kind === "percent" ? `${c.value}%` : formatCurrency(c.value, { fromCents: true })} off
              </span>
              <button onClick={() => setEditing(c)} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30"><Pencil className="w-3.5 h-3.5" /></button>
              <button onClick={() => { if (confirm(`Remove code "${c.code}"?`)) deleteMut.mutate(c.id); }} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/30 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      )}
      {editing !== null && (
        <DiscountCodeModal orgId={orgId} code={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function DiscountCodeModal({ orgId, code, onClose }: { orgId: number; code?: DiscountCodeT; onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    code: code?.code || "",
    kind: code?.kind || "percent",
    percent: code && code.kind === "percent" ? String(code.value) : "",
    fixed: code && code.kind === "fixed" ? centsToDollarInput(code.value) : "",
    active: code?.active ?? true,
    startsAt: code?.startsAt ? code.startsAt.slice(0, 10) : "",
    endsAt: code?.endsAt ? code.endsAt.slice(0, 10) : "",
    maxUses: code?.maxUses ? String(code.maxUses) : "",
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/shop/discount-codes", { orgId }] });
  const payload = () => ({
    organizationId: orgId,
    code: form.code,
    kind: form.kind,
    value: form.kind === "percent" ? parseInt(form.percent) || 0 : dollarInputToCents(form.fixed),
    active: form.active,
    startsAt: form.startsAt || null,
    endsAt: form.endsAt ? `${form.endsAt}T23:59:59` : null,
    maxUses: form.maxUses ? parseInt(form.maxUses) : null,
  });
  const saveMut = useMutation({
    mutationFn: () => code
      ? apiRequest("PATCH", `/api/admin/shop/discount-codes/${code.id}`, payload())
      : apiRequest("POST", "/api/admin/shop/discount-codes", payload()),
    onSuccess: () => { invalidate(); toast({ title: code ? "Discount saved" : "Discount added" }); onClose(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const valueOk = form.kind === "percent" ? (parseInt(form.percent) || 0) > 0 : dollarInputToCents(form.fixed) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3">
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <h2 className="text-lg font-semibold text-white">{code ? "Edit discount code" : "New discount code"}</h2>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs text-white/40 mb-1 block">Code</label>
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/\s+/g, "") }))}
              className="premium-input text-white font-mono"
              placeholder="LAUNCH10"
              data-testid="input-discount-code"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/40 mb-1 block">Type</label>
              <Select value={form.kind} onValueChange={(v) => setForm((f) => ({ ...f, kind: v }))}>
                <SelectTrigger className="premium-input text-white"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">% off</SelectItem>
                  <SelectItem value="fixed">$ off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">{form.kind === "percent" ? "Percent" : "Amount"}</label>
              {form.kind === "percent" ? (
                <div className="relative">
                  <Input
                    inputMode="numeric"
                    value={form.percent}
                    onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value.replace(/[^0-9]/g, "") }))}
                    className="premium-input text-white pr-7"
                    placeholder="10"
                    data-testid="input-discount-percent"
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-white/40">%</span>
                </div>
              ) : (
                <MoneyInput value={form.fixed} onChange={(v) => setForm((f) => ({ ...f, fixed: v }))} data-testid="input-discount-fixed" />
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-white/40 mb-1 block">Starts (optional)</label>
              <DatePickerInput value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} className="premium-input text-white" />
            </div>
            <div>
              <label className="text-xs text-white/40 mb-1 block">Ends (optional)</label>
              <DatePickerInput value={form.endsAt} onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} className="premium-input text-white" />
            </div>
          </div>
          <div>
            <label className="text-xs text-white/40 mb-1 block">Max uses (optional)</label>
            <Input inputMode="numeric" value={form.maxUses} onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value.replace(/[^0-9]/g, "") }))} className="premium-input text-white" placeholder="Unlimited" />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-white/5 bg-black/20 px-4 py-3">
            <p className="text-sm text-white/70">Active</p>
            <Switch checked={form.active} onCheckedChange={(v) => setForm((f) => ({ ...f, active: v }))} />
          </div>
        </div>
        <div className="p-5 border-t border-white/5 flex gap-2 justify-end">
          <Button variant="ghost" onClick={onClose} className="text-white/40">Cancel</Button>
          <Button onClick={() => saveMut.mutate()} disabled={!form.code || !valueOk || saveMut.isPending} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="button-save-discount">Save</Button>
        </div>
      </div>
    </div>
  );
}

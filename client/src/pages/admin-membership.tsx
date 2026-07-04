import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Crown, X, Plus, Trash2, Users, DollarSign, Gift, Check, Star, CreditCard, Sparkles,
} from "lucide-react";

// ── config ──────────────────────────────────────────────────────────────────
const MEMBER_STATUS = [
  { key: "active", label: "Active", color: "#22c55e" },
  { key: "pending", label: "Pending", color: "#f59e0b" },
  { key: "lapsed", label: "Lapsed", color: "#64748b" },
  { key: "cancelled", label: "Cancelled", color: "#ef4444" },
];
const PAY_STATUS = [
  { key: "paid", label: "Paid", color: "#22c55e" },
  { key: "unpaid", label: "Unpaid", color: "#f59e0b" },
  { key: "comped", label: "Comped", color: "#3b82f6" },
];
const INTERVALS = ["monthly", "yearly", "lifetime"];
const DEL_STATUS = [
  { key: "idea", label: "Idea", color: "#64748b" },
  { key: "planned", label: "Planned", color: "#3b82f6" },
  { key: "active", label: "Active", color: "#22c55e" },
  { key: "fulfilled", label: "Fulfilled", color: "#10b981" },
];
const CADENCES = ["one_off", "monthly", "quarterly", "annual", "on_signup", "birthday"];
const cadenceLabel = (c: string | null) => (c || "").replace(/_/g, " ") || "—";
const cfg = (arr: any[], k: string) => arr.find((x) => x.key === k) || arr[0];

interface Tier { id: number; name: string; slug: string; tagline: string | null; priceCents: number; billingInterval: string; color: string | null; benefits: string[]; active: boolean; sortOrder: number; }
interface Member { id: number; name: string; email: string | null; phone: string | null; tierId: number | null; tierName: string | null; status: string; billingInterval: string | null; priceCents: number | null; paymentStatus: string; joinedAt: string | null; renewsAt: string | null; notes: string | null; }
interface Deliverable { id: number; title: string; description: string | null; tiers: string[]; cadence: string | null; status: string; owner: string | null; notes: string | null; sortOrder: number; }

const money = (c: number | null | undefined) => c == null ? "—" : `$${(c / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
const perLabel = (i: string) => i === "monthly" ? "/mo" : i === "yearly" ? "/yr" : i === "lifetime" ? " once" : "";

function Kpi({ label, value, icon, accent, sub }: { label: string; value: string; icon: React.ReactNode; accent: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-white/40 font-medium"><span style={{ color: accent }}>{icon}</span>{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-[10px] text-white/30 mt-0.5">{sub}</div>}
    </div>
  );
}
function Pill({ arr, k }: { arr: any[]; k: string }) {
  const c = cfg(arr, k);
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={{ background: `${c.color}22`, color: c.color, border: `1px solid ${c.color}55` }}>{c.label}</span>;
}

export default function AdminMembership() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [view, setView] = useState<"tiers" | "members" | "deliverables">("tiers");
  const [tierModal, setTierModal] = useState<Partial<Tier> | null>(null);
  const [memberModal, setMemberModal] = useState<Partial<Member> | null>(null);
  const [delModal, setDelModal] = useState<Partial<Deliverable> | null>(null);

  const q = (path: string) => useQuery<any[]>({
    queryKey: [`/api/admin/membership/${path}`, orgId],
    queryFn: async () => (await apiRequest("GET", `/api/admin/membership/${path}?organizationId=${orgId}`)).json(),
    enabled: !!orgId,
  });
  const { data: tiers = [], isLoading: tiersLoading } = q("tiers") as { data: Tier[]; isLoading: boolean };
  const { data: mem = [], isLoading: memLoading } = q("members") as { data: Member[]; isLoading: boolean };
  const { data: dels = [], isLoading: delLoading } = q("deliverables") as { data: Deliverable[]; isLoading: boolean };
  const inval = (path: string) => queryClient.invalidateQueries({ queryKey: [`/api/admin/membership/${path}`, orgId] });

  const kpis = useMemo(() => {
    const active = mem.filter((m) => m.status === "active");
    const arr = active.reduce((s, m) => {
      const p = m.priceCents || 0;
      return s + (m.billingInterval === "monthly" ? p * 12 : m.billingInterval === "lifetime" ? 0 : p);
    }, 0);
    return { members: mem.length, active: active.length, arr, tiers: tiers.length };
  }, [mem, tiers]);

  const tierBySlug = (slug: string) => tiers.find((t) => t.slug === slug);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto text-white">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Crown className="w-5 h-5 text-amber-400" /> Membership Program</h1>
          <p className="text-[13px] text-white/40 mt-0.5">Tiers, members and the perks we deliver — track who's in, what they get, and that we fulfil it.</p>
        </div>
      </div>
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[12px] text-amber-200/90 mb-4 flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 shrink-0" /> Placeholder scaffold — Bronze/Silver/Gold and prices are dummies to brainstorm against. No live payments are wired yet.
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
        <Kpi label="Members" value={String(kpis.members)} icon={<Users className="w-3.5 h-3.5" />} accent="#3b82f6" />
        <Kpi label="Active" value={String(kpis.active)} icon={<Check className="w-3.5 h-3.5" />} accent="#22c55e" />
        <Kpi label="Est. annual value" value={money(kpis.arr)} icon={<DollarSign className="w-3.5 h-3.5" />} accent="#C59949" sub="active × tier price" />
        <Kpi label="Tiers" value={String(kpis.tiers)} icon={<Star className="w-3.5 h-3.5" />} accent="#a78bfa" />
      </div>

      {/* view switcher */}
      <div className="flex items-center gap-1 mb-4 bg-white/[0.03] border border-white/[0.07] rounded-lg p-1 w-fit">
        {(["tiers", "members", "deliverables"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className="px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors"
            style={{ background: view === v ? "rgba(255,255,255,0.08)" : "transparent", color: view === v ? "#fff" : "rgba(255,255,255,0.5)" }}>
            {v}
          </button>
        ))}
      </div>

      {/* ── TIERS ── */}
      {view === "tiers" && (
        tiersLoading ? <div className="grid sm:grid-cols-3 gap-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-64 bg-white/[0.04] rounded-2xl" />)}</div> : (
          <div className="grid sm:grid-cols-3 gap-3">
            {tiers.map((t) => (
              <div key={t.id} onClick={() => setTierModal(t)}
                className="rounded-2xl border bg-white/[0.02] p-5 cursor-pointer hover:bg-white/[0.04] transition-colors"
                style={{ borderColor: `${t.color || "#666"}44` }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-3 h-3 rounded-full" style={{ background: t.color || "#888" }} />
                  <span className="text-[15px] font-semibold">{t.name}</span>
                </div>
                {t.tagline && <div className="text-[12px] text-white/40 mb-3">{t.tagline}</div>}
                <div className="flex items-baseline gap-1 mb-4">
                  <span className="text-2xl font-bold" style={{ color: t.color || "#fff" }}>{money(t.priceCents)}</span>
                  <span className="text-[12px] text-white/40">{perLabel(t.billingInterval)}</span>
                </div>
                <div className="space-y-1.5">
                  {(t.benefits || []).map((b, i) => (
                    <div key={i} className="flex items-start gap-2 text-[12px] text-white/70">
                      <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: t.color || "#888" }} /> {b}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <button onClick={() => setTierModal({ billingInterval: "yearly", benefits: [], color: "#64748b" })}
              className="rounded-2xl border border-dashed border-white/15 flex items-center justify-center text-white/40 hover:text-white/70 hover:border-white/30 min-h-[180px] transition-colors">
              <Plus className="w-4 h-4 mr-1.5" /> Add tier
            </button>
          </div>
        )
      )}

      {/* ── MEMBERS ── */}
      {view === "members" && (
        <div>
          <div className="flex justify-end mb-3">
            <Button onClick={() => setMemberModal({ status: "active", paymentStatus: "unpaid" })} className="bg-blue-500 hover:bg-blue-400 text-white font-semibold"><Plus className="w-4 h-4 mr-1" /> Add member</Button>
          </div>
          {memLoading ? <Skeleton className="h-40 bg-white/[0.04] rounded-xl" /> : (
            <div className="rounded-xl border border-white/[0.06] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="text-[11px] text-white/40 border-b border-white/[0.06]">
                    <th className="text-left font-medium px-3 py-2">Member</th><th className="text-left font-medium px-3 py-2">Tier</th>
                    <th className="text-left font-medium px-3 py-2">Status</th><th className="text-left font-medium px-3 py-2">Payment</th>
                    <th className="text-left font-medium px-3 py-2 hidden sm:table-cell">Joined</th>
                  </tr></thead>
                  <tbody>
                    {mem.map((m) => (
                      <tr key={m.id} onClick={() => setMemberModal(m)} className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer">
                        <td className="px-3 py-2.5"><div className="font-medium">{m.name}</div>{m.email && <div className="text-[11px] text-white/30">{m.email}</div>}</td>
                        <td className="px-3 py-2.5">{m.tierName ? <span className="text-[11px] px-2 py-0.5 rounded-full border border-white/10 text-white/70">{m.tierName}</span> : <span className="text-white/20">—</span>}</td>
                        <td className="px-3 py-2.5"><Pill arr={MEMBER_STATUS} k={m.status} /></td>
                        <td className="px-3 py-2.5"><Pill arr={PAY_STATUS} k={m.paymentStatus} /></td>
                        <td className="px-3 py-2.5 hidden sm:table-cell text-white/40">{m.joinedAt ? new Date(m.joinedAt + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—"}</td>
                      </tr>
                    ))}
                    {!mem.length && <tr><td colSpan={5} className="text-center text-white/30 py-10">No members yet — add your first, or wire the public signup later.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── DELIVERABLES ── */}
      {view === "deliverables" && (
        <div>
          <div className="flex justify-end mb-3">
            <Button onClick={() => setDelModal({ status: "idea", tiers: [], cadence: "one_off" })} className="bg-emerald-500 hover:bg-emerald-400 text-black font-semibold"><Plus className="w-4 h-4 mr-1" /> Add perk</Button>
          </div>
          {delLoading ? <Skeleton className="h-40 bg-white/[0.04] rounded-xl" /> : (
            <div className="space-y-2">
              {dels.map((d) => (
                <div key={d.id} onClick={() => setDelModal(d)} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 cursor-pointer hover:bg-white/[0.04] transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Gift className="w-4 h-4 mt-0.5 text-amber-400 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium">{d.title}</div>
                        {d.description && <div className="text-[11px] text-white/40 mt-0.5">{d.description}</div>}
                        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                          {(d.tiers || []).map((s) => { const t = tierBySlug(s); return <span key={s} className="text-[9px] font-semibold px-1.5 py-0.5 rounded capitalize" style={{ background: `${t?.color || "#666"}22`, color: t?.color || "#aaa" }}>{s}</span>; })}
                          <span className="text-[10px] text-white/30 capitalize">· {cadenceLabel(d.cadence)}</span>
                        </div>
                      </div>
                    </div>
                    <Pill arr={DEL_STATUS} k={d.status} />
                  </div>
                </div>
              ))}
              {!dels.length && <div className="text-center text-white/30 py-10">No perks yet.</div>}
            </div>
          )}
        </div>
      )}

      {tierModal && <TierModal orgId={orgId!} tier={tierModal} onClose={() => setTierModal(null)} onSaved={() => inval("tiers")} />}
      {memberModal && <MemberModal orgId={orgId!} member={memberModal} tiers={tiers} onClose={() => setMemberModal(null)} onSaved={() => inval("members")} />}
      {delModal && <DeliverableModal orgId={orgId!} del={delModal} tiers={tiers} onClose={() => setDelModal(null)} onSaved={() => inval("deliverables")} />}
    </div>
  );
}

const inputCls = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-2.5 py-2 text-[13px] text-white focus:outline-none focus:border-white/25";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><div className="text-[11px] text-white/40 font-medium mb-1">{label}</div>{children}</div>; }

function Drawer({ title, onClose, onDelete, onSave, saving, canSave = true, children }: { title: string; onClose: () => void; onDelete?: () => void; onSave: () => void; saving: boolean; canSave?: boolean; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-md h-full bg-neutral-950 border-l border-white/10 overflow-y-auto text-white">
        <div className="sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-white/10 px-5 py-4 flex items-center justify-between z-10">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
        <div className="sticky bottom-0 bg-neutral-950/95 backdrop-blur border-t border-white/10 px-5 py-3 flex justify-between gap-2">
          {onDelete ? <Button variant="ghost" onClick={onDelete} className="text-red-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-4 h-4 mr-1" /> Delete</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
            <Button onClick={onSave} disabled={saving || !canSave} className="bg-amber-500 hover:bg-amber-400 text-black font-semibold">{saving ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useSaver(path: string, id: number | undefined, orgId: number, onSaved: () => void, onClose: () => void) {
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: async (body: any) => id ? apiRequest("PATCH", `/api/admin/membership/${path}/${id}`, body) : apiRequest("POST", `/api/admin/membership/${path}`, { ...body, organizationId: orgId }),
    onSuccess: () => { onSaved(); toast({ title: "Saved" }); onClose(); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/admin/membership/${path}/${id}`),
    onSuccess: () => { onSaved(); toast({ title: "Deleted" }); onClose(); },
  });
  return { save, del };
}

function TierModal({ orgId, tier, onClose, onSaved }: { orgId: number; tier: Partial<Tier>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Tier>>({ ...tier, benefits: tier.benefits || [] });
  const set = (k: keyof Tier, v: any) => setF((p) => ({ ...p, [k]: v }));
  const { save, del } = useSaver("tiers", tier.id, orgId, onSaved, onClose);
  const benefitsText = (f.benefits || []).join("\n");
  return (
    <Drawer title={tier.id ? "Edit tier" : "New tier"} onClose={onClose} onDelete={tier.id ? () => del.mutate() : undefined}
      saving={save.isPending} canSave={!!f.name?.trim()}
      onSave={() => save.mutate({ ...f, slug: (f.slug || f.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"), priceCents: Number(f.priceCents) || 0 })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><Input value={f.name || ""} onChange={(e) => set("name", e.target.value)} placeholder="Gold" className={inputCls} /></Field>
        <Field label="Colour"><input type="color" value={f.color || "#64748b"} onChange={(e) => set("color", e.target.value)} className="w-full h-9 bg-transparent border border-white/10 rounded-lg cursor-pointer" /></Field>
      </div>
      <Field label="Tagline"><Input value={f.tagline || ""} onChange={(e) => set("tagline", e.target.value)} placeholder="The full inner-circle experience" className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price (NZD)"><Input type="number" value={f.priceCents != null ? f.priceCents / 100 : ""} onChange={(e) => set("priceCents", Math.round(Number(e.target.value) * 100))} className={inputCls} /></Field>
        <Field label="Billing"><select value={f.billingInterval || "yearly"} onChange={(e) => set("billingInterval", e.target.value)} className={inputCls}>{INTERVALS.map((i) => <option key={i} value={i} className="bg-neutral-900 capitalize">{i}</option>)}</select></Field>
      </div>
      <Field label="Benefits (one per line)"><Textarea value={benefitsText} onChange={(e) => set("benefits", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} className="min-h-[120px] bg-white/[0.03] border-white/10 text-[13px]" placeholder={"1-on-1 coaching session\nMonthly dinner with a player"} /></Field>
    </Drawer>
  );
}

function MemberModal({ orgId, member, tiers, onClose, onSaved }: { orgId: number; member: Partial<Member>; tiers: Tier[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Member>>({ ...member });
  const set = (k: keyof Member, v: any) => setF((p) => ({ ...p, [k]: v }));
  const { save, del } = useSaver("members", member.id, orgId, onSaved, onClose);
  const pickTier = (id: string) => { const t = tiers.find((x) => x.id === Number(id)); setF((p) => ({ ...p, tierId: t?.id ?? null, tierName: t?.name ?? null, billingInterval: t?.billingInterval ?? p.billingInterval, priceCents: t?.priceCents ?? p.priceCents })); };
  return (
    <Drawer title={member.id ? "Edit member" : "New member"} onClose={onClose} onDelete={member.id ? () => del.mutate() : undefined}
      saving={save.isPending} canSave={!!f.name?.trim()} onSave={() => save.mutate(f)}>
      <Field label="Name"><Input value={f.name || ""} onChange={(e) => set("name", e.target.value)} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email"><Input value={f.email || ""} onChange={(e) => set("email", e.target.value)} className={inputCls} /></Field>
        <Field label="Phone"><Input value={f.phone || ""} onChange={(e) => set("phone", e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Tier"><select value={f.tierId ?? ""} onChange={(e) => pickTier(e.target.value)} className={inputCls}><option value="" className="bg-neutral-900">—</option>{tiers.map((t) => <option key={t.id} value={t.id} className="bg-neutral-900">{t.name} — {money(t.priceCents)}{perLabel(t.billingInterval)}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status"><select value={f.status || "active"} onChange={(e) => set("status", e.target.value)} className={inputCls}>{MEMBER_STATUS.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900">{s.label}</option>)}</select></Field>
        <Field label="Payment"><select value={f.paymentStatus || "unpaid"} onChange={(e) => set("paymentStatus", e.target.value)} className={inputCls}>{PAY_STATUS.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900">{s.label}</option>)}</select></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Joined"><input type="date" value={f.joinedAt ? String(f.joinedAt).slice(0, 10) : ""} onChange={(e) => set("joinedAt", e.target.value)} className={inputCls} /></Field>
        <Field label="Renews"><input type="date" value={f.renewsAt ? String(f.renewsAt).slice(0, 10) : ""} onChange={(e) => set("renewsAt", e.target.value)} className={inputCls} /></Field>
      </div>
      <Field label="Notes"><Textarea value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} className="min-h-[56px] bg-white/[0.03] border-white/10 text-[13px]" /></Field>
    </Drawer>
  );
}

function DeliverableModal({ orgId, del: dv, tiers, onClose, onSaved }: { orgId: number; del: Partial<Deliverable>; tiers: Tier[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Partial<Deliverable>>({ ...dv, tiers: dv.tiers || [] });
  const set = (k: keyof Deliverable, v: any) => setF((p) => ({ ...p, [k]: v }));
  const { save, del } = useSaver("deliverables", dv.id, orgId, onSaved, onClose);
  const toggleTier = (slug: string) => setF((p) => ({ ...p, tiers: (p.tiers || []).includes(slug) ? (p.tiers || []).filter((s) => s !== slug) : [...(p.tiers || []), slug] }));
  const allSlugs = tiers.length ? tiers.map((t) => t.slug) : ["bronze", "silver", "gold"];
  return (
    <Drawer title={dv.id ? "Edit perk" : "New perk"} onClose={onClose} onDelete={dv.id ? () => del.mutate() : undefined}
      saving={save.isPending} canSave={!!f.title?.trim()} onSave={() => save.mutate(f)}>
      <Field label="Title"><Input value={f.title || ""} onChange={(e) => set("title", e.target.value)} className={inputCls} /></Field>
      <Field label="Description"><Textarea value={f.description || ""} onChange={(e) => set("description", e.target.value)} className="min-h-[56px] bg-white/[0.03] border-white/10 text-[13px]" /></Field>
      <Field label="Which tiers get it"><div className="flex gap-2 flex-wrap">{allSlugs.map((s) => { const on = (f.tiers || []).includes(s); const t = tiers.find((x) => x.slug === s); return <button key={s} onClick={() => toggleTier(s)} className="text-[11px] font-semibold px-2.5 py-1 rounded-full border capitalize" style={{ background: on ? `${t?.color || "#888"}22` : "transparent", color: on ? (t?.color || "#fff") : "rgba(255,255,255,0.4)", borderColor: on ? `${t?.color || "#888"}66` : "rgba(255,255,255,0.12)" }}>{s}</button>; })}</div></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cadence"><select value={f.cadence || "one_off"} onChange={(e) => set("cadence", e.target.value)} className={inputCls}>{CADENCES.map((c) => <option key={c} value={c} className="bg-neutral-900 capitalize">{c.replace(/_/g, " ")}</option>)}</select></Field>
        <Field label="Status"><select value={f.status || "idea"} onChange={(e) => set("status", e.target.value)} className={inputCls}>{DEL_STATUS.map((s) => <option key={s.key} value={s.key} className="bg-neutral-900">{s.label}</option>)}</select></Field>
      </div>
      <Field label="Notes"><Textarea value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} className="min-h-[48px] bg-white/[0.03] border-white/10 text-[13px]" /></Field>
    </Drawer>
  );
}

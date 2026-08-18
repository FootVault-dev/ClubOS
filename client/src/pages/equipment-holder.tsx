// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT — the responsible person's own page. Reached by a signed link, on a
// phone, usually standing in a gear shed.
//
// No ClubOS login. The token in the URL is an "eqh:" HMAC that carries a HOLDER
// id and is re-checked against the live row on every request — see
// server/equipment-routes.ts for why coaches deliberately do not get accounts.
//
// It does exactly three things, because a coach will do them one-handed:
//   1. shows the team's equipment list
//   2. "+ Add equipment"  — the whiteboard's own words; new gear arrives all year
//   3. the termly count, when one is open
//
// 🔴 THE COUNT BOXES START EMPTY, AND THAT IS THE WHOLE DESIGN. Pre-filling
// them with what the register already thinks you have turns the audit into a
// rubber stamp: everyone taps submit, every number confirms itself, and the
// club learns nothing. Blank also stays meaningful — a line left blank is
// recorded as NOT COUNTED rather than as zero, so getting half way down the
// list and stopping never reads as "lost everything".
//
// Uses plain `fetch` rather than the app's apiRequest: that helper carries the
// staff session and workspace headers, and this page has neither.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from "react";
import { useRoute } from "wouter";
import {
  EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS,
  EQUIPMENT_CONDITIONS, EQUIPMENT_CONDITION_LABELS,
  type EquipmentCategory, type EquipmentCondition,
} from "@shared/equipment";
import { Boxes, Plus, Check, Trash2, Loader2, AlertCircle } from "lucide-react";

interface Item {
  id: number; category: EquipmentCategory; categoryLabel: string; name: string;
  quantity: number; condition: EquipmentCondition | null; notes: string | null;
}
interface Audit {
  round: { id: number; label: string; dueOn: string | null };
  status: "submitted" | "due_soon" | "outstanding" | "overdue";
  submittedAt: string | null;
  notes: string | null;
  counts: Array<{ itemId: number; counted: number | null; condition: string | null; notes: string | null }>;
}
interface Me {
  today: string;
  holder: { id: number; teamName: string; programme: string | null; personName: string; email: string; storageLocation: string | null };
  items: Item[];
  totals: { lines: number; quantity: number };
  audit: Audit | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatNzDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const p = iso.split("-");
  if (p.length !== 3) return iso;
  const mi = Number(p[1]) - 1;
  if (mi < 0 || mi > 11) return iso;
  return `${Number(p[2])} ${MONTHS[mi]}`;
}

export default function EquipmentHolderPage() {
  const [, params] = useRoute("/equipment/:token");
  const token = params?.token ? decodeURIComponent(params.token) : "";

  const [data, setData] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const call = useCallback(
    async (path: string, method = "GET", body?: unknown) => {
      const res = await fetch(`/api/public/equipment${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Something went wrong");
      return json;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    try {
      setData(await call("/me"));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-20 text-white/40">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </Shell>
    );
  }

  if (error || !data) {
    return (
      <Shell>
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-amber-300/70" />
          <h1 className="mt-3 text-lg font-semibold text-white">We can't open this</h1>
          <p className="mt-2 text-sm text-white/50">{error}</p>
          <p className="mt-4 text-sm text-white/40">
            Email <a className="underline" href="mailto:info@cufc.co.nz">info@cufc.co.nz</a> and we'll send you a new link.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-white/35">
          <Boxes className="h-4 w-4" /> Equipment
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-white">{data.holder.teamName}</h1>
        <p className="mt-1 text-sm text-white/45">
          You're the person responsible for this team's gear, {data.holder.personName.split(" ")[0]}.
        </p>
      </header>

      {data.audit ? <AuditCard data={data} call={call} refresh={refresh} /> : null}

      <ItemList data={data} call={call} refresh={refresh} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0b0b0c] px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-lg">{children}</div>
    </div>
  );
}

// ── The termly count ─────────────────────────────────────────────────────────
function AuditCard({ data, call, refresh }: { data: Me; call: any; refresh: () => Promise<void> }) {
  const audit = data.audit!;
  // 🔴 Empty string means "not counted". It is never seeded from item.quantity —
  // see the file header. A previous submission IS restored, because that is a
  // number this person actually typed.
  const [counts, setCounts] = useState<Record<number, string>>(() => {
    const seed: Record<number, string> = {};
    for (const c of audit.counts) if (c.counted !== null && c.counted !== undefined) seed[c.itemId] = String(c.counted);
    return seed;
  });
  const [notes, setNotes] = useState(audit.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(audit.status !== "submitted");

  const filled = data.items.filter(i => (counts[i.id] ?? "").trim() !== "").length;

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      await call("/me/audit", "POST", {
        notes,
        counts: data.items.map(i => {
          const raw = (counts[i.id] ?? "").trim();
          return { itemId: i.id, counted: raw === "" ? null : Number(raw) };
        }),
      });
      await refresh();
      setOpen(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (audit.status === "submitted" && !open) {
    return (
      <div className="mb-6 rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.07] p-5">
        <div className="flex items-center gap-2 text-emerald-200">
          <Check className="h-5 w-5" />
          <span className="font-medium">{audit.round.label} count submitted</span>
        </div>
        <p className="mt-1.5 text-sm text-emerald-200/60">
          Thanks — that's you done for this term. Add anything new below as it arrives.
        </p>
        <button onClick={() => setOpen(true)} className="mt-3 text-sm text-emerald-200/80 underline">
          Change my numbers
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-2xl border border-white/12 bg-white/[0.04] p-5">
      <h2 className="text-lg font-semibold text-white">{audit.round.label} count</h2>
      <p className="mt-1 text-sm text-white/50">
        Count what you actually have right now and put the number in.
        {audit.round.dueOn ? ` Due ${formatNzDate(audit.round.dueOn)}.` : ""}
      </p>
      <p className="mt-1 text-xs text-white/30">
        Leave a box empty if you haven't counted it — that's not the same as zero, and we won't
        treat it as missing.
      </p>

      {data.items.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/40">
          Add your gear below first, then come back and count it.
        </p>
      ) : (
        <>
          <div className="mt-4 space-y-2">
            {data.items.map(i => (
              <div key={i.id} className="flex items-center gap-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-white/90">{i.name}</div>
                  <div className="text-xs text-white/30">{i.categoryLabel}</div>
                </div>
                <input
                  value={counts[i.id] ?? ""}
                  onChange={e => setCounts(c => ({ ...c, [i.id]: e.target.value.replace(/[^0-9]/g, "") }))}
                  inputMode="numeric"
                  placeholder="—"
                  aria-label={`How many ${i.name}`}
                  className="h-12 w-20 shrink-0 rounded-xl border border-white/12 bg-white/[0.04] text-center text-lg text-white placeholder:text-white/20 focus:border-white/30 focus:outline-none"
                />
              </div>
            ))}
          </div>

          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Anything we should know? Broken gear, things lent out…"
            rows={2}
            className="mt-3 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white placeholder:text-white/25 focus:border-white/25 focus:outline-none"
          />

          {err ? <p className="mt-3 text-sm text-rose-300">{err}</p> : null}

          <button
            onClick={submit}
            disabled={saving}
            className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-white text-base font-medium text-black hover:bg-white/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
            {saving ? "Sending…" : `Submit ${filled} of ${data.items.length}`}
          </button>
          {filled < data.items.length ? (
            <p className="mt-2 text-center text-xs text-white/30">
              You can submit now and come back — the blanks stay blank.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────
function ItemList({ data, call, refresh }: { data: Me; call: any; refresh: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const remove = async (id: number) => {
    setBusy(id);
    try {
      await call(`/me/items/${id}`, "DELETE");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className="text-sm font-medium text-white/80">Your equipment</h2>
          <p className="text-xs text-white/35">{data.totals.quantity} items across {data.totals.lines} lines</p>
        </div>
      </div>

      {data.items.length === 0 && !adding ? (
        <p className="rounded-xl border border-dashed border-white/12 px-4 py-8 text-center text-sm text-white/40">
          Nothing on your list yet. Add what you were given.
        </p>
      ) : (
        <div className="space-y-2">
          {data.items.map(i => (
            <div key={i.id} className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-white/90">{i.name}</div>
                <div className="text-xs text-white/35">
                  {i.categoryLabel}{i.condition ? ` · ${EQUIPMENT_CONDITION_LABELS[i.condition]}` : ""}
                </div>
              </div>
              <span className="shrink-0 text-lg text-white">{i.quantity}</span>
              <button
                onClick={() => remove(i.id)}
                disabled={busy === i.id}
                aria-label={`Remove ${i.name}`}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-white/25 hover:bg-white/8 hover:text-rose-300 disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <AddItem call={call} onDone={async () => { setAdding(false); await refresh(); }} onCancel={() => setAdding(false)} />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-white/15 text-sm font-medium text-white/80 hover:bg-white/5"
        >
          <Plus className="h-4 w-4" /> Add equipment
        </button>
      )}

      <p className="mt-6 text-center text-xs text-white/25">
        This link is just for you — please don't forward it.
      </p>
    </section>
  );
}

function AddItem({ call, onDone, onCancel }: { call: any; onDone: () => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<EquipmentCategory>("balls");
  const [quantity, setQuantity] = useState("");
  const [condition, setCondition] = useState<EquipmentCondition | "">("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await call("/me/items", "POST", {
        name,
        category,
        quantity: quantity === "" ? 0 : Number(quantity),
        condition: condition || null,
      });
      await onDone();
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  };

  const INPUT = "w-full rounded-xl border border-white/12 bg-black/20 px-3 text-sm text-white placeholder:text-white/25 focus:border-white/30 focus:outline-none";

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-white/12 bg-white/[0.04] p-4">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="What is it? e.g. Size 4 footballs"
        aria-label="Item name"
        className={`${INPUT} h-12`}
        autoFocus
      />
      <div className="flex gap-2">
        <select value={category} onChange={e => setCategory(e.target.value as EquipmentCategory)} aria-label="Category" className={`${INPUT} h-12 flex-1`}>
          {EQUIPMENT_CATEGORIES.map(c => <option key={c} value={c}>{EQUIPMENT_CATEGORY_LABELS[c]}</option>)}
        </select>
        <input
          value={quantity}
          onChange={e => setQuantity(e.target.value.replace(/[^0-9]/g, ""))}
          inputMode="numeric"
          placeholder="How many"
          aria-label="How many"
          className={`${INPUT} h-12 w-28 text-center`}
        />
      </div>
      <select value={condition} onChange={e => setCondition(e.target.value as any)} aria-label="Condition" className={`${INPUT} h-12`}>
        <option value="">Condition (optional)</option>
        {EQUIPMENT_CONDITIONS.map(c => <option key={c} value={c}>{EQUIPMENT_CONDITION_LABELS[c]}</option>)}
      </select>
      {err ? <p className="text-sm text-rose-300">{err}</p> : null}
      <div className="flex gap-2">
        <button onClick={onCancel} className="h-12 flex-1 rounded-xl border border-white/15 text-sm text-white/70 hover:bg-white/5">Cancel</button>
        <button
          onClick={save}
          disabled={!name.trim() || saving}
          className="h-12 flex-1 rounded-xl bg-white text-sm font-medium text-black hover:bg-white/90 disabled:opacity-40"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUIPMENT — the club's gear register. United Sports Group workspace, locked
// tab (see server/equipment-routes.ts).
//
// Three views over one dataset:
//   Register — every team, who is responsible, how much they hold
//   Audits   — the termly rounds and how completion is tracking
//   Board    — one round: who has submitted, who hasn't, and what moved
//
// Every status shown here is computed server-side by @shared/equipment and
// shipped down ready to render. This file colours and labels; it never decides
// whether somebody is overdue, because then there would be two answers to that
// question and they would disagree the first time a due date was edited.
//
// 🔴 The distinction this UI must never blur: a count of `null` is NOT COUNTED,
// and renders as "—", never as 0 and never as a shortfall. Somebody half way
// down a form on their phone has not lost twenty-two footballs.
//
// Dates are calendar strings, split for display rather than passed through
// `new Date()` — the invoice page shipped "18 July" on an invoice due the 17th
// exactly that way. Any "days until" maths uses `today` from the API response,
// never the browser clock.
// ─────────────────────────────────────────────────────────────────────────────

import { DatePickerInput } from "@/components/ui/date-picker-input";
import { useMemo, useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format";
import {
  Boxes, Plus, Search, Trash2, Pencil, Check, AlertTriangle, Link2, Send,
  ClipboardList, ChevronLeft, Copy, RotateCw, Users,
} from "lucide-react";
import {
  EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS,
  EQUIPMENT_CONDITIONS, EQUIPMENT_CONDITION_LABELS,
  EQUIPMENT_SOURCES, EQUIPMENT_SOURCE_LABELS,
  AUDIT_STATUS_LABELS,
  type EquipmentCategory, type EquipmentCondition, type EquipmentSource,
  type AuditStatus, type VarianceKind,
} from "@shared/equipment";

// ── Types (mirror server/equipment-routes.ts) ────────────────────────────────
interface CategoryTotal { category: EquipmentCategory; label: string; quantity: number; lines: number }
interface Progress { holders: number; submitted: number; outstanding: number; overdue: number; percent: number | null }
interface RoundShape {
  id: number; year: number; termNumber: number; label: string;
  opensOn: string | null; dueOn: string | null; status: "open" | "closed"; notes: string | null;
}
interface HolderRow {
  id: number; teamName: string; programme: string | null; personName: string; email: string;
  phone: string | null; storageLocation: string | null; status: "active" | "inactive";
  contactId: number | null; lines: number; quantity: number;
}
interface OverviewResponse {
  today: string;
  totals: { holders: number; retired: number; lines: number; quantity: number; byCategory: CategoryTotal[] };
  openRound: RoundShape | null;
  progress: Progress | null;
  outstanding: Array<{ holderId: number; teamName: string; personName: string; email: string; status: AuditStatus }>;
  holders: HolderRow[];
}
interface ItemRow {
  id: number; holderId: number; category: EquipmentCategory; categoryLabel: string; name: string;
  quantity: number; condition: EquipmentCondition | null; storageLocation: string | null;
  source: EquipmentSource; acquiredOn: string | null; addedVia: "staff" | "holder"; notes: string | null;
}
interface HolderDetailResponse {
  today: string;
  holder: HolderRow & { notes: string | null };
  link: string | null;
  items: ItemRow[];
  totals: { lines: number; quantity: number; byCategory: CategoryTotal[] };
  history: Array<{ roundId: number; label: string; dueOn: string | null; submittedAt: string | null; late: boolean | null; notes: string | null }>;
}
interface RoundsResponse { today: string; rounds: Array<RoundShape & { progress: Progress }> }
interface BoardLine {
  id: number; itemName: string; category: string; expected: number | null; counted: number | null;
  condition: string | null; notes: string | null; variance: VarianceKind; delta: number | null;
}
interface BoardRow {
  holderId: number; teamName: string; programme: string | null; personName: string; email: string; phone: string | null;
  status: AuditStatus; submittedAt: string | null; late: boolean | null; notes: string | null;
  lastRemindedAt: string | null; lines: BoardLine[]; shortLines: number; notCounted: number;
}
interface BoardResponse { today: string; round: RoundShape; progress: Progress; rows: BoardRow[] }

const OVERVIEW_KEY = ["/api/admin/equipment/overview"];
const ROUNDS_KEY = ["/api/admin/equipment/rounds"];

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Splits the ISO string rather than parsing it. A calendar date is already a
 *  day in New Zealand; `new Date("2026-09-05")` is midnight UTC and formats to
 *  the 4th here for eleven hours of every day. */
function formatNzDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11 || !d) return iso;
  return `${Number(d)} ${MONTHS_SHORT[mi]} ${y}`;
}
/** A submission is an instant, not a calendar date, so this one may go through
 *  Date — it is a timestamp we are localising, not a day we are re-deriving. */
function formatWhen(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function apiErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "Something went wrong");
  const idx = raw.indexOf(": ");
  const body = idx >= 0 ? raw.slice(idx + 2) : raw;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch { /* not JSON */ }
  return raw;
}

const STATUS_TONE: Record<AuditStatus, string> = {
  submitted: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  due_soon: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  outstanding: "bg-white/5 text-white/60 border-white/15",
  overdue: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function StatusPill({ status }: { status: AuditStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {AUDIT_STATUS_LABELS[status]}
    </span>
  );
}

/** 🔴 `not_counted` is its own visual state, deliberately grey and deliberately
 *  "—". Rendering it as 0 or as a shortfall would turn an unfinished form into
 *  an accusation. */
function VariancePill({ kind, delta }: { kind: VarianceKind; delta: number | null }) {
  if (kind === "not_counted") {
    return <span className="text-white/30" title="This line wasn't counted — that isn't the same as counting zero">—</span>;
  }
  if (kind === "match") return <span className="text-emerald-300/80">✓</span>;
  const short = kind === "short";
  return (
    <span className={short ? "text-rose-300" : "text-sky-300"}>
      {short ? "" : "+"}{delta}
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone ?? "text-white"}`}>{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-white/40">{sub}</div> : null}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════

export default function GroupEquipment() {
  const [isBoard, boardParams] = useRoute("/admin/equipment/rounds/:id");
  if (isBoard) return <RoundBoard roundId={Number(boardParams?.id)} />;
  return <EquipmentHome />;
}

// ── Home: register + audits ──────────────────────────────────────────────────
function EquipmentHome() {
  const { toast } = useToast();
  const [tab, setTab] = useState<"register" | "audits">("register");
  const [search, setSearch] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<HolderRow | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data, isLoading } = useQuery<OverviewResponse>({ queryKey: OVERVIEW_KEY });
  const holders = data?.holders ?? [];
  const today = data?.today ?? "";

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return holders
      .filter(h => showRetired || h.status === "active")
      .filter(h => !q || h.teamName.toLowerCase().includes(q) || h.personName.toLowerCase().includes(q));
  }, [holders, search, showRetired]);

  const remindMut = useMutation({
    mutationFn: ({ roundId, holderIds }: { roundId: number; holderIds?: number[] }) =>
      apiRequest("POST", `/api/admin/equipment/rounds/${roundId}/remind`, holderIds ? { holderIds } : {}),
    onSuccess: async (res: Response) => {
      const j = await res.json().catch(() => ({ sent: 0, failed: 0 }));
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      toast({
        title: j.failed ? `Sent ${j.sent}, ${j.failed} failed` : `Reminder sent to ${j.sent}`,
        description: j.failed ? "The ones that failed are logged on the round." : undefined,
        variant: j.failed ? "destructive" : undefined,
      });
    },
    onError: (e: unknown) => toast({ title: "Couldn't send", description: apiErrorMessage(e), variant: "destructive" }),
  });

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-white">
              <Boxes className="h-6 w-6 text-white/50" /> Equipment
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-white/50">
              One person responsible per team, the gear they hold, and a count every term. Each
              person keeps their own list through their own link — they don't need a ClubOS login.
            </p>
          </div>
          <button
            onClick={() => { setEditing(null); setFormOpen(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
          >
            <Plus className="h-4 w-4" /> Add team
          </button>
        </header>

        {isLoading ? (
          <div className="text-sm text-white/40">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Teams" value={formatNumber(data?.totals.holders ?? 0)} sub={data?.totals.retired ? `${data.totals.retired} retired` : undefined} />
              <Stat label="Items" value={formatNumber(data?.totals.quantity ?? 0)} sub={`${formatNumber(data?.totals.lines ?? 0)} lines`} />
              <Stat
                label="Audit"
                value={data?.progress?.percent === null || data?.progress === null || data?.progress === undefined ? "—" : `${data.progress.percent}%`}
                sub={data?.openRound ? data.openRound.label : "No audit open"}
              />
              <Stat
                label="Overdue"
                value={data?.progress ? String(data.progress.overdue) : "—"}
                tone={data?.progress?.overdue ? "text-rose-300" : undefined}
                sub={data?.openRound?.dueOn ? `Due ${formatNzDate(data.openRound.dueOn)}` : undefined}
              />
            </div>

            {/* What we hold, by kind — the figure a reorder or a grant
                application starts from. */}
            {data?.totals.byCategory.length ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                <div className="mb-3 text-xs uppercase tracking-wide text-white/40">What the club holds</div>
                <div className="flex flex-wrap gap-2">
                  {data.totals.byCategory.map(c => (
                    <span key={c.category} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white/80">
                      {c.label} <span className="ml-1 font-semibold text-white">{formatNumber(c.quantity)}</span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {data?.openRound && data.outstanding.length > 0 ? (
              <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium text-amber-200">
                      <AlertTriangle className="h-4 w-4" />
                      {data.outstanding.length} still to submit for {data.openRound.label}
                    </div>
                    <div className="mt-1 text-xs text-amber-200/60">
                      {data.outstanding.slice(0, 6).map(o => o.teamName).join(" · ")}
                      {data.outstanding.length > 6 ? ` +${data.outstanding.length - 6} more` : ""}
                    </div>
                  </div>
                  <button
                    disabled={remindMut.isPending}
                    onClick={() => remindMut.mutate({ roundId: data.openRound!.id })}
                    className="inline-flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100 hover:bg-amber-400/20 disabled:opacity-50"
                  >
                    <Send className="h-4 w-4" /> Chase everyone outstanding
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex gap-1 border-b border-white/10">
              {(["register", "audits"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-white text-white" : "text-white/45 hover:text-white/70"}`}
                >
                  {t}
                </button>
              ))}
            </div>

            {tab === "register" ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" />
                    <input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search team or person"
                      className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 pl-9 pr-3 text-sm text-white placeholder:text-white/30 focus:border-white/25 focus:outline-none"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-white/50">
                    <input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} className="accent-white" />
                    Show retired
                  </label>
                </div>

                {visible.length === 0 ? (
                  <EmptyRegister onAdd={() => { setEditing(null); setFormOpen(true); }} hasAny={holders.length > 0} />
                ) : (
                  <div className="overflow-hidden rounded-xl border border-white/10">
                    <table className="w-full text-sm">
                      <thead className="bg-white/[0.03] text-left text-xs uppercase tracking-wide text-white/40">
                        <tr>
                          <th className="px-4 py-3">Team</th>
                          <th className="px-4 py-3">Responsible</th>
                          <th className="px-4 py-3 hidden sm:table-cell">Stored</th>
                          <th className="px-4 py-3 text-right">Items</th>
                          <th className="px-4 py-3" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {visible.map(h => (
                          <tr key={h.id} className="hover:bg-white/[0.02]">
                            <td className="px-4 py-3">
                              <button onClick={() => setDetailId(h.id)} className="text-left font-medium text-white hover:underline">
                                {h.teamName}
                              </button>
                              {h.programme ? <div className="text-xs text-white/40">{h.programme}</div> : null}
                              {h.status !== "active" ? <div className="mt-0.5 text-xs text-white/30">Retired</div> : null}
                            </td>
                            <td className="px-4 py-3">
                              <div className="text-white/80">{h.personName}</div>
                              <div className="text-xs text-white/35">{h.email}</div>
                            </td>
                            <td className="px-4 py-3 hidden sm:table-cell text-white/50">{h.storageLocation ?? "—"}</td>
                            <td className="px-4 py-3 text-right">
                              <span className="text-white">{formatNumber(h.quantity)}</span>
                              <span className="ml-1 text-xs text-white/35">({h.lines})</span>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => { setEditing(h); setFormOpen(true); }} className="rounded p-1.5 text-white/40 hover:bg-white/10 hover:text-white">
                                <Pencil className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : (
              <AuditsTab today={today} />
            )}
          </>
        )}
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-lg">
          <HolderForm holder={editing} onDone={() => setFormOpen(false)} />
        </DialogContent>
      </Dialog>

      <Dialog open={detailId !== null} onOpenChange={o => !o && setDetailId(null)}>
        <DialogContent className="max-w-3xl">
          {detailId !== null ? <HolderDetail id={detailId} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyRegister({ onAdd, hasAny }: { onAdd: () => void; hasAny: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center">
      <Users className="mx-auto h-8 w-8 text-white/20" />
      <h3 className="mt-3 text-white">{hasAny ? "Nothing matches that" : "No teams yet"}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-white/45">
        {hasAny
          ? "Try a different search, or tick “Show retired”."
          : "Add a team and the person responsible for its gear. They'll get their own link to build the list — nobody here has to type it in for them."}
      </p>
      {!hasAny ? (
        <button onClick={onAdd} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90">
          <Plus className="h-4 w-4" /> Add the first team
        </button>
      ) : null}
    </div>
  );
}

// ── Holder create/edit ───────────────────────────────────────────────────────
function HolderForm({ holder, onDone }: { holder: HolderRow | null; onDone: () => void }) {
  const { toast } = useToast();
  const [teamName, setTeamName] = useState(holder?.teamName ?? "");
  const [programme, setProgramme] = useState(holder?.programme ?? "");
  const [personName, setPersonName] = useState(holder?.personName ?? "");
  const [email, setEmail] = useState(holder?.email ?? "");
  const [phone, setPhone] = useState(holder?.phone ?? "");
  const [storageLocation, setStorage] = useState(holder?.storageLocation ?? "");
  const [status, setStatus] = useState<"active" | "inactive">(holder?.status ?? "active");

  const done = () => {
    queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    onDone();
  };
  const body = () => ({ teamName, programme, personName, email, phone, storageLocation, status });

  const createMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/equipment/holders", body()),
    onSuccess: () => { done(); toast({ title: "Team added", description: "Open the team to copy their link." }); },
    onError: (e: unknown) => toast({ title: "Couldn't add", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const updateMut = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/equipment/holders/${holder!.id}`, body()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/equipment/holders/${holder!.id}`] });
      done();
      toast({ title: "Saved" });
    },
    onError: (e: unknown) => toast({ title: "Couldn't save", description: apiErrorMessage(e), variant: "destructive" }),
  });

  const pending = createMut.isPending || updateMut.isPending;
  const valid = teamName.trim() && personName.trim() && email.trim();

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-white">{holder ? "Edit team" : "Add team"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Team" required><input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="U9 Sparrows" className={INPUT} /></Field>
        <Field label="Programme"><input value={programme} onChange={e => setProgramme(e.target.value)} placeholder="Academy" className={INPUT} /></Field>
        <Field label="Person responsible" required><input value={personName} onChange={e => setPersonName(e.target.value)} placeholder="Sam Peterson" className={INPUT} /></Field>
        <Field label="Email" required hint="Their audit link is sent here">
          <input value={email} onChange={e => setEmail(e.target.value)} type="email" className={INPUT} />
        </Field>
        <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} className={INPUT} /></Field>
        <Field label="Where it's stored"><input value={storageLocation} onChange={e => setStorage(e.target.value)} placeholder="Container 2" className={INPUT} /></Field>
      </div>
      {holder ? (
        <Field label="Status" hint="Retiring keeps their history and frees the team for a replacement">
          <select value={status} onChange={e => setStatus(e.target.value as any)} className={INPUT}>
            <option value="active">Active</option>
            <option value="inactive">Retired</option>
          </select>
        </Field>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onDone} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5">Cancel</button>
        <button
          disabled={!valid || pending}
          onClick={() => (holder ? updateMut.mutate() : createMut.mutate())}
          className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90 disabled:opacity-40"
        >
          {pending ? "Saving…" : holder ? "Save" : "Add team"}
        </button>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder:text-white/25 focus:border-white/25 focus:outline-none";

function Field({ label, children, required, hint }: { label: string; children: React.ReactNode; required?: boolean; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-white/40">
        {label}{required ? <span className="ml-0.5 text-rose-300">*</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-white/30">{hint}</span> : null}
    </label>
  );
}

// ── Holder detail ────────────────────────────────────────────────────────────
function HolderDetail({ id }: { id: number }) {
  const { toast } = useToast();
  const key = [`/api/admin/equipment/holders/${id}`];
  const { data, isLoading } = useQuery<HolderDetailResponse>({ queryKey: key });
  const [adding, setAdding] = useState(false);

  const rotateMut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/equipment/holders/${id}/rotate-link`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: key }); toast({ title: "New link created", description: "The old one stops working immediately." }); },
    onError: (e: unknown) => toast({ title: "Couldn't rotate", description: apiErrorMessage(e), variant: "destructive" }),
  });
  const deleteItemMut = useMutation({
    mutationFn: (itemId: number) => apiRequest("DELETE", `/api/admin/equipment/holders/${id}/items/${itemId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: key }); queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY }); },
    onError: (e: unknown) => toast({ title: "Couldn't remove", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading || !data) return <div className="p-4 text-sm text-white/40">Loading…</div>;

  const copy = async () => {
    if (!data.link) return;
    try {
      await navigator.clipboard.writeText(data.link);
      toast({ title: "Link copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Select and copy it by hand.", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-white">{data.holder.teamName}</h2>
        <p className="text-sm text-white/50">
          {data.holder.personName} · {data.holder.email}{data.holder.phone ? ` · ${data.holder.phone}` : ""}
        </p>
      </div>

      {data.link ? (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-white/40">
            <Link2 className="h-3.5 w-3.5" /> Their link
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 min-w-[200px] truncate rounded bg-black/40 px-2 py-1.5 text-xs text-white/60">{data.link}</code>
            <button onClick={copy} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5">
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <button onClick={() => rotateMut.mutate()} disabled={rotateMut.isPending} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50">
              <RotateCw className="h-3.5 w-3.5" /> New link
            </button>
          </div>
          <p className="mt-2 text-xs text-white/30">
            Send this to {data.holder.personName.split(" ")[0]} — it opens their list on any phone, no login needed.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm text-white/40">
          Retired — their link no longer works. Their history below is kept.
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-white/40">
            Equipment · {formatNumber(data.totals.quantity)} items across {data.totals.lines} lines
          </div>
          <button onClick={() => setAdding(v => !v)} className="inline-flex items-center gap-1.5 text-xs text-white/60 hover:text-white">
            <Plus className="h-3.5 w-3.5" /> Add on their behalf
          </button>
        </div>
        {adding ? <StaffAddItem holderId={id} onDone={() => setAdding(false)} /> : null}
        {data.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/10 px-4 py-6 text-center text-sm text-white/35">
            Nothing on the list yet. They add it themselves from their link.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-white/10">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-white/5">
                {data.items.map(i => (
                  <tr key={i.id} className="hover:bg-white/[0.02]">
                    <td className="px-3 py-2">
                      <div className="text-white/85">{i.name}</div>
                      <div className="text-xs text-white/35">
                        {i.categoryLabel}
                        {i.condition ? ` · ${EQUIPMENT_CONDITION_LABELS[i.condition]}` : ""}
                        {i.source !== "unknown" ? ` · ${EQUIPMENT_SOURCE_LABELS[i.source]}` : ""}
                        {i.addedVia === "holder" ? " · added by them" : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-white">{formatNumber(i.quantity)}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => deleteItemMut.mutate(i.id)} className="rounded p-1 text-white/25 hover:bg-white/10 hover:text-rose-300">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wide text-white/40">Audit history</div>
        {data.history.length === 0 ? (
          <p className="text-sm text-white/35">No audits submitted yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.history.map(h => (
              <li key={h.roundId} className="flex items-center justify-between rounded-lg border border-white/10 px-3 py-2 text-sm">
                <span className="text-white/80">{h.label}</span>
                <span className="text-white/45">
                  {h.submittedAt ? formatWhen(h.submittedAt) : "Not submitted"}
                  {h.late === true ? <span className="ml-2 text-amber-300/70">late</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StaffAddItem({ holderId, onDone }: { holderId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [category, setCategory] = useState<EquipmentCategory>("balls");
  const [quantity, setQuantity] = useState("1");
  const mut = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/equipment/holders/${holderId}/items`, { name, category, quantity: Number(quantity) || 0 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/admin/equipment/holders/${holderId}`] });
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      setName(""); setQuantity("1"); onDone();
    },
    onError: (e: unknown) => toast({ title: "Couldn't add", description: apiErrorMessage(e), variant: "destructive" }),
  });
  return (
    <div className="mb-3 flex flex-wrap gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Size 4 footballs" className={`${INPUT} flex-1 min-w-[160px]`} />
      <select value={category} onChange={e => setCategory(e.target.value as EquipmentCategory)} className={`${INPUT} w-auto`}>
        {EQUIPMENT_CATEGORIES.map(c => <option key={c} value={c}>{EQUIPMENT_CATEGORY_LABELS[c]}</option>)}
      </select>
      <input value={quantity} onChange={e => setQuantity(e.target.value)} inputMode="numeric" className={`${INPUT} w-20`} />
      <button disabled={!name.trim() || mut.isPending} onClick={() => mut.mutate()} className="rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-40">Add</button>
    </div>
  );
}

// ── Audits tab ───────────────────────────────────────────────────────────────
function AuditsTab({ today }: { today: string }) {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<RoundsResponse>({ queryKey: ROUNDS_KEY });
  const [open, setOpen] = useState(false);

  const nowYear = Number(today.slice(0, 4)) || new Date().getFullYear();
  const [year, setYear] = useState(String(nowYear));
  const [termNumber, setTerm] = useState("3");
  const [dueOn, setDueOn] = useState("");

  const createMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/equipment/rounds", {
      year: Number(year), termNumber: Number(termNumber), dueOn: dueOn || null,
      label: `Term ${termNumber} ${year}`,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROUNDS_KEY });
      queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
      setOpen(false);
      toast({ title: "Audit opened", description: "Send the reminders when you're ready." });
    },
    onError: (e: unknown) => toast({ title: "Couldn't open", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading) return <div className="text-sm text-white/40">Loading…</div>;
  const rounds = data?.rounds ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-white/45">
          Every term, each person confirms what they actually have. Nothing sends automatically —
          you open the audit, then chase.
        </p>
        <button onClick={() => setOpen(true)} className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5">
          <Plus className="h-4 w-4" /> Open an audit
        </button>
      </div>

      {rounds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-12 text-center">
          <ClipboardList className="mx-auto h-8 w-8 text-white/20" />
          <h3 className="mt-3 text-white">No audits yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-white/45">
            Open one for the current term and everyone responsible gets asked to count what they hold.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rounds.map(r => (
            <Link
              key={r.id}
              href={`/admin/equipment/rounds/${r.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3 hover:bg-white/[0.04]"
            >
                <div>
                  <div className="font-medium text-white">
                    {r.label}
                    {r.status === "closed" ? <span className="ml-2 text-xs text-white/35">closed</span> : null}
                  </div>
                  <div className="text-xs text-white/40">Due {formatNzDate(r.dueOn)}</div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-sm text-white">
                      {r.progress.submitted}/{r.progress.holders}
                      <span className="ml-1 text-xs text-white/35">submitted</span>
                    </div>
                    {r.progress.overdue > 0 ? <div className="text-xs text-rose-300">{r.progress.overdue} overdue</div> : null}
                  </div>
                  <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full bg-emerald-400/70" style={{ width: `${r.progress.percent ?? 0}%` }} />
                  </div>
                </div>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-white">Open an equipment audit</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Year"><input value={year} onChange={e => setYear(e.target.value)} inputMode="numeric" className={INPUT} /></Field>
              <Field label="Term">
                <select value={termNumber} onChange={e => setTerm(e.target.value)} className={INPUT}>
                  {[1, 2, 3, 4].map(t => <option key={t} value={t}>Term {t}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Due by" hint="Leave blank if there's no deadline yet">
              <DatePickerInput value={dueOn} onChange={e => setDueOn(e.target.value)} className={INPUT} />
            </Field>
            <div className="flex justify-end gap-2">
              <button onClick={() => setOpen(false)} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:bg-white/5">Cancel</button>
              <button disabled={createMut.isPending} onClick={() => createMut.mutate()} className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-40">Open</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Round board ──────────────────────────────────────────────────────────────
function RoundBoard({ roundId }: { roundId: number }) {
  const { toast } = useToast();
  const key = [`/api/admin/equipment/rounds/${roundId}`];
  const { data, isLoading } = useQuery<BoardResponse>({ queryKey: key });
  const [expanded, setExpanded] = useState<number | null>(null);

  const remindMut = useMutation({
    mutationFn: (holderIds?: number[]) => apiRequest("POST", `/api/admin/equipment/rounds/${roundId}/remind`, holderIds ? { holderIds } : {}),
    onSuccess: async (res: Response) => {
      const j = await res.json().catch(() => ({ sent: 0, failed: 0 }));
      queryClient.invalidateQueries({ queryKey: key });
      toast({ title: j.failed ? `Sent ${j.sent}, ${j.failed} failed` : `Reminder sent to ${j.sent}`, variant: j.failed ? "destructive" : undefined });
    },
    onError: (e: unknown) => toast({ title: "Couldn't send", description: apiErrorMessage(e), variant: "destructive" }),
  });

  if (isLoading || !data) return <div className="p-8 text-sm text-white/40">Loading…</div>;

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <Link href="/admin/equipment" className="inline-flex items-center gap-1.5 text-sm text-white/45 hover:text-white">
          <ChevronLeft className="h-4 w-4" /> Equipment
        </Link>

        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-white">{data.round.label}</h1>
            <p className="mt-1 text-sm text-white/45">
              Due {formatNzDate(data.round.dueOn)} · {data.progress.submitted} of {data.progress.holders} submitted
              {data.progress.overdue ? <span className="text-rose-300"> · {data.progress.overdue} overdue</span> : null}
            </p>
          </div>
          {data.progress.outstanding > 0 && data.round.status === "open" ? (
            <button
              disabled={remindMut.isPending}
              onClick={() => remindMut.mutate(undefined)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
            >
              <Send className="h-4 w-4" /> Chase all {data.progress.outstanding}
            </button>
          ) : null}
        </header>

        <div className="space-y-2">
          {data.rows.map(row => (
            <div key={row.holderId} className="rounded-xl border border-white/10 bg-white/[0.02]">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{row.teamName}</span>
                    <StatusPill status={row.status} />
                    {row.late ? <span className="text-xs text-amber-300/70">late</span> : null}
                  </div>
                  <div className="mt-0.5 text-xs text-white/40">
                    {row.personName}
                    {row.submittedAt ? ` · submitted ${formatWhen(row.submittedAt)}` : ""}
                    {row.lastRemindedAt && !row.submittedAt ? ` · chased ${formatWhen(row.lastRemindedAt)}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {row.status === "submitted" ? (
                    <>
                      {row.shortLines > 0 ? (
                        <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs text-rose-300">
                          {row.shortLines} short
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-300/70"><Check className="h-3.5 w-3.5" /> all accounted for</span>
                      )}
                      {row.notCounted > 0 ? (
                        <span className="text-xs text-white/35" title="Lines they left blank — not the same as zero">
                          {row.notCounted} not counted
                        </span>
                      ) : null}
                      <button onClick={() => setExpanded(expanded === row.holderId ? null : row.holderId)} className="text-xs text-white/50 hover:text-white">
                        {expanded === row.holderId ? "Hide" : "View"}
                      </button>
                    </>
                  ) : data.round.status === "open" ? (
                    <button
                      disabled={remindMut.isPending}
                      onClick={() => remindMut.mutate([row.holderId])}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/5 disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" /> Chase
                    </button>
                  ) : null}
                </div>
              </div>

              {expanded === row.holderId && row.lines.length > 0 ? (
                <div className="border-t border-white/5 px-4 py-3">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-white/35">
                      <tr>
                        <th className="pb-2">Item</th>
                        <th className="pb-2 text-right">Was</th>
                        <th className="pb-2 text-right">Counted</th>
                        <th className="pb-2 text-right">Change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {row.lines.map(l => (
                        <tr key={l.id}>
                          <td className="py-1.5 text-white/80">{l.itemName}</td>
                          <td className="py-1.5 text-right text-white/45">{l.expected ?? "—"}</td>
                          <td className="py-1.5 text-right text-white/80">{l.counted === null ? <span className="text-white/25">—</span> : l.counted}</td>
                          <td className="py-1.5 text-right"><VariancePill kind={l.variance} delta={l.delta} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {row.notes ? <p className="mt-2 text-xs text-white/40">“{row.notes}”</p> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

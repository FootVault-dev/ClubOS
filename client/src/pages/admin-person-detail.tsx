// One page for one person, whichever shape they are stored in.
//
// Replaces the split ParentDetailPage / PlayerDetailPage, which each read a
// single link mechanism and so could not show an academy child's parent, or a
// parent's academy children, at all. Everything here comes from one server-side
// resolver, so the child's page and the parent's page can never disagree.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useRoute, Link, useLocation } from "wouter";
import {
  ArrowLeft, User, Users, Mail, Phone, Calendar, AlertTriangle, MapPin, School, Pencil,
  Link2, Unlink, Plus, Search, X, Copy,
} from "lucide-react";
import { useBackTo } from "@/lib/back-to";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
import { apiRequest, queryClient, workspaceFetch } from "@/lib/queryClient";
import { RELATIONSHIP_OPTIONS, ageFromDob } from "@shared/family";

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });
}

// ── Programme & payment history ──────────────────────────────────────────────
// The accounts view: what a person signed up for, and what was actually paid.
// See server/person-history.ts for the money rules — most importantly that a
// missing payment is NEVER rendered as "unpaid", because payments and term
// registrations only agree 58% of the time and the club would be accusing
// families who did pay.

const SOURCE_LABEL: Record<string, string> = {
  friendly_manager: "Friendly Manager",
  clubos: "ClubOS",
  camp: "Holiday camp",
};

function StatPill({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-white/[0.03] border border-blue-500/[0.08] px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-white/30">{label}</div>
      <div className="text-[15px] font-semibold text-white/90 mt-0.5">{value}</div>
      {hint && <div className="text-[10px] text-white/25 mt-0.5">{hint}</div>}
    </div>
  );
}

function HistorySummary({ totals, household }: { totals: any; household?: any }) {
  const t = household?.totals || totals;
  if (!t) return null;
  const span = t.firstActivity && t.lastActivity && t.firstActivity !== t.lastActivity
    ? `${t.firstActivity.slice(0, 4)}–${t.lastActivity.slice(0, 4)}`
    : t.firstActivity?.slice(0, 4) || "—";
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      <StatPill
        label={household ? "Household paid" : "Total paid"}
        value={formatCurrency(t.paidCents, { fromCents: true })}
        hint={t.refundedCents > 0 ? `${formatCurrency(t.refundedCents, { fromCents: true })} refunded` : undefined}
      />
      <StatPill label="Terms" value={String(t.termCount)} hint={`${t.programmeCount} sign-ups`} />
      <StatPill label="Payments" value={String(t.paymentCount)} />
      <StatPill label="Active" value={span} />
    </div>
  );
}

function ProgrammeRow({ e }: { e: any }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b border-blue-500/[0.04] last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] text-white/85 truncate">
          {e.personName && <span className="text-emerald-300/60">{e.personName} · </span>}
          {e.programme}
        </div>
        <div className="text-[11px] text-white/35 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {e.termLabel && <span>{e.termLabel}</span>}
          {!e.termLabel && e.registeredAt && <span>{formatDate(e.registeredAt)}</span>}
          <span className="text-white/20">{SOURCE_LABEL[e.source] || e.source}</span>
          {e.status && <span className="text-white/40 capitalize">{e.status.replace(/_/g, " ")}</span>}
        </div>
        {e.sharedBooking && (
          // Never split across siblings — there is no per-child price to split by.
          <div className="text-[10.5px] text-amber-300/50 mt-1">
            Part of one booking covering {e.sharedBooking.childCount} children
            {e.sharedBooking.totalCents !== null
              ? ` — ${formatCurrency(e.sharedBooking.totalCents, { fromCents: true })} total`
              : ""}
          </div>
        )}
      </div>
      <div className="text-right flex-shrink-0">
        {e.chargedCents !== null && !e.sharedBooking && (
          <div className="text-[13px] text-white/70">{formatCurrency(e.chargedCents, { fromCents: true })}</div>
        )}
        {e.matchedPaymentCents !== null && e.matchedPaymentCents > 0 && (
          <div className="text-[10.5px] text-emerald-400/60">
            {formatCurrency(e.matchedPaymentCents, { fromCents: true })} paid this term
          </div>
        )}
        {e.refundedCents > 0 && (
          <div className="text-[10.5px] text-rose-300/60">
            −{formatCurrency(e.refundedCents, { fromCents: true })} refunded
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentRow({ e }: { e: any }) {
  const refund = e.amountCents < 0;
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-blue-500/[0.04] last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] text-white/85 truncate">
          {e.personName && <span className="text-emerald-300/60">{e.personName} · </span>}
          {e.description || e.termLabel || "Payment"}
        </div>
        <div className="text-[11px] text-white/35 mt-0.5 flex flex-wrap items-center gap-x-2">
          <span>{e.paidOn ? formatDate(e.paidOn) : "Date not recorded"}</span>
          {e.method && <span className="text-white/25 capitalize">{e.method.replace(/_/g, " ")}</span>}
        </div>
      </div>
      <div className={`text-[13px] font-medium flex-shrink-0 ${refund ? "text-rose-300/80" : "text-emerald-400/80"}`}>
        {refund ? "−" : ""}{formatCurrency(Math.abs(e.amountCents), { fromCents: true })}
      </div>
    </div>
  );
}

function HistorySection({ history, household, title, emptyNote }: {
  history: any; household?: any; title: string; emptyNote: string;
}) {
  const [tab, setTab] = useState<"programmes" | "payments">("programmes");
  // On a parent, read the HOUSEHOLD lists. A guardian almost never has a
  // registration of their own, so showing their own rows under household totals
  // printed "$320.00 paid" directly above "No programmes recorded".
  const src = household || history;
  const programmes: any[] = src?.programmes || [];
  const payments: any[] = src?.payments || [];
  const hasAny = programmes.length > 0 || payments.length > 0;

  return (
    <Card title={title}>
      {!hasAny ? (
        <p className="text-white/30 text-[13px] py-3">{emptyNote}</p>
      ) : (
        <>
          <HistorySummary totals={history?.totals} household={household} />
          <div className="flex gap-1.5 mb-1">
            {(["programmes", "payments"] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                data-testid={`tab-history-${t}`}
                className={`px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
                  tab === t
                    ? "bg-blue-500/15 text-white/90 border border-blue-500/20"
                    : "bg-white/[0.03] text-white/40 border border-transparent hover:text-white/70"
                }`}
              >
                {t === "programmes" ? `Programmes (${programmes.length})` : `Payments (${payments.length})`}
              </button>
            ))}
          </div>
          <div className="mt-2">
            {tab === "programmes" ? (
              programmes.length
                ? programmes.map(e => <ProgrammeRow key={e.key} e={e} />)
                : <p className="text-white/30 text-[13px] py-3">No programmes recorded.</p>
            ) : payments.length
                ? payments.map(e => <PaymentRow key={e.key} e={e} />)
                : <p className="text-white/30 text-[13px] py-3">No payments recorded against this person.</p>}
          </div>
          {tab === "payments" && payments.length > 0 && (
            <p className="text-[10.5px] text-white/25 mt-3 leading-relaxed">
              Every payment on file, from Friendly Manager and ClubOS. A programme with no payment
              beside it means none is recorded against that term — not that it went unpaid.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function DetailRow({ label, value, icon: Icon }: { label: string; value: string | null | undefined; icon?: any }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-blue-500/[0.04]">
      {Icon && <Icon className="w-3.5 h-3.5 text-white/20 mt-0.5 flex-shrink-0" />}
      <div className="min-w-0">
        <p className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">{label}</p>
        <p className="text-[13px] text-white/70 mt-0.5 break-words">{value || "—"}</p>
      </div>
    </div>
  );
}

function Card({ title, count, action, onEdit, children }: { title: string; count?: number; action?: React.ReactNode; onEdit?: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
      <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06] flex items-center justify-between gap-2">
        <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">
          {title}{typeof count === "number" ? ` (${count})` : ""}
        </span>
        {action}
        {onEdit && (
          <button
            onClick={onEdit}
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
            data-testid="button-edit-details"
          >
            <Pencil className="w-3 h-3" />Edit
          </button>
        )}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// What a registration is worth. Prefer total_cents: the camp checkout never
// writes amount_paid, so trusting it alone prints $0.00 on a confirmed booking.
function regValue(r: any): number {
  const paid = Number(r.amountPaid || 0);
  if (paid > 0) return paid;
  return r.totalCents ? r.totalCents / 100 : 0;
}

const STATUS_STYLE: Record<string, string> = {
  confirmed: "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8",
  completed: "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8",
  paid: "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8",
  pending: "text-amber-400/70 border-amber-500/20 bg-amber-500/8",
  cancelled: "text-white/35 border-white/10 bg-white/[0.04]",
};

function ProgrammeBadge({ name, status }: { name: string; status: string }) {
  return (
    <Badge
      variant="outline"
      className={`text-[10px] font-normal normal-case ${STATUS_STYLE[status] || "text-white/40 border-white/10 bg-white/[0.04]"}`}
    >
      {name}
      <span className="opacity-50 ml-1.5">· {status}</span>
    </Badge>
  );
}

// ── Link a parent ────────────────────────────────────────────────────────────
// Guardian-first is the sequence every comparable product uses: find the adult,
// then attach the child to them. Search is server-side and typo-tolerant.
function LinkDialog({ personKey, mode, onClose }: { personKey: string; mode: "guardian" | "child"; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [relationship, setRelationship] = useState<string>("Parent");
  const [error, setError] = useState<string | null>(null);
  const linkingGuardian = mode === "guardian";

  const { data, isFetching } = useQuery<any>({
    queryKey: ["/api/admin/people", "link-search", mode, q],
    queryFn: async () => {
      const res = await workspaceFetch(
        `/api/admin/people?filter=${linkingGuardian ? "parents" : "players"}&limit=8&q=${encodeURIComponent(q)}`,
      );
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: q.trim().length >= 2,
  });

  // One endpoint, both directions: the link always hangs off the CHILD, so
  // linking a child to this parent just swaps which key is the subject.
  const link = useMutation({
    mutationFn: (otherKey: string) => {
      const childKey = linkingGuardian ? personKey : otherKey;
      const guardianKey = linkingGuardian ? otherKey : personKey;
      return apiRequest("POST", `/api/admin/people/${childKey}/guardians`, { guardianKey, relationship });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/people", personKey] });
      onClose();
    },
    onError: (e: any) => setError(e?.message || "Could not link"),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-md bg-[#0b1120] border border-blue-500/[0.12] rounded-t-2xl sm:rounded-2xl max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-blue-500/[0.08] flex items-center justify-between sticky top-0 bg-[#0b1120]">
          <span className="text-[13px] font-semibold text-white/80">{linkingGuardian ? "Link a parent / guardian" : "Link a child"}</span>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-white/[0.06] flex items-center justify-center" aria-label="Close">
            <X className="w-4 h-4 text-white/40" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">Relationship</label>
            <select
              value={relationship}
              onChange={e => setRelationship(e.target.value)}
              className="w-full mt-1 bg-white/[0.04] border border-blue-500/[0.1] rounded-lg px-3 py-2.5 text-[13px] text-white/80 min-h-[44px]"
            >
              {RELATIONSHIP_OPTIONS.map(o => <option key={o} value={o} className="bg-[#0b1120]">{o}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-white/25 uppercase tracking-wider font-semibold">{linkingGuardian ? "Find the parent" : "Find the child"}</label>
            <div className="relative mt-1">
              <Search className="w-4 h-4 text-white/20 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                autoFocus
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder={linkingGuardian ? "Name, email or phone" : "Child's name"}
                className="w-full bg-white/[0.04] border border-blue-500/[0.1] rounded-lg pl-9 pr-3 py-2.5 text-[13px] text-white/80 placeholder:text-white/20 min-h-[44px]"
              />
            </div>
          </div>

          {error && <p className="text-[12px] text-red-400/80">{error}</p>}

          <div className="space-y-1.5">
            {q.trim().length < 2 && <p className="text-[12px] text-white/25 py-2">Type at least two letters.</p>}
            {isFetching && <p className="text-[12px] text-white/25 py-2">Searching…</p>}
            {!isFetching && q.trim().length >= 2 && (data?.people || []).length === 0 && (
              <p className="text-[12px] text-white/25 py-2">Nobody found. Check the spelling, or they may not have a record yet.</p>
            )}
            {(data?.people || []).map((p: any) => (
              <button
                key={p.key}
                onClick={() => { setError(null); link.mutate(p.key); }}
                disabled={link.isPending}
                className="w-full text-left px-3 py-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-blue-500/[0.06] transition-colors min-h-[44px] disabled:opacity-50"
              >
                <p className="text-[13px] text-white/80">{p.firstName} {p.lastName}</p>
                <p className="text-[11px] text-white/30">{p.email || p.phone || "No contact details"}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Child row ────────────────────────────────────────────────────────────────
/** The distinct programmes a child appears under, newest first, capped. */
function historyBadges(history: any): string[] {
  const seen: string[] = [];
  for (const p of history?.programmes || []) {
    if (p.programme && !seen.includes(p.programme)) seen.push(p.programme);
    if (seen.length >= 3) break;
  }
  return seen;
}

function ChildRow({ child, today, onOpen }: { child: any; today: string; onOpen: (key: string) => void }) {
  const age = ageFromDob(child.dateOfBirth, today);
  const hasMedical = child.allergies || child.medicalNotes || child.epiPen;
  const records: any[] = child.records || [];
  const extra = Math.max(records.length - 1, 0);

  return (
    <button
      onClick={() => onOpen(child.key)}
      className="w-full text-left px-3 py-3 rounded-lg border bg-white/[0.03] border-blue-500/[0.06] hover:bg-white/[0.07] transition-colors min-h-[44px]"
      data-testid={`row-child-${child.key}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-emerald-500/10 border border-emerald-500/15">
          <span className="text-[11px] font-bold text-emerald-400/70">
            {(child.firstName?.[0] || "")}{(child.lastName?.[0] || "")}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] text-white/80">{child.firstName} {child.lastName}</span>
            {age !== null && <span className="text-[11px] text-white/30">{age}y</span>}
            {hasMedical && <AlertTriangle className="w-3.5 h-3.5 text-amber-400/60" />}
          </div>

          {/* The whole point of the rebuild: which programmes this child is on.
              Pooled across every record the child has, so a camp booking and a
              term enrolment appear on the same line. */}
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {child.registrations.map((r: any) => (
              <ProgrammeBadge key={r.id} name={r.programName} status={r.status} />
            ))}
            {/* A child with no LIVE registration usually still has years of
                Friendly Manager history. Reading only `registrations` is what
                printed "No programmes" under a child with two terms and a $160
                card payment on file. */}
            {child.registrations.length === 0 && historyBadges(child.history).map((label: string) => (
              <span
                key={label}
                className="text-[10.5px] px-2 py-0.5 rounded-md bg-white/[0.05] border border-blue-500/[0.08] text-white/50"
              >
                {label}
              </span>
            ))}
            {child.registrations.length === 0 && !child.history?.programmes?.length && (
              <span className="text-[11px] text-white/25">No programmes</span>
            )}
          </div>

          {(child.history?.totals?.termCount > 0 || child.history?.totals?.paidCents > 0) && (
            <p className="text-[11px] text-white/35 mt-1.5">
              {child.history.totals.termCount > 0 && `${child.history.totals.termCount} term${child.history.totals.termCount === 1 ? "" : "s"}`}
              {child.history.totals.termCount > 0 && child.history.totals.paidCents > 0 && " · "}
              {child.history.totals.paidCents > 0 && `${formatCurrency(child.history.totals.paidCents, { fromCents: true })} paid`}
              {child.history.totals.firstActivity && ` · since ${child.history.totals.firstActivity.slice(0, 4)}`}
            </p>
          )}

          {extra > 0 && (
            <p className="text-[11px] text-white/30 mt-1.5 flex items-center gap-1.5">
              <Copy className="w-3 h-3 flex-shrink-0" />
              {child.crossShape
                ? `Stored ${records.length} times — camp and academy records, shown together`
                : `${records.length} records for this child — worth tidying up`}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}

export default function AdminPersonDetail() {
  const [, params] = useRoute("/admin/people/:key");
  const [, navigate] = useLocation();
  const personKeyParam = params?.key || "";
  const back = useBackTo("/admin/contacts", "Back to Contacts");
  const { toast } = useToast();
  const [linking, setLinking] = useState<null | "guardian" | "child">(null);
  // Correcting details taken over the phone (Daniel, 2026-09-04).
  const [editing, setEditing] = useState(false);
  const [eFirst, setEFirst] = useState(""); const [eLast, setELast] = useState("");
  const [eEmail, setEEmail] = useState(""); const [ePhone, setEPhone] = useState("");
  const [eSchool, setESchool] = useState(""); const [saveErr, setSaveErr] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/admin/people", personKeyParam],
    queryFn: async () => {
      const res = await workspaceFetch(`/api/admin/people/${personKeyParam}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Not found");
      return res.json();
    },
    enabled: !!personKeyParam,
  });

  const unlink = useMutation({
    mutationFn: (guardianKey: string) =>
      apiRequest("DELETE", `/api/admin/people/${personKeyParam}/guardians/${guardianKey}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/admin/people", personKeyParam] }),
  });

  if (isLoading) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48 rounded-xl bg-blue-500/[0.04]" />
        <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />
      </div>
    );
  }

  if (error || !data?.person) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto">
        <Link href={back.href}>
          <button className="text-[13px] text-white/40 hover:text-white/70">← {back.label}</button>
        </Link>
        <p className="text-white/30 text-center py-12">Person not found</p>
      </div>
    );
  }

  const p = data.person;
  const today: string = data.today;
  const guardians: any[] = data.guardians || [];
  const children: any[] = data.children || [];
  const regs: any[] = data.registrations || [];
  const isPlayer = p.type === "player";

  const saveEdits = useMutation({
    mutationFn: async () => {
      const payload: Record<string, string> = { firstName: eFirst, lastName: eLast };
      if (isPlayer) payload.school = eSchool; else { payload.email = eEmail; payload.phone = ePhone; }
      const res = await apiRequest("PATCH", `/api/admin/people/${personKeyParam}`, payload);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Could not save");
      return res.json();
    },
    onSuccess: () => {
      setEditing(false); setSaveErr(null);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/people"] });
      toast({ title: "Details updated" });
    },
    onError: (e: Error) => setSaveErr(e.message),
  });

  const startEditing = () => {
    setEFirst(p.firstName || ""); setELast(p.lastName || "");
    setEEmail(p.email || ""); setEPhone(p.phone || ""); setESchool(p.school || "");
    setSaveErr(null); setEditing(true);
  };
  const age = ageFromDob(p.dateOfBirth, today);
  const hasMedical = p.allergies || p.medicalNotes || p.epiPen;
  // A camp child's parent is fixed by the booking; only contacts carry an
  // editable relationship edge.
  const canManageGuardians = p.kind === "contact";

  const openPerson = (key: string) => navigate(`/admin/people/${key}`);

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={back.href}>
          <button
            className="w-9 h-9 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] flex items-center justify-center hover:bg-white/[0.08] transition-colors flex-shrink-0"
            title={back.label}
            data-testid="link-back-to-contacts"
          >
            <ArrowLeft className="w-4 h-4 text-white/40" />
          </button>
        </Link>
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${isPlayer ? "bg-emerald-500/10 border border-emerald-500/15" : "bg-amber-500/10 border border-amber-500/15"}`}>
            <span className={`text-[14px] font-bold ${isPlayer ? "text-emerald-400/70" : "text-amber-400/70"}`}>
              {(p.firstName?.[0] || "")}{(p.lastName?.[0] || "")}
            </span>
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-white/90 truncate" data-testid="text-person-name">{p.firstName} {p.lastName}</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <Badge
                variant="outline"
                className={`text-[9px] uppercase tracking-wider ${isPlayer ? "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8" : "text-amber-400/70 border-amber-500/20 bg-amber-500/8"}`}
                data-testid="badge-person-type"
              >
                {isPlayer ? "Player" : "Parent / Guardian"}
              </Badge>
              {age !== null && <span className="text-[11px] text-white/30">{age}y old</span>}
            </div>
          </div>
        </div>
      </div>

      {editing ? (
        <Card title={isPlayer ? "Player Details" : "Contact Details"}>
          {/* Narrow on purpose: a name, how to reach them, and the school. NOT
              the date of birth — it sets the NZF age grade, and a typo there
              regrades a child silently. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <div>
              <label className="text-[11px] uppercase tracking-wide text-foreground/60 mb-1 block">First name</label>
              <Input value={eFirst} onChange={(e) => setEFirst(e.target.value)} data-testid="input-edit-first" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-foreground/60 mb-1 block">Last name</label>
              <Input value={eLast} onChange={(e) => setELast(e.target.value)} data-testid="input-edit-last" />
            </div>
            {isPlayer ? (
              <div className="sm:col-span-2">
                <label className="text-[11px] uppercase tracking-wide text-foreground/60 mb-1 block">School</label>
                <Input value={eSchool} onChange={(e) => setESchool(e.target.value)} data-testid="input-edit-school" />
              </div>
            ) : (
              <>
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-foreground/60 mb-1 block">Email</label>
                  <Input type="email" value={eEmail} onChange={(e) => setEEmail(e.target.value)} data-testid="input-edit-email" />
                  <p className="text-[11px] text-foreground/45 mt-1 leading-snug">
                    This is how their registrations and payments are matched to them — changing it re-points their whole history.
                  </p>
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-foreground/60 mb-1 block">Phone</label>
                  <Input type="tel" value={ePhone} onChange={(e) => setEPhone(e.target.value)} data-testid="input-edit-phone" />
                </div>
              </>
            )}
          </div>
          {saveErr && (
            <p className="text-[12.5px] text-red-500 mt-3" data-testid="text-edit-error">{saveErr}</p>
          )}
          <div className="flex gap-2 mt-4">
            <Button size="sm" onClick={() => saveEdits.mutate()} disabled={saveEdits.isPending || !eFirst.trim()} data-testid="button-save-details">
              {saveEdits.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setEditing(false); setSaveErr(null); }} data-testid="button-cancel-edit">
              Cancel
            </Button>
          </div>
        </Card>
      ) : isPlayer ? (
        <Card title="Player Details" onEdit={startEditing}>
          <DetailRow label="Date of Birth" value={p.dateOfBirth ? `${formatDate(p.dateOfBirth)}${age !== null ? ` · ${age}y old` : ""}` : null} icon={Calendar} />
          {p.gender && <DetailRow label="Gender" value={p.gender} icon={User} />}
          {p.school && <DetailRow label="School" value={p.schoolYear ? `${p.school} · ${p.schoolYear}` : p.school} icon={School} />}
          {p.email && <DetailRow label="Email" value={p.email} icon={Mail} />}
          {p.phone && <DetailRow label="Phone" value={p.phone} icon={Phone} />}
        </Card>
      ) : (
        <Card title="Contact Details" onEdit={startEditing}>
          <DetailRow label="Email" value={p.email} icon={Mail} />
          <DetailRow label="Phone" value={p.phone} icon={Phone} />
          {p.alternatePhone && <DetailRow label="Alternate Phone" value={p.alternatePhone} icon={Phone} />}
          {p.address && <DetailRow label="Address" value={p.address} icon={MapPin} />}
          {p.emergencyContact && <DetailRow label="Emergency Contact" value={`${p.emergencyContact}${p.emergencyPhone ? ` · ${p.emergencyPhone}` : ""}`} icon={AlertTriangle} />}
        </Card>
      )}

      {hasMedical && (
        <div className="rounded-xl border border-amber-500/[0.15] overflow-hidden">
          <div className="px-4 py-2.5 bg-amber-500/[0.06] border-b border-amber-500/[0.1] flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70" />
            <span className="text-[11px] text-amber-300/60 uppercase tracking-wider font-semibold">Medical</span>
          </div>
          <div className="p-4">
            {p.epiPen && <p className="text-[13px] text-amber-300/80 mb-2 font-semibold">Carries an EpiPen</p>}
            {p.allergies && <DetailRow label="Allergies" value={p.allergies} />}
            {p.medicalNotes && <DetailRow label="Notes" value={p.medicalNotes} />}
          </div>
        </div>
      )}

      {/* ── Programme & payment history ──────────────────────────────────────
          On a player: everything they signed up for and everything paid against
          them. On a parent: their own record, with the household roll-up in the
          summary strip — each shared booking counted once. */}
      <HistorySection
        title={isPlayer ? "Programme & payment history" : "Household programme & payment history"}
        history={data.history}
        household={isPlayer ? undefined : data.household}
        emptyNote={
          isPlayer
            ? "Nothing on file yet — no programmes and no payments recorded against this player."
            : "Nothing on file yet for this parent or their children."
        }
      />

      {/* ── Children ─────────────────────────────────────────────────────────
          Always rendered for a parent, even when empty. A card that simply
          vanishes cannot be told apart from one that failed to load — which is
          precisely how "the parent's page doesn't show the child" felt. */}
      {(!isPlayer || children.length > 0) && (
        <Card
          title="Children"
          count={children.length}
          action={p.kind === "contact" ? (
            <button
              onClick={() => setLinking("child")}
              className="text-[11px] text-blue-300/60 hover:text-blue-300/90 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/[0.05] min-h-[32px]"
              data-testid="button-link-child"
            >
              <Plus className="w-3.5 h-3.5" /> Link a child
            </button>
          ) : undefined}
        >
          {children.length === 0 ? (
            <p className="text-[12px] text-white/25 py-2">
              No children linked to this parent yet.
            </p>
          ) : (
            <div className="space-y-2">
              {children.map(c => (
                <ChildRow key={c.key} child={c} today={today} onOpen={openPerson} />
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── Parents / guardians ───────────────────────────────────────────── */}
      {(isPlayer || guardians.length > 0) && (
        <Card
          title="Parents / Guardians"
          count={guardians.length}
          action={canManageGuardians ? (
            <button
              onClick={() => setLinking("guardian")}
              className="text-[11px] text-blue-300/60 hover:text-blue-300/90 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/[0.05] min-h-[32px]"
              data-testid="button-link-guardian"
            >
              <Plus className="w-3.5 h-3.5" /> Link a parent
            </button>
          ) : undefined}
        >
          {guardians.length === 0 ? (
            <p className="text-[12px] text-white/25 py-2">
              No parent linked yet.{canManageGuardians ? " Use “Link a parent” to connect one." : ""}
            </p>
          ) : (
            <div className="space-y-2">
              {guardians.map(g => {
                // Only an explicit edge can be removed. A link that exists
                // because someone paid is a payment record, not a preference.
                const explicit = (g.sources || []).includes("relationship");
                const fromRegistration = (g.sources || []).includes("registration");
                return (
                  <div key={g.key} className="flex items-center gap-2">
                    <button
                      onClick={() => openPerson(g.key)}
                      className="flex-1 min-w-0 text-left px-3 py-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-blue-500/[0.06] transition-colors min-h-[44px]"
                      data-testid={`row-guardian-${g.key}`}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] text-white/80">{g.firstName} {g.lastName}</span>
                        <Badge variant="outline" className="text-[9px] uppercase tracking-wider text-amber-400/60 border-amber-500/20 bg-amber-500/8">
                          {g.relationship || "Parent"}
                        </Badge>
                        {!explicit && fromRegistration && (
                          <span className="text-[10px] text-white/25 flex items-center gap-1">
                            <Link2 className="w-3 h-3" /> from registration
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-white/30 mt-0.5 truncate">
                        {[g.email, g.phone].filter(Boolean).join(" · ") || "No contact details"}
                      </p>
                    </button>
                    {canManageGuardians && explicit && (
                      <button
                        onClick={() => {
                          if (confirm(`Unlink ${g.firstName} ${g.lastName} from ${p.firstName} ${p.lastName}?`)) unlink.mutate(g.key);
                        }}
                        disabled={unlink.isPending}
                        className="w-11 h-11 rounded-lg bg-white/[0.03] border border-blue-500/[0.06] flex items-center justify-center hover:bg-red-500/10 hover:border-red-500/20 transition-colors flex-shrink-0 disabled:opacity-40"
                        title="Unlink"
                        data-testid={`button-unlink-${g.key}`}
                      >
                        <Unlink className="w-3.5 h-3.5 text-white/35" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ── This person's own programmes ──────────────────────────────────── */}
      {regs.length > 0 && (
        <Card title={isPlayer ? "Programmes" : "Bookings in their own name"} count={regs.length}>
          <div className="space-y-2">
            {regs.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-blue-500/[0.06]">
                <div className="min-w-0">
                  <p className="text-[13px] text-white/75 truncate">{r.programName}</p>
                  <p className="text-[11px] text-white/25">
                    {r.registeredAt ? new Date(r.registeredAt).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[12px] text-white/50">{formatCurrency(regValue(r))}</span>
                  <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${STATUS_STYLE[r.status] || "text-white/40 border-white/10 bg-white/[0.04]"}`}>
                    {r.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {linking && <LinkDialog personKey={personKeyParam} mode={linking} onClose={() => setLinking(null)} />}
    </div>
  );
}

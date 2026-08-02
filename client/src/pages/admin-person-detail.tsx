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
  ArrowLeft, User, Users, Mail, Phone, Calendar, AlertTriangle, MapPin, School,
  Link2, Unlink, Plus, Search, X, Copy,
} from "lucide-react";
import { useBackTo } from "@/lib/back-to";
import { formatCurrency } from "@/lib/format";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { RELATIONSHIP_OPTIONS, ageFromDob } from "@shared/family";

function formatDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });
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

function Card({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
      <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06] flex items-center justify-between gap-2">
        <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">
          {title}{typeof count === "number" ? ` (${count})` : ""}
        </span>
        {action}
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
      const res = await fetch(
        `/api/admin/people?filter=${linkingGuardian ? "parents" : "players"}&limit=8&q=${encodeURIComponent(q)}`,
        { credentials: "include" },
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
            {child.registrations.length === 0 && (
              <span className="text-[11px] text-white/25">No programmes</span>
            )}
            {child.registrations.map((r: any) => (
              <ProgrammeBadge key={r.id} name={r.programName} status={r.status} />
            ))}
          </div>

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
  const [linking, setLinking] = useState<null | "guardian" | "child">(null);

  const { data, isLoading, error } = useQuery<any>({
    queryKey: ["/api/admin/people", personKeyParam],
    queryFn: async () => {
      const res = await fetch(`/api/admin/people/${personKeyParam}`, { credentials: "include" });
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

      {isPlayer ? (
        <Card title="Player Details">
          <DetailRow label="Date of Birth" value={p.dateOfBirth ? `${formatDate(p.dateOfBirth)}${age !== null ? ` · ${age}y old` : ""}` : null} icon={Calendar} />
          {p.gender && <DetailRow label="Gender" value={p.gender} icon={User} />}
          {p.school && <DetailRow label="School" value={p.schoolYear ? `${p.school} · ${p.schoolYear}` : p.school} icon={School} />}
          {p.email && <DetailRow label="Email" value={p.email} icon={Mail} />}
          {p.phone && <DetailRow label="Phone" value={p.phone} icon={Phone} />}
        </Card>
      ) : (
        <Card title="Contact Details">
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

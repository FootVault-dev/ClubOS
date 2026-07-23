import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useRoute, Link, useLocation } from "wouter";
import { ArrowLeft, User, Users, Mail, Phone, Calendar, AlertTriangle, MapPin, Shield, School } from "lucide-react";
import { useBackTo } from "@/lib/back-to";
import { formatCurrency } from "@/lib/format";

function formatAge(dob: string | null | undefined): string {
  if (!dob) return "";
  const birth = new Date(dob + "T00:00:00");
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return `${age}y`;
}

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
        <p className="text-[13px] text-white/70 mt-0.5">{value || "—"}</p>
      </div>
    </div>
  );
}

function ParentDetailPage() {
  const [, params] = useRoute("/admin/contacts/parent/:id");
  const [, navigate] = useLocation();
  const contactId = parseInt(params?.id || "0");
  // Back returns to whatever sent us here — a programme's Players tab, say —
  // rather than always dumping the user in the full Contacts list.
  const back = useBackTo("/admin/contacts", "Back to Contacts");

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/contacts/parent", contactId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/contacts/parent/${contactId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: contactId > 0,
  });

  if (isLoading) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48 rounded-xl bg-blue-500/[0.04]" />
        <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />
      </div>
    );
  }

  if (!data?.contact) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto">
        <p className="text-white/30 text-center py-12">Contact not found</p>
      </div>
    );
  }

  const c = data.contact;
  const kids = data.children || [];
  const regs = data.registrations || [];
  const guardians = data.guardians || [];
  // Academy registrations put the PLAYER in contacts (type 'player') with the
  // parent on the registration's guardian_id — so this same page has to render
  // a child, not just a parent. Labelling a 7-year-old "Parent / Guardian" and
  // showing them empty email/phone rows was plain wrong.
  const isPlayer = c.type === "player";
  const hasMedical = c.allergies || c.medicalNotes;

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={back.href}>
          <button className="w-8 h-8 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer" title={back.label} data-testid="link-back-to-contacts">
            <ArrowLeft className="w-4 h-4 text-white/40" />
          </button>
        </Link>
        <div className="flex items-center gap-3">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${isPlayer ? "bg-emerald-500/10 border border-emerald-500/15" : "bg-amber-500/10 border border-amber-500/15"}`}>
            <span className={`text-[14px] font-bold ${isPlayer ? "text-emerald-400/70" : "text-amber-400/70"}`}>{c.firstName[0]}{c.lastName[0]}</span>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white/90" data-testid="text-contact-name">{c.firstName} {c.lastName}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge
                variant="outline"
                className={`text-[9px] uppercase tracking-wider ${isPlayer ? "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8" : "text-amber-400/70 border-amber-500/20 bg-amber-500/8"}`}
                data-testid="badge-contact-type"
              >
                {isPlayer ? "Player" : "Parent / Guardian"}
              </Badge>
              {isPlayer && c.dateOfBirth && (
                <span className="text-[11px] text-white/30">{formatAge(c.dateOfBirth)} old</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {isPlayer ? (
        <>
          <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
            <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
              <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Player Details</span>
            </div>
            <div className="p-4 space-y-0">
              <DetailRow label="Date of Birth" value={c.dateOfBirth ? `${formatDate(c.dateOfBirth)} · ${formatAge(c.dateOfBirth)} old` : null} icon={Calendar} />
              {c.gender && <DetailRow label="Gender" value={c.gender} icon={User} />}
              {c.school && <DetailRow label="School" value={c.schoolYear ? `${c.school} · ${c.schoolYear}` : c.school} icon={School} />}
              {c.email && <DetailRow label="Email" value={c.email} icon={Mail} />}
              {c.phone && <DetailRow label="Phone" value={c.phone} icon={Phone} />}
              {c.emergencyContact && <DetailRow label="Emergency Contact" value={`${c.emergencyContact}${c.emergencyPhone ? ` — ${c.emergencyPhone}` : ""}`} icon={Shield} />}
            </div>
          </div>

          {hasMedical && (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] overflow-hidden">
              <div className="px-4 py-2.5 bg-amber-500/[0.06] border-b border-amber-500/[0.12] flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70" />
                <span className="text-[11px] text-amber-300/60 uppercase tracking-wider font-semibold">Medical</span>
              </div>
              <div className="p-4 space-y-1.5">
                {c.allergies && <p className="text-[13px] text-amber-200/70">Allergies: {c.allergies}</p>}
                {c.medicalNotes && <p className="text-[12px] text-amber-200/50">{c.medicalNotes}</p>}
              </div>
            </div>
          )}

          {guardians.length > 0 && (
            <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
              <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
                <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">
                  Parent / Guardian ({guardians.length})
                </span>
              </div>
              <div className="divide-y divide-blue-500/[0.04]">
                {guardians.map((g: any) => (
                  <div
                    key={g.id}
                    onClick={() => navigate(`/admin/contacts/parent/${g.id}`)}
                    className="flex items-center justify-between px-4 py-3 hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
                    data-testid={`row-guardian-${g.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/15 flex items-center justify-center flex-shrink-0">
                        <span className="text-[11px] font-semibold text-amber-400/60">{g.firstName?.[0]}{g.lastName?.[0]}</span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-white/80 truncate">{g.firstName} {g.lastName}</p>
                        <p className="text-[11px] text-white/30 truncate">{[g.email, g.phone].filter(Boolean).join(" · ") || "—"}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-[9px] text-amber-400/70 border-amber-500/20 bg-amber-500/8 uppercase tracking-wider flex-shrink-0">Guardian</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
            <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Contact Details</span>
          </div>
          <div className="p-4 space-y-0">
            <DetailRow label="Email" value={c.email} icon={Mail} />
            <DetailRow label="Phone" value={c.phone} icon={Phone} />
            {c.alternatePhone && <DetailRow label="Alternate Phone" value={c.alternatePhone} icon={Phone} />}
            <DetailRow label="Address" value={c.address} icon={MapPin} />
            {c.emergencyContact && <DetailRow label="Emergency Contact" value={`${c.emergencyContact}${c.emergencyPhone ? ` — ${c.emergencyPhone}` : ""}`} icon={Shield} />}
          </div>
        </div>
      )}

      {kids.length > 0 && (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
            <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Children / Players ({kids.length})</span>
          </div>
          <div className="divide-y divide-blue-500/[0.04]">
            {kids.map((kid: any) => (
              <div
                key={kid.id}
                onClick={() => navigate(`/admin/contacts/player/${kid.id}`)}
                className="flex items-center justify-between px-4 py-3 hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
                data-testid={`row-child-${kid.id}`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/15 flex items-center justify-center">
                    <span className="text-[11px] font-semibold text-emerald-400/60">{kid.firstName[0]}{kid.lastName[0]}</span>
                  </div>
                  <div>
                    <p className="text-[13px] font-medium text-white/80">{kid.firstName} {kid.lastName}</p>
                    <p className="text-[11px] text-white/30">
                      {kid.dateOfBirth ? `${formatAge(kid.dateOfBirth)} old · Born ${formatDate(kid.dateOfBirth)}` : "—"}
                    </p>
                  </div>
                  {(kid.medical?.allergies || kid.medical?.epiPen) && (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-400/60" />
                  )}
                </div>
                <Badge variant="outline" className="text-[9px] text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8 uppercase tracking-wider">Player</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {regs.length > 0 && (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
            <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Registrations ({regs.length})</span>
          </div>
          <div className="divide-y divide-blue-500/[0.04]">
            {regs.map((reg: any) => (
              <div key={reg.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-white/70">{reg.program?.name || `Program #${reg.programId}`}</p>
                    <p className="text-[11px] text-white/30">
                      {reg.items?.length || 0} session{(reg.items?.length || 0) !== 1 ? "s" : ""} · {formatCurrency(reg.amountPaid || 0)} paid
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {reg.referralSource && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-violet-500/25 text-violet-400/70 bg-violet-500/5" data-testid={`badge-referral-${reg.id}`}>
                        {reg.referralSource.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}
                      </Badge>
                    )}
                    <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${reg.status === "confirmed" ? "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8" : "text-white/30 border-white/10 bg-white/[0.02]"}`}>
                      {reg.status}
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerDetailPage() {
  const [, params] = useRoute("/admin/contacts/player/:id");
  const [, navigate] = useLocation();
  const playerId = parseInt(params?.id || "0");
  const back = useBackTo("/admin/contacts", "Back to Contacts");

  const { data, isLoading } = useQuery<any>({
    queryKey: ["/api/admin/contacts/player", playerId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/contacts/player/${playerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: playerId > 0,
  });

  if (isLoading) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-8 w-48 rounded-xl bg-blue-500/[0.04]" />
        <Skeleton className="h-64 w-full rounded-xl bg-blue-500/[0.04]" />
      </div>
    );
  }

  if (!data?.child) {
    return (
      <div className="p-4 sm:p-8 max-w-3xl mx-auto">
        <p className="text-white/30 text-center py-12">Player not found</p>
      </div>
    );
  }

  const child = data.child;
  const parent = data.parent;
  const regs = data.registrations || [];
  const hasMedical = child.medical?.allergies || child.medical?.epiPen;

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href={back.href}>
          <button className="w-8 h-8 rounded-xl bg-white/[0.04] border border-blue-500/[0.08] flex items-center justify-center hover:bg-white/[0.08] transition-colors cursor-pointer" title={back.label} data-testid="link-back-to-contacts">
            <ArrowLeft className="w-4 h-4 text-white/40" />
          </button>
        </Link>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/15 flex items-center justify-center">
            <span className="text-[14px] font-bold text-emerald-400/70">{child.firstName[0]}{child.lastName[0]}</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-white/90" data-testid="text-contact-name">{child.firstName} {child.lastName}</h1>
              {hasMedical && <AlertTriangle className="w-4 h-4 text-amber-400/60" />}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-[9px] text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8 uppercase tracking-wider">Player</Badge>
              {child.dateOfBirth && <span className="text-[11px] text-white/30">{formatAge(child.dateOfBirth)} old</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
        <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
          <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Player Details</span>
        </div>
        <div className="p-4 space-y-0">
          <DetailRow label="Date of Birth" value={child.dateOfBirth ? `${formatDate(child.dateOfBirth)} (${formatAge(child.dateOfBirth)})` : null} icon={Calendar} />
          {child.gender && <DetailRow label="Gender" value={child.gender} icon={User} />}
        </div>
      </div>

      {hasMedical && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] overflow-hidden">
          <div className="px-4 py-2.5 bg-amber-500/[0.06] border-b border-amber-500/15 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400/70" />
            <span className="text-[11px] text-amber-400/80 uppercase tracking-wider font-semibold">Medical Information</span>
          </div>
          <div className="p-4 space-y-2">
            {child.medical?.allergies && (
              <div>
                <p className="text-[10px] text-amber-300/40 uppercase tracking-wider font-semibold">Allergies</p>
                <p className="text-[13px] text-amber-300/70 mt-0.5">{child.medical.allergies}</p>
              </div>
            )}
            {child.medical?.epiPen && (
              <p className="text-[12px] text-red-400/80 font-medium">⚠ Carries EpiPen</p>
            )}
            {child.medical?.notes && (
              <div>
                <p className="text-[10px] text-amber-300/40 uppercase tracking-wider font-semibold">Notes</p>
                <p className="text-[13px] text-amber-300/60 mt-0.5">{child.medical.notes}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {parent && (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
            <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Parent / Guardian</span>
          </div>
          <div
            onClick={() => navigate(`/admin/contacts/parent/${parent.id}`)}
            className="flex items-center justify-between px-4 py-3 hover:bg-blue-500/[0.04] transition-colors cursor-pointer"
            data-testid={`row-parent-${parent.id}`}
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/15 flex items-center justify-center">
                <span className="text-[11px] font-semibold text-amber-400/60">{parent.firstName[0]}{parent.lastName[0]}</span>
              </div>
              <div>
                <p className="text-[13px] font-medium text-white/80">{parent.firstName} {parent.lastName}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  {parent.email && (
                    <span className="text-[11px] text-blue-400/60 flex items-center gap-1">
                      <Mail className="w-3 h-3" /> {parent.email}
                    </span>
                  )}
                  {parent.phone && (
                    <span className="text-[11px] text-white/30 flex items-center gap-1">
                      <Phone className="w-3 h-3" /> {parent.phone}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <Badge variant="outline" className="text-[9px] text-amber-400/70 border-amber-500/20 bg-amber-500/8 uppercase tracking-wider">Parent</Badge>
          </div>
        </div>
      )}

      {regs.length > 0 && (
        <div className="rounded-xl border border-blue-500/[0.08] overflow-hidden">
          <div className="px-4 py-2.5 bg-blue-500/[0.04] border-b border-blue-500/[0.06]">
            <span className="text-[11px] text-blue-300/40 uppercase tracking-wider font-semibold">Registrations ({regs.length})</span>
          </div>
          <div className="divide-y divide-blue-500/[0.04]">
            {regs.map((reg: any) => (
              <div key={reg.id} className="px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-white/70">{reg.program?.name || `Program #${reg.programId}`}</p>
                    <p className="text-[11px] text-white/30">
                      {reg.items?.length || 0} session{(reg.items?.length || 0) !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {reg.referralSource && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 border-violet-500/25 text-violet-400/70 bg-violet-500/5">
                        {reg.referralSource.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}
                      </Badge>
                    )}
                    <Badge variant="outline" className={`text-[9px] uppercase tracking-wider ${reg.status === "confirmed" ? "text-emerald-400/70 border-emerald-500/20 bg-emerald-500/8" : "text-white/30 border-white/10 bg-white/[0.02]"}`}>
                      {reg.status}
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AdminContactDetail() {
  const [isParent] = useRoute("/admin/contacts/parent/:id");
  const [isPlayer] = useRoute("/admin/contacts/player/:id");

  if (isParent) return <ParentDetailPage />;
  if (isPlayer) return <PlayerDetailPage />;

  return (
    <div className="p-4 sm:p-8 max-w-3xl mx-auto">
      <p className="text-white/30 text-center py-12">Contact not found</p>
    </div>
  );
}

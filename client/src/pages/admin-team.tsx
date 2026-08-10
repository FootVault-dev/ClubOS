import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Users, UserPlus, X, Search, Shield, ChevronRight, Trash2, MailCheck,
  Lock, Building2, AlertCircle, KeyRound, Mail, Copy, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tabsForOrgSlug, type TabDef } from "@shared/tabs";

// hiringBrands: null = every brand (the default, and what every membership
// predating brand scoping means). [] = none. See the Hiring tab's brand scope
// below and server/hiring-routes.ts, which is where it is actually enforced.
interface Membership { orgId: number; orgName: string; orgSlug: string; role: string; tabs: string[] | null; hiringBrands: string[] | null; }
interface TeamMember {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  globalRole: string;
  active: boolean;
  // Global, not per-workspace: this person may send money back to a customer's
  // card anywhere in ClubOS. Deliberately separate from every role.
  canIssueRefunds: boolean;
  createdAt: string;
  memberships: Membership[];
}
interface Org { id: number; name: string; slug: string; logoUrl: string | null; userRole?: string; }

const WORKSPACE_ROLES: { value: string; label: string; description: string }[] = [
  { value: "admin",        label: "Admin",         description: "Full access to this workspace" },
  { value: "manager",      label: "Manager",       description: "Manages day-to-day operations" },
  { value: "team_member",  label: "Team Member",   description: "Standard staff access" },
  { value: "coach",        label: "Coach",         description: "Sees rolls + training-relevant data" },
  { value: "finance",      label: "Finance",       description: "Read-only financial reports" },
  { value: "marketing",    label: "Marketing",     description: "CRM + email + landing pages" },
  { value: "registrar",    label: "Registrar",     description: "Bookings + waitlist management" },
];

const GLOBAL_ROLES: { value: string; label: string; description: string }[] = [
  { value: "admin",       label: "Admin (workspace-scoped)", description: "Recommended. Permissions come from each workspace membership." },
  { value: "super_admin", label: "Super Admin",              description: "Sees ALL workspaces and all data. Use sparingly." },
];

function generateTempPassword(): string {
  const adj = ["bright", "swift", "calm", "happy", "lucky", "kind", "bold", "warm"];
  const noun = ["fox", "owl", "wave", "hill", "tree", "lake", "cloud", "stone"];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}-${num}`;
}

// Per-workspace draft state for the Add Member modal.
// tabs is the explicit whitelist (null only when role is admin/manager — those
// roles imply full access regardless of tabs column).
type DraftMembership = { role: string; tabs: string[] };

function AddMemberModal({
  open, onClose, organizations,
}: { open: boolean; onClose: () => void; organizations: Org[] }) {
  const { toast } = useToast();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(generateTempPassword());
  const [globalRole, setGlobalRole] = useState("admin");
  const [memberships, setMemberships] = useState<Record<number, DraftMembership>>({});
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true);

  const create = useMutation({
    mutationFn: async () => {
      // Send tabs as null when the role grants full access (admin/manager) —
      // matches server-side canAccessTab semantics. Otherwise send the array.
      const membershipsArr = Object.entries(memberships).map(([orgId, draft]) => {
        const fullAccessRole = draft.role === "admin" || draft.role === "manager";
        return {
          orgId: parseInt(orgId),
          role: draft.role,
          tabs: fullAccessRole ? null : draft.tabs,
        };
      });
      const res = await apiRequest("POST", "/api/admin/team", {
        email, firstName, lastName, password, globalRole,
        memberships: membershipsArr,
        sendWelcomeEmail,
      });
      return res.json();
    },
    onSuccess: (user: TeamMember) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({
        title: `${user.firstName} added`,
        description: `Access to ${user.memberships.length} workspace${user.memberships.length === 1 ? "" : "s"}. ${sendWelcomeEmail ? "Welcome email sent." : "You'll need to share their password manually."}`,
      });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't add member", description: e.message, variant: "destructive" }),
  });

  const formValid = firstName.trim() && lastName.trim() && /\S+@\S+\.\S+/.test(email) && password.length >= 8 && Object.keys(memberships).length > 0;

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#02060E] max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <h3 className="text-lg font-semibold text-white">Add team member</h3>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto p-6 space-y-5 flex-1">
          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">Person</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] text-white/50 mb-1 block">First name</label>
                <Input value={firstName} onChange={e => setFirstName(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div>
                <label className="text-[11px] text-white/50 mb-1 block">Last name</label>
                <Input value={lastName} onChange={e => setLastName(e.target.value)} className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-white/50 mb-1 block">Email</label>
                <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="dima@unitedprints.co.nz" className="bg-white/[0.02] border-white/10 text-white" />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] text-white/50 mb-1 block">Temporary password</label>
                <div className="flex gap-2">
                  <Input value={password} onChange={e => setPassword(e.target.value)} className="bg-white/[0.02] border-white/10 text-white font-mono" />
                  <Button type="button" variant="outline" onClick={() => setPassword(generateTempPassword())} className="border-white/10 text-white/70 flex-shrink-0">
                    Regenerate
                  </Button>
                </div>
                <p className="text-[10px] text-white/40 mt-1">They'll be prompted to change it on first login.</p>
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3 flex items-center gap-2">
              <Building2 className="w-3.5 h-3.5" /> Workspace access
            </h4>
            <p className="text-xs text-white/50 mb-3">Tick a workspace, pick a role, then choose exactly which tabs this person can see. Admin and Manager roles get full access regardless.</p>
            <div className="space-y-2">
              {organizations.map(org => {
                const draft = memberships[org.id];
                const isSelected = draft !== undefined;
                const allTabs = tabsForOrgSlug(org.slug);
                const fullAccessRole = draft?.role === "admin" || draft?.role === "manager";
                return (
                  <div
                    key={org.id}
                    className={`rounded-lg border p-3 transition ${
                      isSelected ? "border-blue-500/40 bg-blue-500/5" : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <label className="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            // Default per Daniel's choice: no tabs ticked. They must
                            // explicitly grant access. Role defaults to team_member
                            // (least-privilege) rather than admin.
                            setMemberships({ ...memberships, [org.id]: { role: "team_member", tabs: [] } });
                          } else {
                            const { [org.id]: _, ...rest } = memberships;
                            setMemberships(rest);
                          }
                        }}
                      />
                      <div className="w-8 h-8 rounded-md bg-white/[0.06] flex items-center justify-center flex-shrink-0 overflow-hidden">
                        {org.logoUrl
                          ? <img src={org.logoUrl} alt={org.name} className="w-full h-full object-cover" />
                          : <Building2 className="w-3.5 h-3.5 text-white/40" />}
                      </div>
                      <div className="flex-1 text-sm text-white">{org.name}</div>
                    </label>
                    {isSelected && draft && (
                      <div className="mt-3 ml-7 space-y-3">
                        {/* Role picker */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {WORKSPACE_ROLES.map(r => (
                            <button
                              key={r.value}
                              type="button"
                              onClick={() => setMemberships({ ...memberships, [org.id]: { ...draft, role: r.value } })}
                              className={`px-3 py-2 rounded-md text-xs text-left transition ${
                                draft.role === r.value
                                  ? "bg-blue-600 text-white"
                                  : "bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"
                              }`}
                            >
                              {r.label}
                            </button>
                          ))}
                        </div>

                        {/* Tab access */}
                        <div className="rounded-md bg-black/20 border border-white/[0.06] p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-[11px] uppercase tracking-wider font-semibold text-white/50">
                              Tab access
                            </p>
                            {!fullAccessRole && (
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => setMemberships({ ...memberships, [org.id]: { ...draft, tabs: allTabs.map((t: TabDef) => t.slug) } })}
                                  className="text-[10px] text-blue-400 hover:text-blue-300"
                                >
                                  Select all
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setMemberships({ ...memberships, [org.id]: { ...draft, tabs: [] } })}
                                  className="text-[10px] text-white/40 hover:text-white/60"
                                >
                                  Clear
                                </button>
                              </div>
                            )}
                          </div>
                          {fullAccessRole ? (
                            <p className="text-[11px] text-amber-300/80">
                              Admin and Manager roles see all tabs — tab selection isn't applied. Pick a different role above to scope access.
                            </p>
                          ) : (
                            <div className="grid grid-cols-2 gap-1.5">
                              {allTabs.map((tab: TabDef) => {
                                const checked = draft.tabs.includes(tab.slug);
                                return (
                                  <label
                                    key={tab.slug}
                                    className={`flex items-center gap-2 px-2 py-1.5 rounded text-[12px] cursor-pointer transition ${
                                      checked ? "bg-blue-500/10 text-white" : "text-white/50 hover:bg-white/[0.04]"
                                    }`}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(e) => {
                                        const nextTabs = e.target.checked
                                          ? [...draft.tabs, tab.slug]
                                          : draft.tabs.filter(t => t !== tab.slug);
                                        setMemberships({ ...memberships, [org.id]: { ...draft, tabs: nextTabs } });
                                      }}
                                    />
                                    <span className="flex-1 truncate">{tab.title}</span>
                                    {tab.secondary && <span className="text-[9px] text-white/30 uppercase">admin</span>}
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5" /> Global role
            </h4>
            <div className="space-y-2">
              {GLOBAL_ROLES.map(r => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setGlobalRole(r.value)}
                  className={`w-full p-3 rounded-lg border text-left transition ${
                    globalRole === r.value
                      ? "border-blue-500/40 bg-blue-500/5"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20"
                  }`}
                >
                  <div className="text-sm font-semibold text-white">{r.label}</div>
                  <div className="text-xs text-white/50 mt-0.5">{r.description}</div>
                </button>
              ))}
            </div>
            {globalRole === "super_admin" && (
              <div className="mt-2 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/20 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="text-xs text-amber-300">
                  Super admins bypass workspace permissions. They see everything across every brand. Use only for owners/co-founders.
                </div>
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm text-white/70">
            <input type="checkbox" checked={sendWelcomeEmail} onChange={e => setSendWelcomeEmail(e.target.checked)} />
            <MailCheck className="w-4 h-4" /> Email them their login details
          </label>
        </div>
        <div className="px-6 py-4 border-t border-white/5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!formValid || create.isPending} className="bg-blue-600 hover:bg-blue-700">
            <UserPlus className="w-4 h-4 mr-1.5" />
            {create.isPending ? "Adding..." : "Add team member"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which brands' jobs and applicants this person sees inside the Hiring tab.
 *
 * The Hiring tab is one tab for every brand, so holding it used to mean seeing
 * every brand's applicants — CVs, phone numbers and pay conversations included.
 * This narrows it. `null` is "all brands", which is what every membership meant
 * before this existed, so it stays the default and is never set implicitly.
 */
export function HiringBrandScope({ brands, value, onChange }: {
  brands: string[];
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const [adding, setAdding] = useState("");
  const scoped = value !== null;
  const selected = value ?? [];
  // A brand already granted but with no postings yet (CIC before its first job)
  // must still show as ticked, so union the two rather than trusting the list.
  const options = Array.from(new Set([...brands, ...selected])).sort();

  const toggle = (b: string) =>
    onChange(selected.includes(b) ? selected.filter(x => x !== b) : [...selected, b]);

  const addTyped = () => {
    const key = adding.trim().toLowerCase();
    if (!key) return;
    if (!selected.includes(key)) onChange([...selected, key]);
    setAdding("");
  };

  return (
    <div className="rounded-md bg-black/20 border border-white/[0.06] p-2.5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider font-semibold text-white/50">Hiring — which brands</p>
        <button
          type="button"
          onClick={() => onChange(scoped ? null : [])}
          className="text-[10px] text-blue-400 hover:text-blue-300"
        >
          {scoped ? "Allow all brands" : "Limit to certain brands"}
        </button>
      </div>

      {!scoped ? (
        <p className="text-[11px] text-white/50">
          Sees <strong className="text-white/70">every brand's</strong> jobs and applicants.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {options.map(b => {
              const on = selected.includes(b);
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => toggle(b)}
                  className={`px-2 py-1 rounded text-[11px] transition ${
                    on ? "bg-blue-500/15 border border-blue-500/40 text-white" : "border border-white/10 text-white/45 hover:text-white/70"
                  }`}
                >
                  {b}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              value={adding}
              onChange={e => setAdding(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }}
              placeholder="add a brand key, e.g. cic"
              className="flex-1 bg-white/[0.03] border border-white/10 rounded px-2 py-1 text-[11px] text-white/80 placeholder:text-white/25 focus:outline-none focus:border-blue-500/50"
            />
            <button type="button" onClick={addTyped} className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5">Add</button>
          </div>
          {selected.length === 0 && (
            <p className="text-[11px] text-amber-300/80 mt-2">
              No brands ticked — the Hiring tab will open empty for them.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ManageMembershipsModal({
  open, onClose, member, organizations,
}: { open: boolean; onClose: () => void; member: TeamMember | null; organizations: Org[] }) {
  const { toast } = useToast();
  const memberId = member?.id;

  // The brand keys that real postings actually carry, rather than a hardcoded
  // list that could drift from them. A brand with no jobs yet (CIC, at the time
  // of writing) is added by typing it — see HiringBrandScope.
  const { data: brandsData } = useQuery<{ brands: string[] }>({
    queryKey: ["/api/admin/hiring/brands"],
    enabled: open,
  });
  const knownBrands = brandsData?.brands ?? [];

  const addMembership = useMutation({
    mutationFn: async ({ orgId, role, tabs }: { orgId: number; role: string; tabs: string[] | null }) => {
      const res = await apiRequest("POST", `/api/admin/team/${memberId}/memberships`, { orgId, role, tabs });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({ title: "Workspace added" });
    },
    onError: (e: Error) => toast({ title: "Couldn't add", description: e.message, variant: "destructive" }),
  });

  const updateMembership = useMutation({
    mutationFn: async ({ orgId, role, tabs, hiringBrands }: { orgId: number; role?: string; tabs?: string[] | null; hiringBrands?: string[] | null }) => {
      const body: any = {};
      if (role !== undefined) body.role = role;
      if (tabs !== undefined) body.tabs = tabs;
      if (hiringBrands !== undefined) body.hiringBrands = hiringBrands;
      const res = await apiRequest("PATCH", `/api/admin/team/${memberId}/memberships/${orgId}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });

  const removeMembership = useMutation({
    mutationFn: async (orgId: number) => {
      const res = await apiRequest("DELETE", `/api/admin/team/${memberId}/memberships/${orgId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({ title: "Removed from workspace" });
    },
    onError: (e: Error) => toast({ title: "Couldn't remove", description: e.message, variant: "destructive" }),
  });

  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [emailFlag, setEmailFlag] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);

  const setRefundPermission = useMutation({
    mutationFn: async (canIssueRefunds: boolean) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${memberId}`, { canIssueRefunds });
      return res.json();
    },
    onSuccess: (r: { canIssueRefunds: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: r.canIssueRefunds ? "Refunds enabled" : "Refunds disabled",
        description: r.canIssueRefunds
          ? `${member?.firstName} can now refund registrations. Their name is recorded on every one.`
          : `${member?.firstName} can no longer issue refunds.`,
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't change refund access", description: e.message, variant: "destructive" }),
  });

  const resetPassword = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/team/${memberId}/reset-password`, { sendEmail: true });
      return res.json();
    },
    onSuccess: (r: { password: string; emailSent: boolean }) => {
      setRevealedPassword(r.password);
      setEmailFlag(r.emailSent);
      toast({
        title: r.emailSent ? "Password reset + emailed" : "Password reset (email failed — copy manually)",
        description: r.emailSent ? `${member?.firstName} can log in with the new password.` : "Use the copy button to share securely.",
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't reset password", description: e.message, variant: "destructive" }),
  });

  const resendInvite = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/admin/team/${memberId}/resend-invite`);
      return res.json();
    },
    onSuccess: (r: { password: string; emailSent: boolean }) => {
      setRevealedPassword(r.password);
      setEmailFlag(r.emailSent);
      toast({
        title: r.emailSent ? "Invite re-sent" : "New password generated (email failed)",
        description: r.emailSent ? `Welcome email re-sent to ${member?.email} with a fresh temp password.` : "Use the copy button to share manually.",
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't resend invite", description: e.message, variant: "destructive" }),
  });

  if (!open || !member) return null;
  const memberOrgIds = new Set(member.memberships.map(m => m.orgId));
  const availableOrgs = organizations.filter(o => !memberOrgIds.has(o.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-xl rounded-2xl border border-white/10 bg-[#02060E] max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
          <div>
            <h3 className="text-lg font-semibold text-white">{member.firstName} {member.lastName}</h3>
            <p className="text-xs text-white/50">{member.email}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 space-y-5">
          {/* Refund permission — global, and deliberately the first thing in
              this modal. It is the only switch here that can move real money. */}
          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">Refunds</h4>
            <button
              onClick={() => setRefundPermission.mutate(!member.canIssueRefunds)}
              disabled={setRefundPermission.isPending}
              className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-colors disabled:opacity-50 ${
                member.canIssueRefunds
                  ? "bg-amber-500/[0.07] border-amber-500/25 hover:border-amber-500/40"
                  : "bg-white/[0.02] border-white/[0.07] hover:border-white/15"
              }`}
              data-testid="button-toggle-refund-permission"
            >
              <div className={`mt-0.5 w-9 h-5 rounded-full shrink-0 transition-colors relative ${
                member.canIssueRefunds ? "bg-amber-500/70" : "bg-white/10"
              }`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${
                  member.canIssueRefunds ? "left-[18px]" : "left-0.5"
                }`} />
              </div>
              <div className="min-w-0">
                <p className="text-sm text-white/85 font-medium">
                  {member.canIssueRefunds ? "Can issue refunds" : "Cannot issue refunds"}
                </p>
                <p className="text-[11px] text-white/45 mt-0.5 leading-relaxed">
                  {member.canIssueRefunds
                    ? "Can send money back to a customer's card, in any workspace they can reach. Every refund records their name, the amount and the time."
                    : "Turn this on only for people who should be able to send money back to a customer's card. It is separate from their role on purpose — no workspace role grants it."}
                </p>
              </div>
            </button>
          </div>

          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">Current workspace access</h4>
            {member.memberships.length === 0 ? (
              <div className="p-4 rounded-lg bg-amber-500/5 border border-amber-500/20 text-sm text-amber-300">
                <AlertCircle className="w-4 h-4 inline-block mr-2" />
                No workspaces — they can log in but won't see anything. Add at least one below.
              </div>
            ) : (
              <div className="space-y-2">
                {member.memberships.map(m => {
                  const allTabs = tabsForOrgSlug(m.orgSlug);
                  const fullAccessRole = m.role === "admin" || m.role === "manager";
                  const currentTabs: string[] = m.tabs ?? [];
                  const isLegacy = m.tabs === null && !fullAccessRole;
                  // Only worth showing where the Hiring tab is reachable at all:
                  // via the whitelist, or via a role/legacy state that grants
                  // every tab in this workspace.
                  const hasHiring =
                    allTabs.some((t: TabDef) => t.slug === "hiring") &&
                    (fullAccessRole || isLegacy || currentTabs.includes("hiring"));
                  return (
                    <div key={m.orgId} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
                      <div className="flex items-center gap-3">
                        <Building2 className="w-4 h-4 text-white/40" />
                        <div className="flex-1 text-sm text-white">{m.orgName}</div>
                        <select
                          value={m.role}
                          onChange={e => updateMembership.mutate({ orgId: m.orgId, role: e.target.value })}
                          className="bg-white/[0.04] border border-white/10 text-white/80 text-xs rounded-md px-2 py-1"
                        >
                          {WORKSPACE_ROLES.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            if (confirm(`Remove ${member.firstName} from ${m.orgName}?`)) removeMembership.mutate(m.orgId);
                          }}
                          className="text-red-400/70 hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="rounded-md bg-black/20 border border-white/[0.06] p-2.5">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] uppercase tracking-wider font-semibold text-white/50">Tab access</p>
                          {!fullAccessRole && (
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => updateMembership.mutate({ orgId: m.orgId, tabs: allTabs.map((t: TabDef) => t.slug) })}
                                className="text-[10px] text-blue-400 hover:text-blue-300"
                              >
                                All
                              </button>
                              <button
                                type="button"
                                onClick={() => updateMembership.mutate({ orgId: m.orgId, tabs: [] })}
                                className="text-[10px] text-white/40 hover:text-white/60"
                              >
                                None
                              </button>
                            </div>
                          )}
                        </div>
                        {fullAccessRole ? (
                          <p className="text-[11px] text-amber-300/70">
                            {m.role === "admin" ? "Admin" : "Manager"} role grants full access to all tabs.
                          </p>
                        ) : isLegacy ? (
                          <div className="flex items-center gap-2">
                            <p className="text-[11px] text-amber-300/80 flex-1">
                              Currently has <strong>full access</strong> (legacy — no scope set). Click "All" to lock in, or pick specific tabs below.
                            </p>
                            <button
                              type="button"
                              onClick={() => updateMembership.mutate({ orgId: m.orgId, tabs: [] })}
                              className="text-[10px] text-blue-400 hover:text-blue-300"
                            >
                              Scope down
                            </button>
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-1">
                            {allTabs.map((tab: TabDef) => {
                              const checked = currentTabs.includes(tab.slug);
                              return (
                                <label
                                  key={tab.slug}
                                  className={`flex items-center gap-2 px-2 py-1 rounded text-[11px] cursor-pointer transition ${
                                    checked ? "bg-blue-500/10 text-white" : "text-white/50 hover:bg-white/[0.04]"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      const nextTabs = e.target.checked
                                        ? [...currentTabs, tab.slug]
                                        : currentTabs.filter(t => t !== tab.slug);
                                      updateMembership.mutate({ orgId: m.orgId, tabs: nextTabs });
                                    }}
                                  />
                                  <span className="flex-1 truncate">{tab.title}</span>
                                  {tab.secondary && <span className="text-[8px] text-white/30 uppercase">admin</span>}
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>
                      {hasHiring && (
                        <HiringBrandScope
                          brands={knownBrands}
                          value={m.hiringBrands}
                          onChange={(next) => updateMembership.mutate({ orgId: m.orgId, hiringBrands: next })}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {availableOrgs.length > 0 && (
            <div>
              <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3">Add to workspace</h4>
              <div className="space-y-2">
                {availableOrgs.map(org => (
                  <button
                    key={org.id}
                    onClick={() => addMembership.mutate({ orgId: org.id, role: "team_member", tabs: [] })}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] p-3 flex items-center gap-3 text-left"
                  >
                    <Building2 className="w-4 h-4 text-white/40" />
                    <div className="flex-1 text-sm text-white">{org.name}</div>
                    <span className="text-xs text-blue-400">+ Add (no tabs yet)</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Security — super-admin only password actions */}
          <div>
            <h4 className="text-xs uppercase tracking-wider font-semibold text-white/40 mb-3 flex items-center gap-2">
              <Shield className="w-3.5 h-3.5" /> Security
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Button
                onClick={() => {
                  if (confirm(`Reset ${member.firstName}'s password? They'll get an email with the new credentials.`)) {
                    resetPassword.mutate();
                  }
                }}
                disabled={resetPassword.isPending || resendInvite.isPending}
                variant="outline"
                className="border-white/10 hover:bg-white/[0.06]"
              >
                <KeyRound className="w-4 h-4 mr-1.5" />
                {resetPassword.isPending ? "Resetting..." : "Reset password"}
              </Button>
              <Button
                onClick={() => {
                  if (confirm(`Resend the welcome invite to ${member.email}? A fresh temp password will be generated and emailed.`)) {
                    resendInvite.mutate();
                  }
                }}
                disabled={resetPassword.isPending || resendInvite.isPending}
                variant="outline"
                className="border-white/10 hover:bg-white/[0.06]"
              >
                <Mail className="w-4 h-4 mr-1.5" />
                {resendInvite.isPending ? "Sending..." : "Resend invite"}
              </Button>
            </div>

            {revealedPassword && (
              <div className="mt-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold text-emerald-300">
                    {emailFlag ? "✉ Email sent" : "⚠ Email failed — share manually"}
                  </div>
                  <button
                    onClick={() => setRevealedPassword(null)}
                    className="text-emerald-300/40 hover:text-emerald-300"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono text-emerald-200 px-2 py-1.5 rounded bg-black/20">{revealedPassword}</code>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(revealedPassword);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    className="px-2 py-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-[10px] text-emerald-300/60 mt-2">
                  This password is shown once — copy it now. You won't see it again unless you reset.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AdminTeam() {
  const { organizations: orgs } = useWorkspace();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);

  const { data: team = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/admin/team"],
    queryFn: () => fetch("/api/admin/team", { credentials: "include" }).then(r => r.json()),
  });

  const deactivate = useMutation({
    mutationFn: async (userId: number) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${userId}`, { active: false });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/team"] });
      toast({ title: "Deactivated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't deactivate", description: e.message, variant: "destructive" }),
  });

  const filtered = team.filter(t =>
    !search ||
    t.email.toLowerCase().includes(search.toLowerCase()) ||
    `${t.firstName} ${t.lastName}`.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Users className="w-6 h-6 text-white/60" /> Team
          </h1>
          <p className="text-sm text-white/40 mt-0.5">
            Everyone with access to ClubOS, and which workspaces they can see.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
            <Input
              placeholder="Search by name or email..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-10 bg-white/[0.02] border-white/10 text-white w-64"
            />
          </div>
          <Button onClick={() => setShowAdd(true)} className="bg-blue-600 hover:bg-blue-700">
            <UserPlus className="w-4 h-4 mr-1.5" /> Add team member
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-white/40 text-sm">Loading team...</div>
      ) : (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left px-4 py-3 text-[10px] uppercase tracking-wider text-white/40">Name</th>
                <th className="text-left px-4 py-3 text-[10px] uppercase tracking-wider text-white/40">Workspaces</th>
                <th className="text-left px-4 py-3 text-[10px] uppercase tracking-wider text-white/40">Global role</th>
                <th className="text-left px-4 py-3 text-[10px] uppercase tracking-wider text-white/40">Status</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] cursor-pointer" onClick={() => setEditingMember(t)}>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-white">{t.firstName} {t.lastName}</div>
                    <div className="text-xs text-white/40">{t.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    {t.memberships.length === 0 ? (
                      <span className="text-xs text-amber-400">No workspaces</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {t.memberships.map(m => (
                          <span
                            key={m.orgId}
                            className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white/[0.05] text-white/70"
                          >
                            {m.orgName} · {m.role}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                        t.globalRole === "super_admin"
                          ? "bg-purple-500/15 text-purple-400"
                          : "bg-white/[0.05] text-white/60"
                      }`}>
                        {t.globalRole === "super_admin" ? "Super Admin" : t.globalRole}
                      </span>
                      {/* Who can move money, visible without opening anyone. */}
                      {t.canIssueRefunds && (
                        <span
                          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/15 text-amber-400"
                          title="Can issue refunds"
                          data-testid={`badge-refunds-${t.id}`}
                        >
                          Refunds
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
                      t.active ? "bg-emerald-500/15 text-emerald-400" : "bg-zinc-500/15 text-zinc-400"
                    }`}>
                      {t.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <ChevronRight className="w-4 h-4 text-white/30" />
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-white/30 text-sm">
                    {search ? "No matches" : "No team members yet — add the first one to get started."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <AddMemberModal open={showAdd} onClose={() => setShowAdd(false)} organizations={orgs} />
      <ManageMembershipsModal
        open={!!editingMember}
        onClose={() => setEditingMember(null)}
        member={editingMember}
        organizations={orgs}
        key={editingMember?.id ?? "none"}
      />
    </div>
  );
}

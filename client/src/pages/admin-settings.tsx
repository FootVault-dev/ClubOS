import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Save, Users, Settings, Plus, Trash2, X, Shield, ShieldCheck, UserCog, User, Pencil, Key, Copy, Check, Eye, EyeOff, ExternalLink, RefreshCw, Activity } from "lucide-react";
import { API_SCOPES } from "@shared/api-scopes";

type UserAccount = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  active: boolean;
  createdAt: string;
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  team_member: "Team Member",
  manager: "Manager",
  coach: "Coach",
  finance: "Finance",
  marketing: "Marketing",
  registrar: "Registrar",
};

const ROLE_OPTIONS = ["super_admin", "admin", "team_member"];

const ROLE_COLORS: Record<string, string> = {
  super_admin: "border-amber-500/25 text-amber-400/80 bg-amber-500/10",
  admin: "border-blue-500/25 text-blue-400/80 bg-blue-500/10",
  team_member: "border-white/15 text-white/50 bg-white/5",
  manager: "border-purple-500/25 text-purple-400/80 bg-purple-500/10",
  coach: "border-green-500/25 text-green-400/80 bg-green-500/10",
  finance: "border-emerald-500/25 text-emerald-400/80 bg-emerald-500/10",
  marketing: "border-pink-500/25 text-pink-400/80 bg-pink-500/10",
  registrar: "border-cyan-500/25 text-cyan-400/80 bg-cyan-500/10",
};

function ProfileTab() {
  const { toast } = useToast();
  const { data: me, isLoading } = useQuery<UserAccount>({ queryKey: ["/api/auth/me"] });
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (me && !loaded) {
      setFirstName(me.firstName);
      setLastName(me.lastName);
      setLoaded(true);
    }
  }, [me, loaded]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", "/api/auth/me", { firstName, lastName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const hasChanges = loaded && (firstName !== me?.firstName || lastName !== me?.lastName);

  return (
    <div className="space-y-4 animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
      {isLoading ? (
        <div className="rounded-2xl glass-card p-6 space-y-3">
          <Skeleton className="h-5 w-24 rounded bg-blue-500/[0.04]" />
          <Skeleton className="h-9 w-full rounded-xl bg-blue-500/[0.04]" />
          <Skeleton className="h-9 w-full rounded-xl bg-blue-500/[0.04]" />
        </div>
      ) : (
        <div className="rounded-2xl glass-card p-6 space-y-4">
          <div className="flex items-center gap-3 pb-3 border-b border-blue-500/[0.06]">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/15 flex items-center justify-center">
              <User className="w-5 h-5 text-blue-400/70" />
            </div>
            <div>
              <p className="text-[14px] font-medium text-white/80" data-testid="text-profile-name">{me?.firstName} {me?.lastName}</p>
              <p className="text-[11px] text-white/25">{me?.email}</p>
            </div>
            <Badge variant="outline" className={`ml-auto text-[9px] px-1.5 py-0.5 ${ROLE_COLORS[me?.role || "team_member"]}`}>
              {ROLE_LABELS[me?.role || "team_member"] || me?.role}
            </Badge>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">First Name</label>
              <Input
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-profile-first-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Last Name</label>
              <Input
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-profile-last-name"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Email</label>
            <Input value={me?.email || ""} disabled className="premium-input text-white/40 rounded-xl opacity-50" data-testid="input-profile-email" />
            <p className="text-[10px] text-white/15">Email cannot be changed</p>
          </div>

          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending}
            className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn"
            data-testid="button-save-profile"
          >
            <Save className="w-4 h-4 mr-1.5" /> {saveMutation.isPending ? "Saving..." : "Save Profile"}
          </Button>
        </div>
      )}
    </div>
  );
}

function GeneralTab() {
  const { data: settingsData, isLoading } = useQuery<Record<string, string>>({ queryKey: ["/api/admin/settings"] });
  const { toast } = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (settingsData && !loaded) {
      setValues(settingsData);
      setLoaded(true);
    }
  }, [settingsData, loaded]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PUT", "/api/admin/settings", values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const fields = [
    { key: "club_name", label: "Club Name" },
    { key: "club_short_name", label: "Short Name" },
    { key: "club_email", label: "Club Email" },
    { key: "club_phone", label: "Club Phone" },
    { key: "club_website", label: "Website" },
    { key: "club_address", label: "Address" },
    { key: "club_timezone", label: "Timezone" },
  ];

  return (
    <div className="rounded-2xl glass-card p-6 animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl bg-blue-500/[0.04]" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {fields.map(f => (
            <div key={f.key} className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">{f.label}</label>
              <Input
                value={values[f.key] || ""}
                onChange={e => setValues({ ...values, [f.key]: e.target.value })}
                className="premium-input text-white/80 rounded-xl"
                data-testid={`input-${f.key}`}
              />
            </div>
          ))}
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn" data-testid="button-save-settings">
            <Save className="w-4 h-4 mr-1.5" /> Save Settings
          </Button>
        </div>
      )}
    </div>
  );
}

function UsersTab() {
  const { toast } = useToast();
  const { data: currentUser } = useQuery<{ id: number; role: string }>({ queryKey: ["/api/auth/me"] });
  const { data: allUsers, isLoading } = useQuery<UserAccount[]>({
    queryKey: ["/api/admin/users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) {
        if (res.status === 403) throw new Error("Super Admin access required");
        throw new Error("Failed to load users");
      }
      return res.json();
    },
  });

  const [showAddModal, setShowAddModal] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) => apiRequest("PATCH", `/api/admin/users/${id}`, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Role updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setDeleteConfirm(null);
      toast({ title: "User deleted" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (currentUser?.role !== "super_admin") {
    return (
      <div className="rounded-2xl glass-card p-8 text-center animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
        <Shield className="w-10 h-10 text-white/10 mx-auto mb-3" />
        <p className="text-[13px] text-white/40">Super Admin access required to manage users</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-white/40">{allUsers?.length || 0} staff account{(allUsers?.length || 0) !== 1 ? "s" : ""}</p>
        <Button
          onClick={() => setShowAddModal(true)}
          className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn"
          data-testid="button-add-user"
        >
          <Plus className="w-4 h-4 mr-1" /> Add User
        </Button>
      </div>

      <div className="rounded-2xl glass-card overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl bg-blue-500/[0.04]" />)}
          </div>
        ) : allUsers && allUsers.length > 0 ? (
          <div className="divide-y divide-blue-500/[0.04]">
            {allUsers.map(user => (
              <div key={user.id} className="flex items-center gap-4 px-5 py-3.5" data-testid={`row-user-${user.id}`}>
                <div className="w-9 h-9 rounded-xl bg-blue-500/8 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
                  {user.role === "super_admin" ? (
                    <ShieldCheck className="w-4 h-4 text-amber-400/70" />
                  ) : user.role === "admin" ? (
                    <UserCog className="w-4 h-4 text-blue-400/70" />
                  ) : (
                    <Users className="w-4 h-4 text-white/30" />
                  )}
                </div>
                <div
                  className="flex-1 min-w-0 cursor-pointer group/name"
                  onClick={() => setEditingUser(user)}
                >
                  <p className="text-[13px] font-medium text-white/75 truncate group-hover/name:text-blue-400 transition-colors flex items-center gap-1.5" data-testid={`text-user-name-${user.id}`}>
                    {user.firstName} {user.lastName}
                    <Pencil className="w-3 h-3 text-white/0 group-hover/name:text-blue-400/50 transition-colors" />
                  </p>
                  <p className="text-[11px] text-white/25 truncate">{user.email}</p>
                </div>
                <select
                  value={user.role}
                  onChange={e => updateRoleMutation.mutate({ id: user.id, role: e.target.value })}
                  disabled={user.id === currentUser?.id}
                  className="h-8 px-2 rounded-lg bg-white/[0.03] border border-white/[0.08] text-[12px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  data-testid={`select-role-${user.id}`}
                >
                  {ROLE_OPTIONS.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
                <Badge variant="outline" className={`text-[9px] px-1.5 py-0.5 ${ROLE_COLORS[user.role] || ROLE_COLORS.team_member}`} data-testid={`badge-role-${user.id}`}>
                  {ROLE_LABELS[user.role] || user.role}
                </Badge>
                {user.id !== currentUser?.id ? (
                  deleteConfirm === user.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => deleteMutation.mutate(user.id)}
                        className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1 rounded-lg hover:bg-red-500/10 transition-colors cursor-pointer"
                        data-testid={`button-confirm-delete-user-${user.id}`}
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="text-[10px] text-white/30 hover:text-white/50 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                        data-testid={`button-cancel-delete-user-${user.id}`}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteConfirm(user.id)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer"
                      data-testid={`button-delete-user-${user.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-white/20 hover:text-red-400" />
                    </button>
                  )
                ) : (
                  <span className="text-[10px] text-white/15 italic w-7 text-center">You</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-white/25 text-center py-8">No users found</p>
        )}
      </div>

      {showAddModal && <AddUserModal onClose={() => setShowAddModal(false)} />}
      {editingUser && <EditUserModal user={editingUser} onClose={() => setEditingUser(null)} />}
    </div>
  );
}

function EditUserModal({ user, onClose }: { user: UserAccount; onClose: () => void }) {
  const { toast } = useToast();
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest("PATCH", `/api/admin/users/${user.id}`, { firstName, lastName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "User profile updated" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const hasChanges = firstName !== user.firstName || lastName !== user.lastName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="modal-edit-user">
        <div className="flex items-center justify-between px-6 py-4 border-b border-blue-500/10">
          <h2 className="text-[15px] font-semibold text-white/80">Edit Profile</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors cursor-pointer" data-testid="button-close-edit-user">
            <X className="w-4 h-4 text-white/40" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="flex items-center gap-3 pb-3 border-b border-blue-500/[0.06]">
            <div className="w-9 h-9 rounded-xl bg-blue-500/8 border border-blue-500/15 flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-blue-400/60" />
            </div>
            <div>
              <p className="text-[12px] text-white/40">{user.email}</p>
              <Badge variant="outline" className={`text-[9px] px-1.5 py-0.5 mt-0.5 ${ROLE_COLORS[user.role] || ROLE_COLORS.team_member}`}>
                {ROLE_LABELS[user.role] || user.role}
              </Badge>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">First Name</label>
              <Input
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-edit-first-name"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Last Name</label>
              <Input
                value={lastName}
                onChange={e => setLastName(e.target.value)}
                className="premium-input text-white/80 rounded-xl"
                data-testid="input-edit-last-name"
              />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-blue-500/10">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-9 text-[13px] border-white/10 text-white/50 hover:bg-white/5" data-testid="button-cancel-edit-user">
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!hasChanges || saveMutation.isPending}
            className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn"
            data-testid="button-save-edit-user"
          >
            {saveMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddUserModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", password: "", role: "team_member" });

  const createMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/admin/users", form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User created" });
      onClose();
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const canSubmit = form.firstName && form.lastName && form.email && form.password;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-blue-500/15 rounded-2xl w-full max-w-md mx-4 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="modal-add-user">
        <div className="flex items-center justify-between px-6 py-4 border-b border-blue-500/10">
          <h2 className="text-[15px] font-semibold text-white/80">Add New User</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors cursor-pointer" data-testid="button-close-add-user">
            <X className="w-4 h-4 text-white/40" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">First Name</label>
              <Input value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value })} className="premium-input text-white/80 rounded-xl" data-testid="input-new-first-name" />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Last Name</label>
              <Input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value })} className="premium-input text-white/80 rounded-xl" data-testid="input-new-last-name" />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Email</label>
            <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className="premium-input text-white/80 rounded-xl" data-testid="input-new-email" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Password</label>
            <Input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} className="premium-input text-white/80 rounded-xl" data-testid="input-new-password" />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-blue-300/25 uppercase tracking-wider font-semibold">Role</label>
            <select
              value={form.role}
              onChange={e => setForm({ ...form, role: e.target.value })}
              className="w-full h-9 px-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[13px] text-white/70 focus:outline-none focus:border-blue-500/30 cursor-pointer"
              data-testid="select-new-role"
            >
              {ROLE_OPTIONS.map(r => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-blue-500/10">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-9 text-[13px] border-white/10 text-white/50 hover:bg-white/5" data-testid="button-cancel-add-user">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!canSubmit || createMutation.isPending}
            className="bg-gradient-to-r from-blue-500 to-blue-600 text-white border-0 rounded-xl h-9 text-[13px] glow-btn"
            data-testid="button-save-new-user"
          >
            {createMutation.isPending ? "Creating..." : "Create User"}
          </Button>
        </div>
      </div>
    </div>
  );
}

type ApiKeyData = {
  id: number;
  name: string;
  keyPrefix: string;
  organizationId: number;
  allowedOrgIds: number[] | null;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  rotatedFromId: number | null;
  usage24h: number;
  usage7d: number;
  denied7d: number;
};

type ApiKeyLogRow = {
  id: number;
  method: string;
  path: string;
  status: number | null;
  ip: string | null;
  createdAt: string;
};

type OrgOption = { id: number; name: string; slug: string };

function ApiKeysTab() {
  const { toast } = useToast();
  const { data: keys, isLoading } = useQuery<ApiKeyData[]>({ queryKey: ["/api/admin/api-keys"] });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<number | null>(null);
  const [showDocs, setShowDocs] = useState(false);

  const [rotateConfirm, setRotateConfirm] = useState<number | null>(null);
  const [activityKeyId, setActivityKeyId] = useState<number | null>(null);

  const revokeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/api-keys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
      setRevokeConfirm(null);
      toast({ title: "API key revoked" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const rotateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/admin/api-keys/${id}/rotate`, {});
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
      setRotateConfirm(null);
      setNewKeyValue(data.key);
      toast({ title: "Key rotated", description: "The old key keeps working for 72 hours — swap it in the connected system any time before then." });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const activeKeys = keys?.filter(k => k.active) || [];
  const revokedKeys = keys?.filter(k => !k.active) || [];

  return (
    <div className="space-y-4 animate-fade-in-up" style={{ animationDelay: '100ms', opacity: 0 }}>
      <div className="rounded-2xl glass-card p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/15 flex items-center justify-center flex-shrink-0">
            <Key className="w-5 h-5 text-amber-400/70" />
          </div>
          <div className="flex-1">
            <h3 className="text-[14px] font-medium text-white/80">External API Access</h3>
            <p className="text-[12px] text-white/35 mt-1">
              Generate API keys to connect ClubOS with your AIOS or other external systems. Pull revenue, analytics, registrations, customer data, and split test results programmatically.
            </p>
          </div>
          <Button
            onClick={() => setShowDocs(!showDocs)}
            variant="outline"
            className="rounded-xl h-8 text-[12px] border-white/10 text-white/40 hover:bg-white/5 flex-shrink-0"
            data-testid="button-toggle-api-docs"
          >
            <ExternalLink className="w-3.5 h-3.5 mr-1" /> API Docs
          </Button>
        </div>
      </div>

      {showDocs && <ApiDocsPanel />}

      <div className="flex items-center justify-between">
        <p className="text-[13px] text-white/40">{activeKeys.length} active key{activeKeys.length !== 1 ? "s" : ""}</p>
        <Button
          onClick={() => setShowCreateModal(true)}
          className="bg-gradient-to-r from-amber-500 to-amber-600 text-black border-0 rounded-xl h-9 text-[13px] font-semibold"
          data-testid="button-create-api-key"
        >
          <Plus className="w-4 h-4 mr-1" /> Generate API Key
        </Button>
      </div>

      <div className="rounded-2xl glass-card overflow-hidden">
        {isLoading ? (
          <div className="p-6 space-y-3">
            {[1, 2].map(i => <Skeleton key={i} className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />)}
          </div>
        ) : activeKeys.length === 0 ? (
          <div className="p-8 text-center">
            <Key className="w-10 h-10 text-white/10 mx-auto mb-3" />
            <p className="text-[13px] text-white/40">No API keys yet</p>
            <p className="text-[11px] text-white/20 mt-1">Generate a key to connect ClubOS with external systems</p>
          </div>
        ) : (
          <div className="divide-y divide-blue-500/[0.04]">
            {activeKeys.map(key => (
              <div key={key.id}>
                <div className="flex items-center gap-4 px-5 py-3.5" data-testid={`row-api-key-${key.id}`}>
                  <div className="w-9 h-9 rounded-xl bg-amber-500/8 border border-amber-500/15 flex items-center justify-center flex-shrink-0">
                    <Key className="w-4 h-4 text-amber-400/70" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-white/75 truncate" data-testid={`text-key-name-${key.id}`}>{key.name}</p>
                    <p className="text-[11px] text-white/25 font-mono">{key.keyPrefix}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-[10px] text-white/30">
                      {key.usage7d > 0 ? `${key.usage7d.toLocaleString()} reqs (7d)` : "No requests (7d)"}
                      {key.denied7d > 0 && <span className="text-red-400/60"> · {key.denied7d} denied</span>}
                    </p>
                    <p className="text-[10px] text-white/20">
                      {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "Never used"}
                    </p>
                    {key.expiresAt && (
                      <p className="text-[10px] text-amber-400/40">Expires {new Date(key.expiresAt).toLocaleDateString()}</p>
                    )}
                  </div>
                  <div className="hidden md:flex items-center gap-1 max-w-[260px] flex-wrap justify-end">
                    {key.scopes.map(s => (
                      <Badge key={s} variant="outline" className="text-[9px] px-1.5 py-0.5 border-amber-500/20 text-amber-400/60 bg-amber-500/5">
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <button
                    onClick={() => setActivityKeyId(activityKeyId === key.id ? null : key.id)}
                    className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${activityKeyId === key.id ? "bg-amber-500/15" : "hover:bg-white/5"}`}
                    title="View recent activity"
                    data-testid={`button-activity-${key.id}`}
                  >
                    <Activity className={`w-3.5 h-3.5 ${activityKeyId === key.id ? "text-amber-400/80" : "text-white/20 hover:text-amber-400/60"}`} />
                  </button>
                  {rotateConfirm === key.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => rotateMutation.mutate(key.id)}
                        disabled={rotateMutation.isPending}
                        className="text-[10px] text-amber-400 hover:text-amber-300 px-2 py-1 rounded-lg hover:bg-amber-500/10 transition-colors cursor-pointer"
                        data-testid={`button-confirm-rotate-${key.id}`}
                      >
                        {rotateMutation.isPending ? "Rotating..." : "Rotate now"}
                      </button>
                      <button
                        onClick={() => setRotateConfirm(null)}
                        className="text-[10px] text-white/30 hover:text-white/50 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRotateConfirm(key.id)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-amber-500/10 transition-colors cursor-pointer"
                      title="Rotate key (old key keeps working for 72h)"
                      data-testid={`button-rotate-${key.id}`}
                    >
                      <RefreshCw className="w-3.5 h-3.5 text-white/20 hover:text-amber-400" />
                    </button>
                  )}
                  {revokeConfirm === key.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => revokeMutation.mutate(key.id)}
                        className="text-[10px] text-red-400 hover:text-red-300 px-2 py-1 rounded-lg hover:bg-red-500/10 transition-colors cursor-pointer"
                        data-testid={`button-confirm-revoke-${key.id}`}
                      >
                        Revoke
                      </button>
                      <button
                        onClick={() => setRevokeConfirm(null)}
                        className="text-[10px] text-white/30 hover:text-white/50 px-2 py-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRevokeConfirm(key.id)}
                      className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-red-500/10 transition-colors cursor-pointer"
                      data-testid={`button-revoke-${key.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-white/20 hover:text-red-400" />
                    </button>
                  )}
                </div>
                {activityKeyId === key.id && <KeyActivityPanel keyId={key.id} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {revokedKeys.length > 0 && (
        <details className="group">
          <summary className="text-[12px] text-white/20 cursor-pointer hover:text-white/40 transition-colors">
            {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? "s" : ""}
          </summary>
          <div className="rounded-2xl glass-card overflow-hidden mt-2 opacity-50">
            <div className="divide-y divide-blue-500/[0.04]">
              {revokedKeys.map(key => (
                <div key={key.id} className="flex items-center gap-4 px-5 py-3">
                  <Key className="w-4 h-4 text-white/15" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-white/30 truncate line-through">{key.name}</p>
                    <p className="text-[11px] text-white/15 font-mono">{key.keyPrefix}</p>
                  </div>
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 border-red-500/20 text-red-400/40">revoked</Badge>
                </div>
              ))}
            </div>
          </div>
        </details>
      )}

      {showCreateModal && (
        <CreateApiKeyModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(key) => { setShowCreateModal(false); setNewKeyValue(key); }}
        />
      )}
      {newKeyValue && (
        <NewKeyRevealModal keyValue={newKeyValue} onClose={() => setNewKeyValue(null)} />
      )}
    </div>
  );
}

function KeyActivityPanel({ keyId }: { keyId: number }) {
  const { data: logs, isLoading } = useQuery<ApiKeyLogRow[]>({
    queryKey: [`/api/admin/api-keys/${keyId}/logs?limit=15`],
  });

  return (
    <div className="px-5 pb-4 bg-black/20">
      <p className="text-[10px] text-amber-300/30 uppercase tracking-wider font-semibold pt-3 pb-2">Recent requests (audit log)</p>
      {isLoading ? (
        <Skeleton className="h-16 w-full rounded-xl bg-blue-500/[0.04]" />
      ) : !logs || logs.length === 0 ? (
        <p className="text-[11px] text-white/25">No requests recorded yet.</p>
      ) : (
        <div className="space-y-1">
          {logs.map(l => (
            <div key={l.id} className="flex items-center gap-3 text-[11px] font-mono">
              <span className={`w-9 flex-shrink-0 ${l.status && l.status >= 400 ? "text-red-400/70" : "text-emerald-400/60"}`}>{l.status ?? "—"}</span>
              <span className="text-white/25 w-10 flex-shrink-0">{l.method}</span>
              <span className="text-white/45 truncate flex-1">{l.path}</span>
              <span className="text-white/20 flex-shrink-0">{new Date(l.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateApiKeyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [expiresInDays, setExpiresInDays] = useState<string>("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [selectedOrgIds, setSelectedOrgIds] = useState<number[]>([]);
  const { data: orgs } = useQuery<OrgOption[]>({ queryKey: ["/api/admin/organizations"] });

  const toggleScope = (scope: string) =>
    setSelectedScopes(prev => prev.includes(scope) ? prev.filter(s => s !== scope) : [...prev, scope]);
  const toggleOrg = (id: number) =>
    setSelectedOrgIds(prev => prev.includes(id) ? prev.filter(o => o !== id) : [...prev, id]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        name,
        organizationId: selectedOrgIds[0],
        allowedOrgIds: selectedOrgIds,
        scopes: selectedScopes,
      };
      if (expiresInDays) body.expiresInDays = parseInt(expiresInDays);
      const res = await apiRequest("POST", "/api/admin/api-keys", body);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/api-keys"] });
      toast({ title: "API key created" });
      onCreated(data.key);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/15 rounded-2xl w-full max-w-lg mx-4 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()} data-testid="modal-create-api-key">
        <div className="flex items-center justify-between px-6 py-4 border-b border-amber-500/10">
          <h2 className="text-[15px] font-semibold text-white/80">Generate API Key</h2>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-white/5 transition-colors cursor-pointer">
            <X className="w-4 h-4 text-white/40" />
          </button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-amber-300/30 uppercase tracking-wider font-semibold">Key Name</label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Isaac AIOS — CIC + MFL"
              className="premium-input text-white/80 rounded-xl"
              data-testid="input-api-key-name"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-amber-300/30 uppercase tracking-wider font-semibold">Workspaces</label>
            <p className="text-[11px] text-white/25">The key can only read data belonging to these workspaces.</p>
            <div className="grid grid-cols-2 gap-1.5">
              {(orgs || []).map(org => (
                <button
                  key={org.id}
                  onClick={() => toggleOrg(org.id)}
                  className={`text-left px-3 py-2 rounded-xl border text-[12px] transition-colors cursor-pointer ${
                    selectedOrgIds.includes(org.id)
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-200/80"
                      : "border-white/8 bg-white/[0.02] text-white/40 hover:bg-white/5"
                  }`}
                  data-testid={`toggle-org-${org.id}`}
                >
                  {org.name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-amber-300/30 uppercase tracking-wider font-semibold">Scopes</label>
            <p className="text-[11px] text-white/25">Least privilege — grant only what the connected system needs.</p>
            <div className="space-y-1.5">
              {API_SCOPES.map(s => (
                <button
                  key={s.scope}
                  onClick={() => toggleScope(s.scope)}
                  className={`w-full text-left px-3 py-2 rounded-xl border transition-colors cursor-pointer ${
                    selectedScopes.includes(s.scope)
                      ? "border-amber-500/40 bg-amber-500/10"
                      : "border-white/8 bg-white/[0.02] hover:bg-white/5"
                  }`}
                  data-testid={`toggle-scope-${s.scope}`}
                >
                  <span className={`text-[12px] font-medium ${selectedScopes.includes(s.scope) ? "text-amber-200/80" : "text-white/50"}`}>
                    {s.label} <span className="font-mono text-[10px] opacity-60">{s.scope}</span>
                  </span>
                  <span className="block text-[10px] text-white/25 mt-0.5">{s.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-amber-300/30 uppercase tracking-wider font-semibold">Expires In (Days)</label>
            <Input
              type="number"
              value={expiresInDays}
              onChange={e => setExpiresInDays(e.target.value)}
              placeholder="Leave empty for no expiry"
              className="premium-input text-white/80 rounded-xl"
              data-testid="input-api-key-expiry"
            />
          </div>
          <div className="rounded-xl bg-amber-500/5 border border-amber-500/10 p-3">
            <p className="text-[11px] text-amber-400/60">
              Read-only. Every request this key makes is audit-logged and rate-limited. Sponsorship, budget, inbox, e-sign and payment data are never accessible via API keys.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-amber-500/10">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-9 text-[13px] border-white/10 text-white/50 hover:bg-white/5">
            Cancel
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!name || selectedScopes.length === 0 || selectedOrgIds.length === 0 || createMutation.isPending}
            className="bg-gradient-to-r from-amber-500 to-amber-600 text-black border-0 rounded-xl h-9 text-[13px] font-semibold"
            data-testid="button-generate-key"
          >
            {createMutation.isPending ? "Generating..." : "Generate Key"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewKeyRevealModal({ keyValue, onClose }: { keyValue: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [showFull, setShowFull] = useState(false);

  const copyKey = () => {
    navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#0a0e1a] border border-amber-500/20 rounded-2xl w-full max-w-lg mx-4 shadow-2xl" onClick={e => e.stopPropagation()} data-testid="modal-reveal-key">
        <div className="px-6 py-4 border-b border-amber-500/10">
          <h2 className="text-[15px] font-semibold text-amber-400/80">Your API Key</h2>
          <p className="text-[12px] text-red-400/60 mt-1">Copy this now — it will not be shown again</p>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="relative">
            <div className="rounded-xl bg-black/40 border border-amber-500/15 p-4 font-mono text-[12px] text-amber-300/80 break-all select-all">
              {showFull ? keyValue : keyValue.slice(0, 12) + "•".repeat(40) + keyValue.slice(-8)}
            </div>
            <div className="absolute top-2 right-2 flex gap-1">
              <button
                onClick={() => setShowFull(!showFull)}
                className="w-7 h-7 rounded-lg flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                data-testid="button-toggle-key-visibility"
              >
                {showFull ? <EyeOff className="w-3.5 h-3.5 text-white/40" /> : <Eye className="w-3.5 h-3.5 text-white/40" />}
              </button>
              <button
                onClick={copyKey}
                className="w-7 h-7 rounded-lg flex items-center justify-center bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                data-testid="button-copy-key"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5 text-white/40" />}
              </button>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end px-6 py-4 border-t border-amber-500/10">
          <Button
            onClick={onClose}
            className="bg-gradient-to-r from-amber-500 to-amber-600 text-black border-0 rounded-xl h-9 text-[13px] font-semibold"
            data-testid="button-close-key-reveal"
          >
            I've Copied My Key
          </Button>
        </div>
      </div>
    </div>
  );
}

function ApiDocsPanel() {
  const baseUrl = window.location.origin;

  const endpoints = [
    { method: "GET", path: "/api/v1/overview", desc: "High-level summary: revenue, registrations, analytics, conversion rate", params: "?days=30" },
    { method: "GET", path: "/api/v1/revenue", desc: "Revenue breakdown per camp with registration counts and AOV", params: "?days=30" },
    { method: "GET", path: "/api/v1/analytics", desc: "Page views, sessions, devices, sources, daily trends, funnel metrics", params: "?days=30&camp=slug" },
    { method: "GET", path: "/api/v1/customers", desc: "Customer list with lifetime value, order count, last order date", params: "?limit=50&offset=0" },
    { method: "GET", path: "/api/v1/camps", desc: "All camps/programs with occupancy, revenue, registrations", params: "" },
    { method: "GET", path: "/api/v1/split-tests", desc: "A/B test results: variants, views, registrations, conversion rates, winners", params: "" },
    { method: "GET", path: "/api/v1/registrations", desc: "Recent registrations with contact info, camp details, payment amounts", params: "?days=30&limit=50&offset=0" },
  ];

  return (
    <div className="rounded-2xl glass-card p-5 space-y-4 animate-fade-in-up" style={{ animationDelay: '50ms', opacity: 0 }}>
      <div className="space-y-2">
        <h3 className="text-[14px] font-medium text-white/70">API Documentation</h3>
        <div className="rounded-xl bg-black/30 border border-white/[0.06] p-3">
          <p className="text-[11px] text-white/30 mb-1">Base URL</p>
          <p className="text-[13px] text-amber-300/70 font-mono" data-testid="text-api-base-url">{baseUrl}</p>
        </div>
        <div className="rounded-xl bg-black/30 border border-white/[0.06] p-3">
          <p className="text-[11px] text-white/30 mb-1">Authentication</p>
          <p className="text-[12px] text-white/50 font-mono">Authorization: Bearer {"<your_api_key>"}</p>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-[12px] text-white/40 uppercase tracking-wider font-semibold">Endpoints</h4>
        {endpoints.map(ep => (
          <div key={ep.path} className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-green-500/25 text-green-400/70 bg-green-500/5 font-mono">
                {ep.method}
              </Badge>
              <code className="text-[12px] text-amber-300/60 font-mono">{ep.path}{ep.params}</code>
            </div>
            <p className="text-[11px] text-white/30">{ep.desc}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-black/30 border border-white/[0.06] p-3">
        <p className="text-[11px] text-white/30 mb-2">Quick Test (cURL)</p>
        <code className="text-[11px] text-white/40 font-mono block whitespace-pre-wrap">{`curl -H "Authorization: Bearer clubos_YOUR_KEY" \\\n  ${baseUrl}/api/v1/overview?days=30`}</code>
      </div>
    </div>
  );
}

export default function AdminSettings() {
  const [tab, setTab] = useState<"profile" | "general" | "users" | "api">("profile");
  const { data: currentUser } = useQuery<{ id: number; role: string }>({ queryKey: ["/api/auth/me"] });

  const tabs = [
    { key: "profile" as const, label: "Profile", icon: User },
    { key: "general" as const, label: "General", icon: Settings },
    ...(currentUser?.role === "super_admin" ? [
      { key: "users" as const, label: "Users", icon: Users },
      { key: "api" as const, label: "API Keys", icon: Key },
    ] : []),
  ];

  return (
    <div className="p-4 sm:p-8 space-y-6 max-w-3xl mx-auto">
      <div className="animate-fade-in-up" style={{ animationDelay: '0ms', opacity: 0 }}>
        <h1 className="text-2xl font-semibold text-white tracking-tight" data-testid="text-page-title">Settings</h1>
        <p className="text-blue-400/35 text-[13px] mt-1">Club and system configuration</p>
      </div>

      <div className="flex gap-1 bg-white/[0.02] rounded-xl p-1 w-fit animate-fade-in-up" style={{ animationDelay: '50ms', opacity: 0 }}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer ${
              tab === t.key
                ? "bg-blue-500/15 text-blue-400 border border-blue-500/25 shadow-[0_0_12px_rgba(3,86,197,0.1)]"
                : "text-white/35 hover:text-white/50 border border-transparent"
            }`}
            data-testid={`tab-${t.key}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" && <ProfileTab />}
      {tab === "general" && <GeneralTab />}
      {tab === "users" && <UsersTab />}
      {tab === "api" && <ApiKeysTab />}
    </div>
  );
}

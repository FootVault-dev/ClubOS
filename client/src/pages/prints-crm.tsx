import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Plus, X, Search, Users, Mail, Phone, Building2, Trash2, Edit } from "lucide-react";
import type { PrintContact } from "@shared/schema";
import PrintCustomerAccounts from "@/components/print-customer-accounts";

export default function PrintsCRM() {
  const { currentOrg } = useWorkspace();
  const { toast } = useToast();
  const orgId = currentOrg?.id;
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<PrintContact | null>(null);
  const [search, setSearch] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [type, setType] = useState("customer");
  const [notes, setNotes] = useState("");

  const { data: contacts = [], isLoading } = useQuery<PrintContact[]>({
    queryKey: ["/api/admin/print-contacts", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/print-contacts?orgId=${orgId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => { const r = await apiRequest("POST", "/api/admin/print-contacts", data); return r.json(); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/print-contacts"] }); toast({ title: "Contact saved" }); closeModal(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: any) => { const r = await apiRequest("PATCH", `/api/admin/print-contacts/${id}`, data); return r.json(); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/print-contacts"] }); toast({ title: "Contact updated" }); closeModal(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/admin/print-contacts/${id}`); },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/print-contacts"] }); toast({ title: "Contact deleted" }); },
  });

  function openCreate() {
    setEditing(null); setFirstName(""); setLastName(""); setEmail(""); setPhone(""); setCompany(""); setType("customer"); setNotes("");
    setShowModal(true);
  }

  function openEdit(c: PrintContact) {
    setEditing(c); setFirstName(c.firstName); setLastName(c.lastName); setEmail(c.email || ""); setPhone(c.phone || ""); setCompany(c.company || ""); setType(c.type); setNotes(c.notes || "");
    setShowModal(true);
  }

  function closeModal() { setShowModal(false); setEditing(null); }

  function handleSave() {
    const data = { firstName, lastName, email: email || null, phone: phone || null, company: company || null, type, notes: notes || null, organizationId: orgId };
    if (editing) updateMutation.mutate({ id: editing.id, ...data });
    else createMutation.mutate(data);
  }

  const filtered = contacts.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return `${c.firstName} ${c.lastName}`.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q);
  });

  const typeColors: Record<string, string> = { customer: "bg-blue-500/20 text-blue-400", supplier: "bg-amber-500/20 text-amber-400", partner: "bg-purple-500/20 text-purple-400" };

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto" data-testid="prints-crm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center"><Users className="w-5 h-5 text-white" /></div>
          <div>
            <h1 className="text-2xl font-bold text-white">CRM</h1>
            <p className="text-sm text-white/40">{contacts.length} contacts</p>
          </div>
        </div>
        <Button onClick={openCreate} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl gap-2" data-testid="button-add-contact"><Plus className="w-4 h-4" /> Add Contact</Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
        <Input placeholder="Search contacts..." value={search} onChange={e => setSearch(e.target.value)} className="premium-input pl-10 text-white/70 rounded-xl" data-testid="input-search-contacts" />
      </div>

      <div className="premium-card border border-white/[0.06] rounded-2xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/[0.06]">
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Name</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Contact</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Company</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Type</th>
              <th className="text-left text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Revenue</th>
              <th className="text-right text-[10px] text-white/30 uppercase tracking-wider font-medium px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={6} className="text-center py-8 text-white/30">Loading...</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={6} className="text-center py-8 text-white/30">No contacts found</td></tr>
            ) : filtered.map(c => (
              <tr key={c.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors" data-testid={`contact-row-${c.id}`}>
                <td className="px-4 py-3">
                  <p className="text-sm font-medium text-white/80">{c.firstName} {c.lastName}</p>
                </td>
                <td className="px-4 py-3">
                  <div className="space-y-0.5">
                    {c.email && <div className="flex items-center gap-1.5 text-xs text-white/50"><Mail className="w-3 h-3" />{c.email}</div>}
                    {c.phone && <div className="flex items-center gap-1.5 text-xs text-white/50"><Phone className="w-3 h-3" />{c.phone}</div>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  {c.company && <div className="flex items-center gap-1.5 text-xs text-white/50"><Building2 className="w-3 h-3" />{c.company}</div>}
                </td>
                <td className="px-4 py-3">
                  <Badge className={`text-[10px] capitalize ${typeColors[c.type] || "bg-white/10 text-white/50"}`}>{c.type}</Badge>
                </td>
                <td className="px-4 py-3 text-sm text-emerald-400/80">{c.totalRevenue && parseFloat(c.totalRevenue) > 0 ? `$${parseFloat(c.totalRevenue).toLocaleString("en-NZ", { minimumFractionDigits: 2 })}` : "—"}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center gap-1 justify-end">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(c)} className="h-7 w-7 text-white/30 hover:text-white/60" data-testid={`button-edit-contact-${c.id}`}><Edit className="w-3.5 h-3.5" /></Button>
                    <Button variant="ghost" size="icon" onClick={() => { if (confirm("Delete this contact?")) deleteMutation.mutate(c.id); }} className="h-7 w-7 text-red-400/40 hover:text-red-400" data-testid={`button-delete-contact-${c.id}`}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closeModal}>
          <div className="w-full max-w-md premium-card border border-white/[0.08] rounded-2xl p-6 space-y-4" onClick={e => e.stopPropagation()} data-testid="modal-contact">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">{editing ? "Edit Contact" : "New Contact"}</h2>
              <Button variant="ghost" size="icon" onClick={closeModal} className="text-white/30 h-8 w-8"><X className="w-4 h-4" /></Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="First name" value={firstName} onChange={e => setFirstName(e.target.value)} className="premium-input text-white/70 rounded-xl" data-testid="input-first-name" />
              <Input placeholder="Last name" value={lastName} onChange={e => setLastName(e.target.value)} className="premium-input text-white/70 rounded-xl" data-testid="input-last-name" />
            </div>
            <Input placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} className="premium-input text-white/70 rounded-xl" data-testid="input-email" />
            <Input placeholder="Phone" value={phone} onChange={e => setPhone(e.target.value)} className="premium-input text-white/70 rounded-xl" data-testid="input-phone" />
            <Input placeholder="Company" value={company} onChange={e => setCompany(e.target.value)} className="premium-input text-white/70 rounded-xl" data-testid="input-company" />
            <select value={type} onChange={e => setType(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-white/70 text-sm" data-testid="select-contact-type">
              <option value="customer">Customer</option>
              <option value="supplier">Supplier</option>
              <option value="partner">Partner</option>
            </select>
            <Textarea placeholder="Notes" value={notes} onChange={e => setNotes(e.target.value)} className="premium-input text-white/70 rounded-xl min-h-[60px]" data-testid="input-notes" />
            <div className="flex gap-2 pt-2">
              <Button onClick={handleSave} disabled={!firstName.trim() || !lastName.trim()} className="bg-blue-600 hover:bg-blue-700 text-white rounded-xl flex-1" data-testid="button-save-contact">
                {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : "Save"}
              </Button>
              <Button variant="outline" onClick={closeModal} className="border-white/10 text-white/60 rounded-xl">Cancel</Button>
            </div>
          </div>
        </div>
      )}

      {/* Customers who sign in to the portal themselves. Sits below the CRM
          contact list rather than in a tab of its own — a tab needs registering
          in three separate places and getting one wrong empties a sidebar. */}
      <div className="mt-10 border-t border-white/[0.08] pt-8">
        <PrintCustomerAccounts />
      </div>
    </div>
  );
}

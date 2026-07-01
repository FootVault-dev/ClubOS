import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, X, Mail, Phone, Image as ImageIcon, Ban, RotateCcw, Download } from "lucide-react";

// CIC club logo licence consents — the proof records from
// cicyouth.com/club-logo-agreement (each participating club's signed permission
// to use their crest on the CIC website + app).
type Consent = {
  id: number; clubName: string; repName: string; repRole: string | null;
  repEmail: string; repPhone: string | null; licenceVersion: string;
  signatureName: string; logoUrl: string | null; sourceUrl: string | null;
  ipAddress: string | null; status: string; createdAt: string;
};

const fmt = (d: string) => new Date(d).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function CicLogoConsents() {
  const [selected, setSelected] = useState<Consent | null>(null);
  const { data: rows = [], isLoading } = useQuery<Consent[]>({
    queryKey: ["/api/admin/cic/logo-consents"],
    queryFn: () => fetch("/api/admin/cic/logo-consents").then((r) => r.json()),
  });

  const agreed = rows.filter((r) => r.status === "agreed");
  const stats = [
    { label: "Signed", value: agreed.length },
    { label: "With logo", value: rows.filter((r) => r.logoUrl).length },
    { label: "Withdrawn", value: rows.filter((r) => r.status === "withdrawn").length },
  ];

  function exportCsv() {
    const head = ["Club", "Representative", "Role", "Email", "Phone", "Licence", "Signature", "Status", "Signed at", "IP"];
    const lines = rows.map((r) => [r.clubName, r.repName, r.repRole || "", r.repEmail, r.repPhone || "", `v${r.licenceVersion}`, r.signatureName, r.status, r.createdAt, r.ipAddress || ""]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "cic-logo-consents.csv"; a.click();
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Logo Consents</h1>
          <p className="text-sm text-white/40 mt-1">Signed permissions to use each club's crest on the CIC website &amp; app — from cicyouth.com/club-logo-agreement</p>
        </div>
        {rows.length > 0 && (
          <button onClick={exportCsv} className="flex items-center gap-2 text-xs font-semibold px-3.5 py-2 rounded-lg bg-white/10 text-white hover:bg-white/15"><Download className="w-3.5 h-3.5" /> Export CSV</button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
            <p className="text-[10px] uppercase tracking-wider text-white/30">{s.label}</p>
            <p className="text-lg font-bold text-white mt-0.5">{s.value}</p>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-white/20 text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
          <div className="flex flex-col items-center justify-center py-16 text-white/20">
            <ShieldCheck className="w-12 h-12 mb-3" />
            <p className="text-sm">No signed consents yet.</p>
            <p className="text-xs mt-1">Send clubs the link: cicyouth.com/club-logo-agreement</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setSelected(r)} className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] hover:bg-white/[0.04] transition-colors p-4 flex items-center gap-3" data-testid={`consent-row-${r.id}`}>
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${r.status === "agreed" ? "bg-amber-500/15 text-amber-300" : "bg-white/[0.06] text-white/30"}`}>
                {r.logoUrl ? <ImageIcon className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm text-white/90 truncate">{r.clubName}</span>
                  <span className="ml-auto text-[11px] text-white/30 shrink-0">{fmt(r.createdAt)}</span>
                </div>
                <div className="text-[13px] text-white/55 truncate mt-0.5">Signed by {r.repName}{r.repRole ? ` · ${r.repRole}` : ""}</div>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${r.status === "agreed" ? "bg-green-500/15 text-green-300" : "bg-white/[0.06] text-white/40"}`}>{r.status}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/10 text-white/50">Licence v{r.licenceVersion}</span>
                  {r.logoUrl && <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-300">Logo uploaded</span>}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {selected && <ConsentModal c={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ConsentModal({ c, onClose }: { c: Consent; onClose: () => void }) {
  const { toast } = useToast();
  const setStatus = useMutation({
    mutationFn: (status: string) => apiRequest("POST", `/api/admin/cic/logo-consents/${c.id}/status`, { status }).then((r) => r.json()),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/admin/cic/logo-consents"] }); onClose(); },
    onError: (e: any) => toast({ title: "Couldn't update", description: e.message, variant: "destructive" }),
  });
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4 py-2 border-b border-white/5"><span className="text-[12px] text-white/40">{label}</span><span className="text-[13px] text-white/85 text-right">{value}</span></div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-[#141511] border border-amber-500/15 rounded-2xl w-full max-w-lg shadow-2xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-500/15 text-amber-300"><ShieldCheck className="w-4 h-4" /></span>
            <div className="min-w-0"><h2 className="text-base font-semibold text-white truncate">{c.clubName}</h2><p className="text-xs text-white/40">Logo licence · {fmt(c.createdAt)}</p></div>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/60"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 overflow-y-auto flex-1">
          {c.logoUrl && (
            <div className="mb-4 flex items-center justify-center rounded-xl border border-white/10 bg-white/5 p-4">
              <img src={c.logoUrl} alt={`${c.clubName} logo`} className="max-h-28 w-auto object-contain" />
            </div>
          )}
          {row("Representative", c.repName)}
          {c.repRole && row("Role", c.repRole)}
          {row("Email", <a href={`mailto:${c.repEmail}`} className="text-amber-300 hover:underline inline-flex items-center gap-1"><Mail className="w-3 h-3" />{c.repEmail}</a>)}
          {c.repPhone && row("Phone", <a href={`tel:${c.repPhone}`} className="text-amber-300 hover:underline inline-flex items-center gap-1"><Phone className="w-3 h-3" />{c.repPhone}</a>)}
          {row("Licence version", `v${c.licenceVersion}`)}
          {row("Digital signature", <span className="italic">{c.signatureName}</span>)}
          {row("Signed at", fmt(c.createdAt))}
          {c.ipAddress && row("IP address", c.ipAddress)}
          {row("Status", <span className="capitalize">{c.status}</span>)}
          <p className="mt-4 text-[12px] leading-relaxed text-white/40">
            {c.repName} confirmed they were authorised to sign, that the club owns or is licensed to use its marks, and agreed to licence v{c.licenceVersion} — a perpetual, non-exclusive licence for CIC to display the club's crest on the CIC website and app.
          </p>
        </div>
        <div className="p-4 border-t border-white/5 flex flex-wrap items-center gap-2">
          {c.status === "agreed" ? (
            <button onClick={() => setStatus.mutate("withdrawn")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-red-300 hover:bg-red-500/10 ml-auto"><Ban className="w-3.5 h-3.5" /> Mark withdrawn</button>
          ) : (
            <button onClick={() => setStatus.mutate("agreed")} disabled={setStatus.isPending} className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-green-300 hover:bg-green-500/10 ml-auto"><RotateCcw className="w-3.5 h-3.5" /> Restore</button>
          )}
        </div>
      </div>
    </div>
  );
}

// e-Sign "Prepare" editor — drag-and-drop field placement on the PDF, the
// DocuSign-style sender experience. Pick a signer + field type, click on the
// document to drop a box, then move/resize it. Save → Send.
import { useMemo, useState, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PdfDoc } from "@/components/pdf-doc";
import { Button } from "@/components/ui/button";
import { PenLine, Type, Calendar, CheckSquare, Baseline, X, Send, Save, Trash2, MousePointerClick } from "lucide-react";

interface Signer { id: number; name: string; email: string }
interface Field {
  id?: number; tempId: string; signerId: number; page: number;
  x: number; y: number; w: number; h: number; type: string; required: boolean; label?: string | null;
}
interface Detail {
  id: number; title: string; status: string;
  signers: Signer[];
  fields: (Field & { id: number })[];
}

const FIELD_TYPES = [
  { key: "signature", label: "Signature", icon: PenLine, w: 0.22, h: 0.06 },
  { key: "initials", label: "Initials", icon: Baseline, w: 0.10, h: 0.05 },
  { key: "text", label: "Text", icon: Type, w: 0.24, h: 0.035 },
  { key: "date", label: "Date", icon: Calendar, w: 0.14, h: 0.035 },
  { key: "checkbox", label: "Checkbox", icon: CheckSquare, w: 0.03, h: 0.02 },
] as const;

const SIGNER_COLORS = ["#2563eb", "#059669", "#db2777", "#7c3aed", "#ea580c", "#0891b2"];

let tmp = 0;
const nextTmp = () => `t${++tmp}`;

export function EsignPrepare({ docId, onClose, onSent }: { docId: number; onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const { data: doc, isLoading } = useQuery<Detail>({ queryKey: [`/api/admin/esign/${docId}`] });

  const [fields, setFields] = useState<Field[] | null>(null);
  const [armedType, setArmedType] = useState<string | null>("signature");
  const [signerIdx, setSignerIdx] = useState(0);
  const [required, setRequired] = useState(true);

  // seed local fields from the loaded doc once
  const seeded = useRef(false);
  if (doc && !seeded.current) {
    seeded.current = true;
    setFields(doc.fields.map((f) => ({ ...f, tempId: nextTmp() })));
  }

  const signers = doc?.signers ?? [];
  const activeSigner = signers[signerIdx];
  const colorFor = (signerId: number) => SIGNER_COLORS[Math.max(0, signers.findIndex((s) => s.id === signerId)) % SIGNER_COLORS.length];

  const save = useMutation({
    mutationFn: () => apiRequest("PUT", `/api/admin/esign/${docId}/fields`, {
      fields: (fields ?? []).map((f) => ({ signerId: f.signerId, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type, required: f.required, label: f.label ?? null })),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/admin/esign/${docId}`] }),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });
  const send = useMutation({
    mutationFn: () => apiRequest("POST", `/api/admin/esign/${docId}/send`),
    onSuccess: () => { toast({ title: "Sent for signature", description: "Signers have been emailed their link." }); onSent(); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveThenSend = async () => { await save.mutateAsync(); await send.mutateAsync(); };

  const placeField = (page: number, xFrac: number, yFrac: number) => {
    if (!armedType || !activeSigner) return;
    const t = FIELD_TYPES.find((f) => f.key === armedType)!;
    setFields((prev) => [...(prev ?? []), {
      tempId: nextTmp(), signerId: activeSigner.id, page,
      x: Math.min(1 - t.w, Math.max(0, xFrac)), y: Math.min(1 - t.h, Math.max(0, yFrac)),
      w: t.w, h: t.h, type: t.key, required,
    }]);
  };
  const updateField = (tempId: string, patch: Partial<Field>) =>
    setFields((prev) => (prev ?? []).map((f) => (f.tempId === tempId ? { ...f, ...patch } : f)));
  const deleteField = (tempId: string) =>
    setFields((prev) => (prev ?? []).filter((f) => f.tempId !== tempId));

  const pdfUrl = useMemo(() => `/api/admin/esign/${docId}/source.pdf`, [docId]);

  const counts = useMemo(() => {
    const m: Record<number, number> = {};
    for (const f of fields ?? []) m[f.signerId] = (m[f.signerId] ?? 0) + 1;
    return m;
  }, [fields]);

  return (
    <div className="fixed inset-0 z-50 bg-[#0e0f12] text-white flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 h-14 border-b border-white/10 shrink-0">
        <button onClick={onClose} className="text-white/50 hover:text-white"><X className="w-5 h-5" /></button>
        <div className="font-semibold truncate">{doc?.title ?? "Prepare document"}</div>
        <div className="text-xs text-white/40 hidden md:block">Place fields, then send</div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={save.isPending || !fields} onClick={() => save.mutate()} className="gap-1.5"><Save className="w-4 h-4" /> Save draft</Button>
          <Button size="sm" disabled={save.isPending || send.isPending || !fields} onClick={saveThenSend} className="gap-1.5"><Send className="w-4 h-4" /> Save &amp; send</Button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Toolbar */}
        <div className="w-60 shrink-0 border-r border-white/10 p-4 space-y-5 overflow-y-auto">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-2">Signer</div>
            <div className="space-y-1.5">
              {signers.map((s, i) => (
                <button key={s.id} onClick={() => setSignerIdx(i)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border flex items-center gap-2 ${signerIdx === i ? "border-white/30 bg-white/[0.06]" : "border-white/10 hover:bg-white/[0.03]"}`}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: SIGNER_COLORS[i % SIGNER_COLORS.length] }} />
                  <span className="min-w-0">
                    <span className="block text-sm truncate">{s.name}</span>
                    <span className="block text-[11px] text-white/35 truncate">{counts[s.id] ?? 0} field{(counts[s.id] ?? 0) === 1 ? "" : "s"}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-[11px] uppercase tracking-wide text-white/40 mb-2">Field</div>
            <div className="grid grid-cols-2 gap-1.5">
              {FIELD_TYPES.map((t) => (
                <button key={t.key} onClick={() => setArmedType(t.key)}
                  className={`px-2 py-2 rounded-lg border text-xs flex flex-col items-center gap-1 ${armedType === t.key ? "border-amber-400/60 bg-amber-400/10 text-amber-300" : "border-white/10 text-white/60 hover:bg-white/[0.03]"}`}>
                  <t.icon className="w-4 h-4" /> {t.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-white/70">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="accent-amber-400" />
            Required field
          </label>

          <div className="text-xs text-white/40 leading-relaxed border-t border-white/10 pt-3 flex gap-2">
            <MousePointerClick className="w-4 h-4 shrink-0 mt-0.5" />
            Pick a signer &amp; field type, then click on the document to drop it. Drag to move, use the corner to resize.
          </div>
        </div>

        {/* Document */}
        <div className="flex-1 overflow-y-auto bg-[#17181c] p-6">
          {isLoading ? (
            <div className="text-center text-white/30 py-20">Loading…</div>
          ) : (
            <PdfDoc
              url={pdfUrl}
              width={720}
              renderOverlay={(pageIndex, pw, ph) => (
                <div
                  className={armedType ? "absolute inset-0 cursor-crosshair" : "absolute inset-0"}
                  onClick={(e) => {
                    if (!armedType || e.target !== e.currentTarget) return;
                    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
                    placeField(pageIndex, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
                  }}
                >
                  {(fields ?? []).filter((f) => f.page === pageIndex).map((f) => (
                    <FieldBox key={f.tempId} field={f} pageW={pw} pageH={ph} color={colorFor(f.signerId)}
                      onChange={(patch) => updateField(f.tempId, patch)} onDelete={() => deleteField(f.tempId)} />
                  ))}
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FieldBox({ field, pageW, pageH, color, onChange, onDelete }: {
  field: Field; pageW: number; pageH: number; color: string;
  onChange: (patch: Partial<Field>) => void; onDelete: () => void;
}) {
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number } | null>(null);

  const onDown = (mode: "move" | "resize") => (e: ReactPointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, ox: field.x, oy: field.y, ow: field.w, oh: field.h };
  };
  const onMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const d = drag.current;
    const dx = (e.clientX - d.sx) / pageW, dy = (e.clientY - d.sy) / pageH;
    if (d.mode === "move") {
      onChange({ x: Math.min(1 - field.w, Math.max(0, d.ox + dx)), y: Math.min(1 - field.h, Math.max(0, d.oy + dy)) });
    } else {
      onChange({ w: Math.min(1 - field.x, Math.max(0.03, d.ow + dx)), h: Math.min(1 - field.y, Math.max(0.015, d.oh + dy)) });
    }
  };
  const onUp = () => { drag.current = null; };

  const label = FIELD_TYPES.find((t) => t.key === field.type)?.label ?? field.type;
  return (
    <div
      onPointerDown={onDown("move")} onPointerMove={onMove} onPointerUp={onUp}
      className="absolute rounded-sm border-2 flex items-center justify-center text-[10px] font-semibold select-none cursor-move group"
      style={{
        left: `${field.x * 100}%`, top: `${field.y * 100}%`, width: `${field.w * 100}%`, height: `${field.h * 100}%`,
        borderColor: color, background: `${color}22`, color,
      }}
      title={`${label}${field.required ? " (required)" : ""}`}
    >
      <span className="truncate px-1 pointer-events-none">{label}</span>
      <button onPointerDown={(e) => { e.stopPropagation(); }} onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100">
        <Trash2 className="w-2.5 h-2.5" />
      </button>
      <span onPointerDown={onDown("resize")} className="absolute -bottom-1 -right-1 w-3 h-3 rounded-sm cursor-se-resize" style={{ background: color }} />
    </div>
  );
}

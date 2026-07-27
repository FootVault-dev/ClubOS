// The form-layout editor (D26) — Dima decides which questions New-item asks
// and in what order, per tracking mode.
//
// Reorder is up/down buttons rather than drag. Drag is nicer on a desktop and
// genuinely awkward on the phone this tab is mostly used from, and a warehouse
// manager reordering ten fields twice a year does not need the sophistication.
//
// 🔴 SKU and Name render with a lock and no remove/hide control: they are NOT
// NULL columns and the whole warehouse keys on SKU. The server refuses such a
// layout too — this just means nobody has to discover that by trying.
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronUp, ChevronDown, Eye, EyeOff, Lock, RotateCcw, Save, Loader2, Pencil } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TRACKING_MODES, TRACKING_MODE_LABELS, type TrackingMode } from "@shared/warehouse";
import { validateLayout, type LayoutField } from "@shared/warehouse-form";

interface LayoutResponse {
  layout: LayoutField[];
  isDefault: boolean;
  canEdit: boolean;
}

interface EditableField {
  coreField: string;
  label: string;
  active: boolean;
  required: boolean;
  mandatory: boolean;
  isCustom: boolean;
}

export function FormLayoutEditor() {
  const { toast } = useToast();
  const [mode, setMode] = useState<TrackingMode>("stock");
  const [fields, setFields] = useState<EditableField[]>([]);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const key = ["/api/admin/warehouse/form-layout", mode];
  const { data, isLoading } = useQuery<LayoutResponse>({
    queryKey: key,
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/form-layout?mode=${mode}`)).json(),
  });

  // Reseed whenever the server's view changes — but never while there are
  // unsaved edits, which would silently discard them.
  useEffect(() => {
    if (!data || dirty) return;
    setFields(
      data.layout
        .filter((f) => f.coreField)
        .map((f) => ({
          coreField: f.coreField!,
          label: f.label,
          active: !f.hidden,
          required: f.required,
          mandatory: f.mandatory,
          isCustom: false,
        })),
    );
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: async () => (await apiRequest("PUT", "/api/admin/warehouse/form-layout", { mode, fields })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/form-layout"] });
      setDirty(false);
      toast({ title: "Form saved", description: `New ${TRACKING_MODE_LABELS[mode].toLowerCase()} items use this order straight away.` });
    },
    onError: (e: any) => toast({ title: "Couldn't save the form", description: e.message, variant: "destructive" }),
  });

  const reset = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", `/api/admin/warehouse/form-layout?mode=${mode}`)).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/warehouse/form-layout"] });
      setDirty(false);
      toast({ title: "Back to the standard form" });
    },
  });

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    setFields(next);
    setDirty(true);
  };

  const patch = (i: number, p: Partial<EditableField>) => {
    const next = [...fields];
    next[i] = { ...next[i], ...p };
    setFields(next);
    setDirty(true);
  };

  const check = validateLayout(fields.map((f) => ({ coreField: f.coreField, active: f.active })));
  const canEdit = data?.canEdit ?? false;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/[0.06] flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-white/85">The New-item form</h2>
          <p className="text-[11px] text-white/40 mt-0.5 max-w-lg">
            Choose what gets asked when someone adds an item, and in what order. Stock and assets can have
            different forms.
          </p>
        </div>
        <div className="flex rounded-lg border border-white/10 overflow-hidden shrink-0">
          {TRACKING_MODES.map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setDirty(false); }}
              className={`px-3 py-1.5 text-xs ${mode === m ? "bg-blue-600 text-white" : "text-white/50 hover:text-white/80"}`}
            >
              {TRACKING_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="p-4 text-white/40 text-sm flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          {data?.isDefault && !dirty && (
            <div className="px-4 py-2 text-[11px] text-white/40 border-b border-white/[0.06]">
              Currently the standard form. Reorder or hide anything below to make it yours.
            </div>
          )}

          <div className="divide-y divide-white/[0.04]">
            {fields.map((f, i) => (
              <div key={f.coreField} className={`px-3 py-2 flex items-center gap-2 ${f.active ? "" : "opacity-45"}`}>
                <div className="flex flex-col shrink-0">
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0 || !canEdit}
                    className="w-9 h-8 flex items-center justify-center rounded hover:bg-white/5 disabled:opacity-20 text-white/40"
                  >
                    <ChevronUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === fields.length - 1 || !canEdit}
                    className="w-9 h-8 flex items-center justify-center rounded hover:bg-white/5 disabled:opacity-20 text-white/40"
                  >
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="flex-1 min-w-0">
                  {editing === f.coreField ? (
                    <Input
                      autoFocus
                      value={f.label}
                      onChange={(e) => patch(i, { label: e.target.value })}
                      onBlur={() => setEditing(null)}
                      onKeyDown={(e) => e.key === "Enter" && setEditing(null)}
                      className="h-8 text-sm scroll-mb-24"
                    />
                  ) : (
                    <button
                      onClick={() => canEdit && setEditing(f.coreField)}
                      className="text-sm text-white/85 flex items-center gap-1.5 group text-left min-h-[32px]"
                    >
                      {f.label}
                      {f.mandatory && <Lock className="w-3 h-3 text-amber-400/60" />}
                      {canEdit && <Pencil className="w-3 h-3 text-white/0 group-hover:text-white/25" />}
                    </button>
                  )}
                  <div className="text-[10px] text-white/25 font-mono">{f.coreField}</div>
                </div>

                {f.mandatory ? (
                  <span className="text-[10px] text-amber-400/60 shrink-0 px-2">always on</span>
                ) : (
                  <button
                    onClick={() => patch(i, { active: !f.active })}
                    disabled={!canEdit}
                    className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/5 text-white/30 disabled:opacity-30 shrink-0"
                    title={f.active ? "Hide from the form" : "Show on the form"}
                  >
                    {f.active ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  </button>
                )}
              </div>
            ))}
          </div>

          {!check.ok && (
            <div className="px-4 py-2 text-[11px] text-red-400/80 border-t border-white/[0.06]">
              {check.errors.join(" ")}
            </div>
          )}

          {canEdit && (
            <div className="px-4 py-3 border-t border-white/[0.06] flex items-center gap-2">
              <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || !check.ok || save.isPending} className="gap-1.5">
                {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save form
              </Button>
              <button
                onClick={() => reset.mutate()}
                disabled={reset.isPending}
                className="text-[11px] text-white/40 hover:text-white/70 flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" /> Back to standard
              </button>
              {dirty && <span className="text-[11px] text-amber-400/70 ml-auto">Unsaved changes</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

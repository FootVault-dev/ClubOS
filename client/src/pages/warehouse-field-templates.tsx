// Warehouse → Fields (D23). The self-service schema editor — the feature that
// lets Dima add "vinyl width" to print materials or "WOF expiry" to vehicles
// himself, with no migration, no deploy and no developer.
//
// Two things this screen is careful about:
//   • The field NAME (field_key) is derived from the label once and then
//     frozen. It is the address every recorded answer is filed under, so the
//     editor shows it read-only and explains why renaming the label is safe.
//   • Deleting a field does NOT delete the answers already recorded against
//     it. The server reports how many are left behind and this screen says so
//     out loud, because a field removed by mistake must not take real data.
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { GripVertical, Plus, Trash2, X, Loader2, Lock, Info } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModalPortal } from "@/components/warehouse-custom-fields";
import {
  FIELD_TYPES, FIELD_TYPE_LABELS, FIELD_APPLIES_TO, FIELD_APPLIES_TO_LABELS,
  slugifyFieldKey, type FieldType, type FieldAppliesTo,
} from "@shared/warehouse";

interface Template {
  id: number;
  category: string;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  options: string[] | null;
  required: boolean;
  sortOrder: number;
  helpText: string | null;
  appliesTo: FieldAppliesTo;
  active: boolean;
}

interface TemplatesResponse {
  templates: Template[];
  categories: string[];
  canEdit: boolean;
}

const KEY = ["/api/admin/warehouse/field-templates"];

function AddFieldSheet({ categories, presetCategory, onClose }: { categories: string[]; presetCategory: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const [category, setCategory] = useState(presetCategory ?? "");
  const [label, setLabel] = useState("");
  const [fieldType, setFieldType] = useState<FieldType>("text");
  const [appliesTo, setAppliesTo] = useState<FieldAppliesTo>("item");
  const [required, setRequired] = useState(false);
  const [helpText, setHelpText] = useState("");
  const [optionsRaw, setOptionsRaw] = useState("");

  const create = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", "/api/admin/warehouse/field-templates", {
        category,
        label,
        fieldType,
        appliesTo,
        required,
        helpText: helpText || undefined,
        options: fieldType === "select" ? optionsRaw.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
      })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: "Field added", description: "It shows on every item in that category straight away." });
      onClose();
    },
    onError: (e: any) => toast({ title: "Couldn't add it", description: e.message, variant: "destructive" }),
  });

  const previewKey = label ? slugifyFieldKey(label) : "";

  return (
    <ModalPortal>
    <div className="fixed inset-0 z-50 flex sm:items-center sm:justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg sm:rounded-2xl bg-[#0f1216] border border-white/10 mt-auto sm:mt-0 max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-[#0f1216] border-b border-white/10 px-4 py-3 flex items-center justify-between">
          <div className="text-sm font-semibold text-white">Add a field</div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/5"><X className="w-4 h-4 text-white/50" /></button>
        </div>

        <div className="p-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-white/50">Which category *</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue placeholder="Pick a category" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            {categories.length === 0 && (
              <p className="text-[11px] text-white/35">
                No categories exist yet — give some items a category first, then come back.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-white/50">Label *</label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. WOF expiry" className="scroll-mb-24" />
            {previewKey && (
              <p className="text-[11px] text-white/35 flex items-center gap-1">
                <Lock className="w-3 h-3" /> Saved as <code className="text-white/50">{previewKey}</code> — fixed once
                created, so you can rename the label later without losing answers.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-white/50">Kind of answer</label>
              <Select value={fieldType} onValueChange={(v) => setFieldType(v as FieldType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => <SelectItem key={t} value={t}>{FIELD_TYPE_LABELS[t]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-white/50">Describes</label>
              <Select value={appliesTo} onValueChange={(v) => setAppliesTo(v as FieldAppliesTo)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FIELD_APPLIES_TO.map((a) => <SelectItem key={a} value={a}>{FIELD_APPLIES_TO_LABELS[a]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {appliesTo === "instance" && (
            <p className="text-[11px] text-white/35 flex items-start gap-1.5">
              <Info className="w-3 h-3 mt-0.5 shrink-0" />
              Each unit answers separately — right for a WOF date or a service record, which belong to one van and not
              to the idea of a van.
            </p>
          )}

          {fieldType === "select" && (
            <div className="space-y-1">
              <label className="text-xs text-white/50">Options, one per line *</label>
              <textarea
                value={optionsRaw}
                onChange={(e) => setOptionsRaw(e.target.value)}
                rows={4}
                className="w-full rounded-lg bg-white/[0.03] border border-white/10 px-3 py-2 text-sm text-white/80 scroll-mb-24"
                placeholder={"Small\nMedium\nLarge"}
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-white/50">Hint (optional)</label>
            <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} className="scroll-mb-24" />
          </div>

          <label className="flex items-center gap-2 text-sm text-white/60">
            <Checkbox checked={required} onCheckedChange={(c) => setRequired(c === true)} />
            Must be filled in
          </label>

          <Button
            className="w-full gap-1.5"
            disabled={!category || !label || create.isPending || (fieldType === "select" && !optionsRaw.trim())}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add field
          </Button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

export default function WarehouseFieldTemplates() {
  const { toast } = useToast();
  const [adding, setAdding] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery<TemplatesResponse>({
    queryKey: KEY,
    queryFn: async () => (await apiRequest("GET", "/api/admin/warehouse/field-templates")).json(),
  });

  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      (await apiRequest("PATCH", `/api/admin/warehouse/field-templates/${id}`, body)).json(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: async (id: number) =>
      (await apiRequest("DELETE", `/api/admin/warehouse/field-templates/${id}`)).json(),
    onSuccess: (r: any) => {
      queryClient.invalidateQueries({ queryKey: KEY });
      toast({
        title: "Field removed",
        description:
          r.orphanedValues > 0
            ? `${r.orphanedValues} answer(s) already recorded were kept, not deleted — add the field back to see them again.`
            : "No answers had been recorded against it.",
      });
    },
    onError: (e: any) => toast({ title: "Couldn't remove it", description: e.message, variant: "destructive" }),
  });

  const templates = data?.templates ?? [];
  const canEdit = data?.canEdit ?? false;

  const grouped = templates.reduce<Record<string, Template[]>>((acc, t) => {
    (acc[t.category] ||= []).push(t);
    return acc;
  }, {});

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Item fields</h1>
          <p className="text-sm text-white/40 mt-0.5 max-w-xl">
            Decide what gets recorded about each kind of item. Add a field here and it appears on every item in that
            category immediately — nothing to deploy.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => { setAdding(null); setShowAdd(true); }} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add field
          </Button>
        )}
      </div>

      {!canEdit && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/50 flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 shrink-0" />
          You can see how items are set up, but only an admin can change which fields exist.
        </div>
      )}

      {isLoading ? (
        <div className="text-white/40 text-sm py-8 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : templates.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-white/10 rounded-xl">
          <p className="text-sm text-white/50">No extra fields set up yet.</p>
          <p className="text-xs text-white/30 mt-1 max-w-md mx-auto">
            Every item already records a name, SKU, unit and location. Use this page when a particular kind of item
            needs something more — a width, an expiry date, a grade.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([category, fields]) => (
            <div key={category} className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-white/80">{category}</div>
                {canEdit && (
                  <button
                    onClick={() => { setAdding(category); setShowAdd(true); }}
                    className="text-[11px] text-blue-400/70 hover:text-blue-400 min-h-[44px] px-2 -mr-2"
                  >
                    Add to this category
                  </button>
                )}
              </div>

              <div className="divide-y divide-white/[0.04]">
                {fields.map((t) => (
                  <div key={t.id} className="px-4 py-3 flex items-start gap-3">
                    <GripVertical className="w-4 h-4 text-white/15 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm text-white/85">{t.label}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/40">
                          {FIELD_TYPE_LABELS[t.fieldType]}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/40">
                          {t.appliesTo === "instance" ? "per unit" : "per item"}
                        </span>
                        {t.required && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-400/80">required</span>
                        )}
                        {!t.active && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-white/5 text-white/30">hidden</span>
                        )}
                      </div>
                      <div className="text-[11px] text-white/30 mt-0.5">
                        <code>{t.fieldKey}</code>
                        {t.options?.length ? <> · {t.options.join(", ")}</> : null}
                        {t.helpText ? <> · {t.helpText}</> : null}
                      </div>
                    </div>

                    {canEdit && (
                      // Both controls carry a 44px-tall hit area on a phone —
                      // a 16px checkbox is a miss waiting to happen, and this
                      // page is used standing in the warehouse. The visual
                      // size is unchanged; only the touch surface grows.
                      <div className="flex items-center gap-1 shrink-0">
                        <label className="flex items-center gap-1.5 text-[11px] text-white/40 min-h-[44px] px-1.5 cursor-pointer">
                          <Checkbox
                            checked={t.required}
                            onCheckedChange={(c) => patch.mutate({ id: t.id, body: { required: c === true } })}
                          />
                          required
                        </label>
                        <button
                          onClick={() => remove.mutate(t.id)}
                          className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/25 hover:text-red-400"
                          title="Remove this field (recorded answers are kept)"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddFieldSheet
          categories={data?.categories ?? []}
          presetCategory={adding}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

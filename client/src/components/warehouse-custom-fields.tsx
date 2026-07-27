// Renders whatever fields an admin has defined for an item's category (D23/D24)
// — the client half of the self-service template editor. There is deliberately
// no hardcoded field list anywhere: this component asks the server what the
// category has and draws it, so adding "vinyl width" or "WOF expiry" is a row
// in wh_field_templates and needs no deploy.
//
// The input type follows the template's declared field_type, and the value is
// posted back raw — the server does the coercion into the right typed column
// (shared/warehouse.ts's coerceFieldValue), because a browser is the last place
// that should decide what a date is.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { missingRequiredFields, type FieldTemplateLike, type TypedFieldValue } from "@shared/warehouse";

type OwnerKind = "item" | "instance";

/**
 * Renders a full-screen overlay into <body>, never in place.
 *
 * A `fixed inset-0` sheet left inside the page tree still inherits layout
 * utilities from its parent — and every warehouse page's root is a
 * `space-y-*` container, whose `> * + *` rule puts a 20px margin-top on any
 * child that isn't the first. That margin shifts the overlay down, leaving a
 * dead strip across the top of the screen where taps fall THROUGH an open
 * modal onto the page behind it. (Verified: the element at y=8 with a sheet
 * open was the page, not the backdrop.)
 *
 * Same class of bug as the coaching platform's picker, where a leftover
 * page-entrance transform made an ancestor the containing block. Portalling is
 * the standing fix for both: a modal belongs to the viewport, not to whatever
 * happens to be around it.
 */
export function ModalPortal({ children }: { children: ReactNode }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

interface FieldsResponse {
  category: string | null;
  templates: FieldTemplateLike[];
  values: Record<string, TypedFieldValue>;
  display: Record<string, string | number | boolean | null>;
}

/** The form value for one field, always a string except booleans — mirrors what
 *  an <input> actually gives you, so nothing is coerced twice on the way out. */
type FormValue = string | boolean;

function toFormValue(t: FieldTemplateLike, display: FieldsResponse["display"]): FormValue {
  const v = display[t.fieldKey];
  if (t.fieldType === "boolean") return v === true;
  if (v === null || v === undefined) return "";
  return String(v);
}

export function WarehouseCustomFields({
  owner,
  ownerId,
  title = "Details",
}: {
  owner: OwnerKind;
  ownerId: number;
  title?: string;
}) {
  const { toast } = useToast();
  const key = [`/api/admin/warehouse/fields/${owner}/${ownerId}`];

  const { data, isLoading } = useQuery<FieldsResponse>({
    queryKey: key,
    queryFn: async () => (await apiRequest("GET", `/api/admin/warehouse/fields/${owner}/${ownerId}`)).json(),
  });

  const [form, setForm] = useState<Record<string, FormValue>>({});
  const [dirty, setDirty] = useState(false);

  // Re-seed the form whenever the server's view changes (first load, or after a
  // save). Not keyed on `data` identity alone — react-query hands back a new
  // object each poll, which would otherwise stomp on what someone is typing.
  const stamp = useMemo(() => JSON.stringify(data?.display ?? {}), [data?.display]);
  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(data.templates.map((t) => [t.fieldKey, toFormValue(t, data.display)])));
    setDirty(false);
  }, [stamp, data?.templates.length]);

  const save = useMutation({
    mutationFn: async () =>
      (await apiRequest("PUT", `/api/admin/warehouse/fields/${owner}/${ownerId}`, { values: form })).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      setDirty(false);
      toast({ title: "Details saved" });
    },
    onError: (e: any) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-white/40 text-sm py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading details…
      </div>
    );
  }

  if (!data || data.templates.length === 0) {
    return (
      <div className="text-sm text-white/40 py-3">
        {data?.category
          ? <>No extra fields set up for <span className="text-white/60">{data.category}</span> yet.</>
          : "This item has no category, so there are no extra fields."}
      </div>
    );
  }

  // Computed from what is ON SCREEN, not from what was last saved, so the
  // warning clears the moment someone fills the box in.
  const missing = missingRequiredFields(
    data.templates,
    Object.fromEntries(
      data.templates.map((t) => {
        const v = form[t.fieldKey];
        if (t.fieldType === "boolean") return [t.fieldKey, { valueBoolean: v === true }];
        if (v === "" || v === undefined) return [t.fieldKey, {}];
        if (t.fieldType === "number") return [t.fieldKey, { valueNumber: Number(v) }];
        if (t.fieldType === "date") return [t.fieldKey, { valueDate: String(v) }];
        return [t.fieldKey, { valueText: String(v) }];
      }),
    ),
  );

  const set = (k: string, v: FormValue) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-white/70">{title}</h3>
        {missing.length > 0 && (
          <span className="text-[11px] text-amber-400/80">Still needed: {missing.join(", ")}</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data.templates.map((t) => (
          <div key={t.fieldKey} className="space-y-1">
            <label className="text-xs text-white/50">
              {t.label}
              {t.required && <span className="text-amber-400/70 ml-1">*</span>}
            </label>

            {t.fieldType === "boolean" ? (
              <div className="flex items-center gap-2 h-9">
                <Checkbox
                  checked={form[t.fieldKey] === true}
                  onCheckedChange={(c) => set(t.fieldKey, c === true)}
                />
                <span className="text-sm text-white/60">{form[t.fieldKey] === true ? "Yes" : "No"}</span>
              </div>
            ) : t.fieldType === "select" ? (
              <Select value={String(form[t.fieldKey] ?? "")} onValueChange={(v) => set(t.fieldKey, v)}>
                <SelectTrigger><SelectValue placeholder="Choose…" /></SelectTrigger>
                <SelectContent>
                  {(t.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>{o}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                type={t.fieldType === "date" ? "date" : t.fieldType === "number" ? "number" : "text"}
                value={String(form[t.fieldKey] ?? "")}
                onChange={(e) => set(t.fieldKey, e.target.value)}
                className="scroll-mb-24"
              />
            )}
          </div>
        ))}
      </div>

      <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending} className="gap-1.5">
        {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
        Save details
      </Button>
    </div>
  );
}

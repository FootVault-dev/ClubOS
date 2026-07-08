// Marketing Suite — Segments: list + a 2-level AND-of-ORs condition builder.
// "Match ALL of these groups" (top level) → each group "match ANY of these
// conditions". Mirrors the exact tree server/marketing/segments.ts evaluates
// ({all:[{any:[...]}, ...]}), so what you build here is exactly what runs.
//
// NOTE — data gap: POST /segments/preview-count returns only {count} (a raw
// profile count for the definition, no channel/isMarketing context to run the
// suppression gate). The build brief describes a {total, sendable} preview
// shape — that shape only exists on POST /campaigns/:id/audience-estimate,
// which needs a saved campaign id, not a bare definition. So "Preview count"
// here shows one honest number ("≈ N profiles match"); the total/suppressed/
// sendable split is used correctly in the Campaign Wizard's Audience step,
// where a draft campaign id already exists.
//
// NOTE — scope: no "Lists" CRUD page exists in this phase's build brief, so
// Lists (used by the list_membership condition + the campaign wizard) are
// read-only here — created lists are consumed via GET /lists, not managed.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, RefreshCw, ListFilter, Loader2 } from "lucide-react";
import type { MktSegment, MktList, Condition, ConditionGroup, ConditionType, MktChannel } from "./types";
import { EmptyState, LoadingRows, fmtDateTime } from "./ui";

const MAX_CONDITIONS = 100;

function defaultCondition(type: ConditionType = "profile_property"): Condition {
  switch (type) {
    case "consent": return { type: "consent", channel: "email" };
    case "list_membership": return { type: "list_membership", listId: 0, op: "in" };
    case "event": return { type: "event", metric: "", op: ">=", count: 1 };
    case "profile_property":
    default: return { type: "profile_property", path: "email", op: "exists" };
  }
}

function normalizeDefinition(def: any): ConditionGroup[] {
  if (def && Array.isArray(def.all) && def.all.length) {
    return def.all.map((g: any) => ({ any: Array.isArray(g?.any) ? g.any : (g?.type ? [g] : []) }));
  }
  return [{ any: [defaultCondition()] }];
}

export default function SegmentsView() {
  const { toast } = useToast();
  const { data: segments = [], isLoading } = useQuery<MktSegment[]>({ queryKey: ["/api/admin/marketing/segments"] });
  const { data: lists = [] } = useQuery<MktList[]>({ queryKey: ["/api/admin/marketing/lists"] });

  const [builderOpen, setBuilderOpen] = useState<{ mode: "create" | "edit"; segment?: MktSegment } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MktSegment | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/segments"] });

  const save = useMutation({
    mutationFn: async ({ id, name, definition }: { id?: number; name: string; definition: any }) => {
      const r = id
        ? await apiRequest("PATCH", `/api/admin/marketing/segments/${id}`, { name, definition })
        : await apiRequest("POST", "/api/admin/marketing/segments", { name, definition });
      return r.json();
    },
    onSuccess: () => { invalidate(); setBuilderOpen(null); toast({ title: "Segment saved" }); },
    onError: (e: any) => toast({ title: "Couldn't save segment", description: e.message, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/marketing/segments/${id}`),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast({ title: "Segment deleted" }); },
  });
  const recompute = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/admin/marketing/segments/${id}/recompute`).then((r) => r.json()),
    onSuccess: (r: { count: number }) => { invalidate(); toast({ title: "Recomputed", description: `${r.count} profiles now match.` }); },
    onError: (e: any) => toast({ title: "Couldn't recompute", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setBuilderOpen({ mode: "create" })} data-testid="mkt-segment-new">
          <Plus className="w-4 h-4 mr-1.5" /> New segment
        </Button>
      </div>

      {isLoading ? (
        <LoadingRows rows={4} />
      ) : !segments.length ? (
        <EmptyState
          icon={ListFilter}
          title="No segments yet"
          description="Build a dynamic audience — e.g. subscribed parents who registered in the last 90 days — and reuse it across campaigns."
          action={<Button size="sm" className="mt-2" onClick={() => setBuilderOpen({ mode: "create" })}>Create your first segment</Button>}
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead>Last computed</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((s) => (
                <TableRow key={s.id} data-testid={`mkt-segment-row-${s.id}`}>
                  <TableCell className="font-medium cursor-pointer" onClick={() => setBuilderOpen({ mode: "edit", segment: s })}>{s.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.memberCount.toLocaleString()}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtDateTime(s.lastComputedAt)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="icon" variant="ghost" title="Recompute" onClick={() => recompute.mutate(s.id)} disabled={recompute.isPending} data-testid={`mkt-segment-recompute-${s.id}`}>
                        {recompute.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="text-red-500 hover:text-red-500" title="Delete" onClick={() => setDeleteTarget(s)} data-testid={`mkt-segment-delete-${s.id}`}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {builderOpen && (
        <SegmentBuilderDialog
          mode={builderOpen.mode}
          segment={builderOpen.segment}
          lists={lists}
          saving={save.isPending}
          onClose={() => setBuilderOpen(null)}
          onSave={(name, definition) => save.mutate({ id: builderOpen.segment?.id, name, definition })}
        />
      )}

      <AlertDialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone. Campaigns already sent to this segment keep their history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 hover:bg-red-700" onClick={() => deleteTarget && del.mutate(deleteTarget.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SegmentBuilderDialog({
  mode, segment, lists, saving, onClose, onSave,
}: {
  mode: "create" | "edit"; segment?: MktSegment; lists: MktList[]; saving: boolean;
  onClose: () => void; onSave: (name: string, definition: any) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(segment?.name ?? "");
  const [groups, setGroups] = useState<ConditionGroup[]>(() => normalizeDefinition(segment?.definition));
  const totalConditions = useMemo(() => groups.reduce((n, g) => n + g.any.length, 0), [groups]);

  const preview = useMutation({
    mutationFn: async () => {
      const definition = { all: groups };
      const r = await apiRequest("POST", "/api/admin/marketing/segments/preview-count", { definition });
      return r.json() as Promise<{ count: number }>;
    },
    onError: (e: any) => toast({ title: "Couldn't preview", description: e.message, variant: "destructive" }),
  });

  const updateGroup = (gi: number, next: ConditionGroup) => setGroups((gs) => gs.map((g, i) => (i === gi ? next : g)));
  const addGroup = () => setGroups((gs) => [...gs, { any: [defaultCondition()] }]);
  const removeGroup = (gi: number) => setGroups((gs) => gs.filter((_, i) => i !== gi));

  const canSave = name.trim().length > 0 && groups.length > 0 && groups.every((g) => g.any.length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New segment" : `Edit "${segment?.name}"`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="mkt-segment-name">Segment name</Label>
            <Input id="mkt-segment-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Subscribed parents, registered last 90 days" data-testid="mkt-segment-name" />
          </div>

          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Match ALL of these groups</p>
            <span className="text-[11px] text-muted-foreground">{totalConditions}/{MAX_CONDITIONS} conditions</span>
          </div>

          <div className="space-y-3">
            {groups.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && <div className="text-center text-[10px] font-bold text-muted-foreground tracking-wider py-1">AND</div>}
                <div className="rounded-xl border p-3 space-y-2 bg-muted/20">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Match ANY of these conditions</p>
                    {groups.length > 1 && (
                      <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={() => removeGroup(gi)} data-testid={`mkt-segment-remove-group-${gi}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-2">
                    {group.any.map((cond, ci) => (
                      <ConditionRow
                        key={ci}
                        condition={cond}
                        lists={lists}
                        onChange={(next) => updateGroup(gi, { any: group.any.map((c, i) => (i === ci ? next : c)) })}
                        onRemove={group.any.length > 1 ? () => updateGroup(gi, { any: group.any.filter((_, i) => i !== ci) }) : undefined}
                      />
                    ))}
                  </div>
                  <Button
                    size="sm" variant="outline"
                    disabled={totalConditions >= MAX_CONDITIONS}
                    onClick={() => updateGroup(gi, { any: [...group.any, defaultCondition()] })}
                    data-testid={`mkt-segment-add-condition-${gi}`}
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add condition
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <Button size="sm" variant="outline" onClick={addGroup} disabled={totalConditions >= MAX_CONDITIONS} data-testid="mkt-segment-add-group">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add group
          </Button>

          <div className="flex items-center gap-3 pt-2 border-t">
            <Button variant="outline" size="sm" onClick={() => preview.mutate()} disabled={preview.isPending} data-testid="mkt-segment-preview">
              {preview.isPending ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null} Preview count
            </Button>
            {preview.data && <span className="text-sm">≈ <span className="font-bold">{preview.data.count.toLocaleString()}</span> profiles match</span>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSave || saving} onClick={() => onSave(name.trim(), { all: groups })} data-testid="mkt-segment-save">
            {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null} Save segment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PROFILE_PATH_PRESETS = [
  { value: "email", label: "Email" },
  { value: "first_name", label: "First name" },
  { value: "last_name", label: "Last name" },
  { value: "phone_e164", label: "Phone" },
  { value: "external_id", label: "External ID" },
  { value: "__custom", label: "Custom property…" },
];

function ConditionRow({ condition, lists, onChange, onRemove }: { condition: Condition; lists: MktList[]; onChange: (c: Condition) => void; onRemove?: () => void }) {
  const changeType = (type: ConditionType) => onChange(defaultCondition(type));

  return (
    <div className="rounded-lg border bg-background p-2.5 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={condition.type} onValueChange={(v) => changeType(v as ConditionType)}>
          <SelectTrigger className="w-[170px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="profile_property">Profile property</SelectItem>
            <SelectItem value="consent">Consent state</SelectItem>
            <SelectItem value="list_membership">List membership</SelectItem>
            <SelectItem value="event">Event</SelectItem>
          </SelectContent>
        </Select>

        {condition.type === "profile_property" && (
          <ProfilePropertyFields condition={condition} onChange={onChange as (c: Condition) => void} />
        )}
        {condition.type === "consent" && (
          <ConsentFields condition={condition} onChange={onChange as (c: Condition) => void} />
        )}
        {condition.type === "list_membership" && (
          <ListMembershipFields condition={condition} lists={lists} onChange={onChange as (c: Condition) => void} />
        )}
        {condition.type === "event" && (
          <EventFields condition={condition} onChange={onChange as (c: Condition) => void} />
        )}

        {onRemove && (
          <Button size="icon" variant="ghost" className="h-7 w-7 ml-auto text-muted-foreground" onClick={onRemove} data-testid="mkt-segment-remove-condition">
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

function ProfilePropertyFields({ condition, onChange }: { condition: Extract<Condition, { type: "profile_property" }>; onChange: (c: Condition) => void }) {
  const isCustom = !PROFILE_PATH_PRESETS.some((p) => p.value === condition.path) || condition.path.startsWith("props.");
  return (
    <>
      <Select value={isCustom ? "__custom" : condition.path} onValueChange={(v) => onChange({ ...condition, path: v === "__custom" ? "props." : v })}>
        <SelectTrigger className="w-[160px] h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>{PROFILE_PATH_PRESETS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
      </Select>
      {isCustom && (
        <Input className="w-[160px] h-8 text-xs" value={condition.path.replace(/^props\./, "")} placeholder="props key" onChange={(e) => onChange({ ...condition, path: `props.${e.target.value}` })} />
      )}
      <Select value={condition.op} onValueChange={(v) => onChange({ ...condition, op: v as any })}>
        <SelectTrigger className="w-[120px] h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="eq">Equals</SelectItem>
          <SelectItem value="neq">Not equals</SelectItem>
          <SelectItem value="contains">Contains</SelectItem>
          <SelectItem value="exists">Exists</SelectItem>
        </SelectContent>
      </Select>
      {condition.op !== "exists" && (
        <Input className="w-[160px] h-8 text-xs" value={condition.value ?? ""} placeholder="value" onChange={(e) => onChange({ ...condition, value: e.target.value })} />
      )}
    </>
  );
}

function ConsentFields({ condition, onChange }: { condition: Extract<Condition, { type: "consent" }>; onChange: (c: Condition) => void }) {
  return (
    <>
      <Select value={condition.channel} onValueChange={(v) => onChange({ ...condition, channel: v as MktChannel })}>
        <SelectTrigger className="w-[100px] h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="email">Email</SelectItem><SelectItem value="sms">SMS</SelectItem></SelectContent>
      </Select>
      <Select value={condition.subState ?? "__any"} onValueChange={(v) => onChange({ ...condition, subState: v === "__any" ? undefined : (v as any) })}>
        <SelectTrigger className="w-[140px] h-8 text-xs"><SelectValue placeholder="Sub-state" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__any">Any sub-state</SelectItem>
          <SelectItem value="subscribed">Subscribed</SelectItem>
          <SelectItem value="unsubscribed">Unsubscribed</SelectItem>
          <SelectItem value="never">Never</SelectItem>
        </SelectContent>
      </Select>
      <Select value={condition.legalBasis ?? "__any"} onValueChange={(v) => onChange({ ...condition, legalBasis: v === "__any" ? undefined : (v as any) })}>
        <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue placeholder="Legal basis" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__any">Any legal basis</SelectItem>
          <SelectItem value="express">Express</SelectItem>
          <SelectItem value="inferred">Inferred</SelectItem>
          <SelectItem value="deemed">Deemed</SelectItem>
          <SelectItem value="none">None</SelectItem>
          <SelectItem value="opted_out">Opted out</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

function ListMembershipFields({ condition, lists, onChange }: { condition: Extract<Condition, { type: "list_membership" }>; lists: MktList[]; onChange: (c: Condition) => void }) {
  return (
    <>
      <Select value={condition.op} onValueChange={(v) => onChange({ ...condition, op: v as any })}>
        <SelectTrigger className="w-[110px] h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="in">In list</SelectItem><SelectItem value="not_in">Not in list</SelectItem></SelectContent>
      </Select>
      <Select value={condition.listId ? String(condition.listId) : ""} onValueChange={(v) => onChange({ ...condition, listId: Number(v) })}>
        <SelectTrigger className="w-[200px] h-8 text-xs"><SelectValue placeholder={lists.length ? "Choose a list" : "No lists yet"} /></SelectTrigger>
        <SelectContent>{lists.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name} ({l.memberCount})</SelectItem>)}</SelectContent>
      </Select>
    </>
  );
}

function EventFields({ condition, onChange }: { condition: Extract<Condition, { type: "event" }>; onChange: (c: Condition) => void }) {
  return (
    <>
      <Input className="w-[160px] h-8 text-xs" value={condition.metric} placeholder="metric name e.g. purchase" onChange={(e) => onChange({ ...condition, metric: e.target.value })} />
      <Select value={condition.op} onValueChange={(v) => onChange({ ...condition, op: v as any })}>
        <SelectTrigger className="w-[110px] h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value=">=">At least</SelectItem>
          <SelectItem value="=">Exactly</SelectItem>
          <SelectItem value=">">More than</SelectItem>
          <SelectItem value="<=">At most</SelectItem>
          <SelectItem value="<">Fewer than</SelectItem>
          <SelectItem value="zero">Never happened</SelectItem>
        </SelectContent>
      </Select>
      {condition.op !== "zero" && (
        <Input type="number" min={0} className="w-[70px] h-8 text-xs" value={condition.count ?? 1} onChange={(e) => onChange({ ...condition, count: Number(e.target.value) })} />
      )}
      <Input type="number" min={0} className="w-[130px] h-8 text-xs" value={condition.withinDays ?? ""} placeholder="within N days" onChange={(e) => onChange({ ...condition, withinDays: e.target.value ? Number(e.target.value) : undefined })} />
    </>
  );
}

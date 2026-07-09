// Marketing Suite — Campaigns list. "New campaign" opens the 4-step wizard at
// its own route (/admin/marketing/campaigns/new) so it's directly linkable;
// clicking a row opens the analytics detail page. Polls every 3s while any
// campaign is sending — same pattern as cufc-mailer.tsx / admin-mailer.tsx.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, Send, MessageSquare, Mail, Trash2 } from "lucide-react";
import type { MktCampaign } from "./types";
import { CampaignStatusBadge, EmptyState, LoadingRows, fmtDateTime } from "./ui";

const DELETABLE = new Set(["draft", "cancelled", "failed"]);

export default function CampaignsView() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [deleteTarget, setDeleteTarget] = useState<MktCampaign | null>(null);

  const { data: campaigns = [], isLoading } = useQuery<MktCampaign[]>({
    queryKey: ["/api/admin/marketing/campaigns"],
    refetchInterval: (q) => ((q.state.data as MktCampaign[] | undefined) ?? []).some((c) => c.status === "sending") ? 3000 : false,
  });

  const del = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/admin/marketing/campaigns/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/marketing/campaigns"] });
      setDeleteTarget(null);
      toast({ title: "Campaign deleted" });
    },
    onError: (e: any) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="mkt-campaign-new">
              <Plus className="w-4 h-4 mr-1.5" /> New campaign
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setLocation("/admin/marketing/campaigns/new?channel=email")} data-testid="mkt-campaign-new-email">
              <Mail className="w-4 h-4 mr-2" /> Email campaign
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setLocation("/admin/marketing/campaigns/new?channel=sms")} data-testid="mkt-campaign-new-sms">
              <MessageSquare className="w-4 h-4 mr-2" /> SMS campaign
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <LoadingRows rows={5} />
      ) : !campaigns.length ? (
        <EmptyState
          icon={Send}
          title="No campaigns yet — create your first"
          description="Pick an audience, write your email or SMS and send it — with the suppression gate and unsubscribe compliance built in automatically."
          action={<Button size="sm" className="mt-2" onClick={() => setLocation("/admin/marketing/campaigns/new?channel=email")}>Create your first campaign</Button>}
        />
      ) : (
        <div className="rounded-xl border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scheduled / sent</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => {
                const progressPct = c.status === "sending" && c.recipientCount > 0 ? Math.round((c.sentCount / c.recipientCount) * 100) : undefined;
                return (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => setLocation(`/admin/marketing/campaigns/${c.id}`)} data-testid={`mkt-campaign-row-${c.id}`}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {c.channel === "sms" ? <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                        {c.name}
                      </div>
                      {c.subject && <div className="text-xs text-muted-foreground truncate max-w-xs">{c.subject}</div>}
                    </TableCell>
                    <TableCell><CampaignStatusBadge status={c.status} progressPct={progressPct} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDateTime(c.sentAt || c.scheduledAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.status === "draft" ? "—" : `${c.sentCount}/${c.recipientCount}`}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {DELETABLE.has(c.status) && (
                        <Button size="icon" variant="ghost" className="text-red-500 hover:text-red-500" onClick={() => setDeleteTarget(c)} data-testid={`mkt-campaign-delete-${c.id}`}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AlertDialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
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

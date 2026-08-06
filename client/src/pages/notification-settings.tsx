// ─────────────────────────────────────────────────────────────────────────────
// Notification settings — universal, like Chat and Feedback. One person's
// preferences, not a workspace's: reachable from the sidebar's System section
// in every workspace, and answers identically wherever you're standing.
//
// Drives server/notification-routes.ts, whose logic lives in
// shared/notifications.ts (DEFAULT_PREFERENCES, EVENT_LABELS, DELIVERY_LABELS)
// — imported directly rather than retyped, so the web and mobile settings
// screens can never drift in wording.
// ─────────────────────────────────────────────────────────────────────────────
import type { ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bell, Mail, Smartphone, Eye, MoonStar, CalendarClock, Send, Loader2,
  MessageCircle, AtSign, Hash, ListChecks, Clock3, CheckCircle2, AlertTriangle,
} from "lucide-react";
import {
  DELIVERY_MODES,
  NOTIFICATION_EVENTS,
  EVENT_LABELS,
  DELIVERY_LABELS,
  DEFAULT_PREFERENCES,
  type NotificationPreferences,
  type NotificationEvent,
  type DeliveryMode,
} from "@shared/notifications";

type PrefsResponse = { preferences: NotificationPreferences; deviceCount: number };
type TestResponse = { ok: boolean; deviceCount: number; sent?: number; failed?: number; message?: string };

const QK = ["/api/admin/notifications/preferences"];

// Icons are purely decorative labelling here — kept neutral (white/opacity),
// not colour-coded, so a new hue is never introduced that the light-mode
// polyfill in index.css (a hand-maintained allowlist, not a generic rule)
// hasn't already been taught to remap.
const EVENT_ICONS: Record<NotificationEvent, typeof MessageCircle> = {
  chat_dm: MessageCircle,
  chat_mention: AtSign,
  chat_channel: Hash,
  task_assigned: ListChecks,
  task_due: Clock3,
};

// A NotificationEvent ("chat_dm") and its field on NotificationPreferences
// ("chatDm") are spelled differently on purpose (event names read as an
// analytics key; preference fields read as camelCase JS) — this is the one
// place that bridges them.
const EVENT_PREF_KEY: Record<NotificationEvent, "chatDm" | "chatMention" | "chatChannel" | "taskAssigned" | "taskDue"> = {
  chat_dm: "chatDm",
  chat_mention: "chatMention",
  chat_channel: "chatChannel",
  task_assigned: "taskAssigned",
  task_due: "taskDue",
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 7, label: "Sunday" },
];

/** 0–23 → "8:00 pm". Matches how the quiet-hours/digest copy talks about time elsewhere. */
function fmtHour(h: number): string {
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:00 ${h < 12 ? "am" : "pm"}`;
}

export default function NotificationSettings() {
  const { toast } = useToast();
  const { data, isLoading } = useQuery<PrefsResponse>({ queryKey: QK });
  // A missing row isn't "off" (see shared/notifications.ts) — while the first
  // load is in flight, showing the same defaults the server would hand back
  // means the switches never flash from "off" to "on" a second later.
  const prefs = data?.preferences ?? DEFAULT_PREFERENCES;
  const deviceCount = data?.deviceCount ?? 0;

  const patch = useMutation({
    mutationFn: async (body: Partial<NotificationPreferences>) => {
      const res = await apiRequest("PATCH", "/api/admin/notifications/preferences", body);
      return (await res.json()) as { preferences: NotificationPreferences };
    },
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey: QK });
      const previous = queryClient.getQueryData<PrefsResponse>(QK);
      queryClient.setQueryData<PrefsResponse>(QK, (old) =>
        old ? { ...old, preferences: { ...old.preferences, ...body } } : old,
      );
      return { previous };
    },
    onError: (e: Error, _body, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(QK, ctx.previous);
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QK }),
  });

  const set = <K extends keyof NotificationPreferences>(key: K, value: NotificationPreferences[K]) =>
    patch.mutate({ [key]: value } as Partial<NotificationPreferences>);

  const test = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/notifications/test");
      return (await res.json()) as TestResponse;
    },
    onSuccess: (r) => {
      if (r.deviceCount === 0) {
        // The server's own honest copy — never a generic "sent!" that would
        // claim push works when nothing was ever registered.
        toast({ title: "No phone registered", description: r.message, variant: "destructive" });
      } else if (r.ok) {
        toast({
          title: "Test sent",
          description: `Reached ${r.sent ?? r.deviceCount} of ${r.deviceCount} device${r.deviceCount === 1 ? "" : "s"}.`,
        });
      } else {
        toast({ title: "Test didn't send", description: r.message || "Something went wrong.", variant: "destructive" });
      }
    },
    onError: (e: Error) => toast({ title: "Test failed", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold text-white tracking-tight flex items-center gap-2" data-testid="text-page-title">
          <Bell className="w-5 h-5 text-blue-400" /> Notification settings
        </h1>
        <p className="text-sm text-white/40 mt-1 max-w-xl">
          What you hear about, how, and when. These are yours — they apply the same way in every workspace, on the web and on your phone.
        </p>
      </div>

      {/* Master switches + device status */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-white/80">Delivery channels</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            icon={<Smartphone className="w-4 h-4" />}
            title="Push notifications"
            help="Needs the ClubOS mobile app, signed in, with notifications allowed on your phone."
            checked={prefs.pushEnabled}
            onCheckedChange={(v) => set("pushEnabled", v)}
            testId="switch-push-enabled"
          />
          <ToggleRow
            icon={<Mail className="w-4 h-4" />}
            title="Email notifications"
            help="Sent to your ClubOS login email. Doesn't affect receipts, invoices or other transactional email."
            checked={prefs.emailEnabled}
            onCheckedChange={(v) => set("emailEnabled", v)}
            testId="switch-email-enabled"
          />

          <div className="border-t border-white/[0.06] pt-4">
            {deviceCount === 0 ? (
              <div
                className="flex items-start gap-2 text-[13px] text-amber-400 bg-amber-500/[0.06] border border-amber-500/15 rounded-lg px-3 py-2.5"
                data-testid="text-device-status"
              >
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>No phone is registered yet — push notifications won't reach you. Install the ClubOS app, sign in, and allow notifications when it asks.</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-emerald-400" data-testid="text-device-status">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>{deviceCount} device{deviceCount === 1 ? "" : "s"} registered for push.</span>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="mt-3 border-white/10 text-white/70"
              onClick={() => test.mutate()}
              disabled={test.isPending}
              data-testid="button-send-test"
            >
              {test.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {test.isPending ? "Sending…" : "Send test notification"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Per-event delivery mode */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-white/80">What you're notified about</CardTitle>
          <p className="text-xs text-white/40 mt-1">Set each on its own — push, email, both, or off.</p>
        </CardHeader>
        <CardContent className="space-y-1">
          {NOTIFICATION_EVENTS.map((event) => {
            const Icon = EVENT_ICONS[event];
            const label = EVENT_LABELS[event];
            const key = EVENT_PREF_KEY[event];
            return (
              // Stacks below ~640px: side-by-side leaves the label about 150px
              // wide on a phone, which wrapped "When someone messages you
              // one-to-one." onto three lines next to a half-empty select.
              <div
                key={event}
                className="flex flex-col items-stretch gap-2 py-2.5 border-b border-white/[0.04] last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <span className="text-white/30 mt-0.5 shrink-0"><Icon className="w-4 h-4" /></span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white/85">{label.title}</div>
                    <div className="text-[12px] text-white/40">{label.help}</div>
                  </div>
                </div>
                <Select value={prefs[key]} onValueChange={(v) => set(key, v as DeliveryMode)}>
                  {/* Stacked, the select is indented to line up under the label
                      TEXT rather than the icon: w-4 (1rem) + gap-2.5 (0.625rem).
                      Taller trigger on mobile — 32px is under the tap-target floor. */}
                  <SelectTrigger
                    className="shrink-0 bg-white/[0.03] border-white/10 text-white/80 text-xs h-9 ml-[1.625rem] w-[calc(100%-1.625rem)] sm:h-8 sm:ml-0 sm:w-[150px]"
                    data-testid={`select-${event}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DELIVERY_MODES.map((m) => (
                      <SelectItem key={m} value={m}>{DELIVERY_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Message preview */}
      <Card className="premium-card border-white/[0.06]">
        <CardContent className="pt-5">
          <ToggleRow
            icon={<Eye className="w-4 h-4" />}
            title="Show message preview"
            help="Puts the message text on your lock screen. Staff chat can carry a child's name or a parent's phone number — turn this off if anyone else can see your phone."
            checked={prefs.showPreview}
            onCheckedChange={(v) => set("showPreview", v)}
            testId="switch-show-preview"
          />
        </CardContent>
      </Card>

      {/* Quiet hours */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-white/80 flex items-center gap-2">
            <MoonStar className="w-4 h-4 text-white/40" /> Quiet hours
          </CardTitle>
          <p className="text-xs text-white/40 mt-1">
            Silences push and email in this window. The message still arrives and still badges — quiet hours mute the buzz, not the record.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <ToggleRow
            title="Quiet hours"
            help={`Currently ${fmtHour(prefs.quietHoursStart)} – ${fmtHour(prefs.quietHoursEnd)}, New Zealand time.`}
            checked={prefs.quietHoursEnabled}
            onCheckedChange={(v) => set("quietHoursEnabled", v)}
            testId="switch-quiet-hours"
          />
          {prefs.quietHoursEnabled && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/40 mb-1.5 block">Starts</Label>
                <HourSelect value={prefs.quietHoursStart} onChange={(v) => set("quietHoursStart", v)} testId="select-quiet-start" />
              </div>
              <div>
                <Label className="text-xs text-white/40 mb-1.5 block">Ends</Label>
                <HourSelect value={prefs.quietHoursEnd} onChange={(v) => set("quietHoursEnd", v)} testId="select-quiet-end" />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Digests */}
      <Card className="premium-card border-white/[0.06]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-white/80 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-white/40" /> Digests
          </CardTitle>
          <p className="text-xs text-white/40 mt-1">Opt-in email summaries — nothing you're not already set to see.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <ToggleRow
              title="Daily digest"
              help="One email a day, summarising what happened."
              checked={prefs.dailyDigest}
              onCheckedChange={(v) => set("dailyDigest", v)}
              testId="switch-daily-digest"
            />
            {prefs.dailyDigest && (
              <div className="mt-3 max-w-[180px]">
                <Label className="text-xs text-white/40 mb-1.5 block">Sent at</Label>
                <HourSelect value={prefs.dailyDigestHour} onChange={(v) => set("dailyDigestHour", v)} testId="select-daily-digest-hour" />
              </div>
            )}
          </div>
          <div className="border-t border-white/[0.06] pt-5">
            <ToggleRow
              title="Weekly digest"
              help="One email a week, summarising the week."
              checked={prefs.weeklyDigest}
              onCheckedChange={(v) => set("weeklyDigest", v)}
              testId="switch-weekly-digest"
            />
            {prefs.weeklyDigest && (
              <div className="mt-3 grid grid-cols-2 gap-3 max-w-sm">
                <div>
                  <Label className="text-xs text-white/40 mb-1.5 block">Day</Label>
                  <Select
                    value={String(prefs.weeklyDigestDay)}
                    onValueChange={(v) => set("weeklyDigestDay", parseInt(v, 10))}
                  >
                    <SelectTrigger className="bg-white/[0.03] border-white/10 text-white/80 text-xs h-8" data-testid="select-weekly-digest-day">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEEKDAYS.map((d) => (
                        <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-white/40 mb-1.5 block">Sent at</Label>
                  <HourSelect value={prefs.weeklyDigestHour} onChange={(v) => set("weeklyDigestHour", v)} testId="select-weekly-digest-hour" />
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Small shared rows ─────────────────────────────────────────────────────────

function ToggleRow({ icon, title, help, checked, onCheckedChange, testId }: {
  icon?: ReactNode;
  title: string;
  help?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2.5 min-w-0 flex-1">
        {icon && <span className="text-white/30 mt-0.5 shrink-0">{icon}</span>}
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-white/85">{title}</div>
          {help && <div className="text-[12px] text-white/40 mt-0.5">{help}</div>}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} data-testid={testId} className="shrink-0 mt-0.5" />
    </div>
  );
}

function HourSelect({ value, onChange, testId }: { value: number; onChange: (v: number) => void; testId: string }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(parseInt(v, 10))}>
      <SelectTrigger className="bg-white/[0.03] border-white/10 text-white/80 text-xs h-8" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {HOURS.map((h) => (
          <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

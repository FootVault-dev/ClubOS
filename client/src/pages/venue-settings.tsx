import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useWorkspace } from "@/lib/workspace-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePickerInput } from "@/components/ui/time-picker-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings, Globe, Save, ExternalLink, Copy, Palette, Clock, Mail } from "lucide-react";
import type { VenueSettings } from "@shared/schema";

type FormState = {
  siteTitle: string;
  introText: string;
  brandColor: string;
  openingTime: string;
  closingTime: string;
  slotMinutes: number;
  minDurationMinutes: number;
  advanceBookingDays: number;
  gstRatePercent: string;
  contactEmail: string;
  contactPhone: string;
  footerText: string;
  paymentPolicy: string;
  successMessage: string;
};

export default function VenueSettingsPage() {
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const { toast } = useToast();

  const { data: settings, isLoading } = useQuery<VenueSettings>({
    queryKey: ["/api/admin/venue/settings", orgId],
    queryFn: async () => {
      const r = await fetch(`/api/admin/venue/settings?orgId=${orgId}`);
      if (!r.ok) throw new Error("Failed to load settings");
      return r.json();
    },
    enabled: !!orgId,
  });

  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    if (settings) {
      setForm({
        siteTitle: settings.siteTitle ?? "",
        introText: settings.introText ?? "",
        brandColor: settings.brandColor ?? "#6366f1",
        openingTime: settings.openingTime ?? "07:00",
        closingTime: settings.closingTime ?? "22:00",
        slotMinutes: settings.slotMinutes ?? 30,
        minDurationMinutes: settings.minDurationMinutes ?? 60,
        advanceBookingDays: settings.advanceBookingDays ?? 60,
        gstRatePercent: settings.gstRatePercent ?? "15.00",
        contactEmail: settings.contactEmail ?? "",
        contactPhone: settings.contactPhone ?? "",
        footerText: settings.footerText ?? "",
        paymentPolicy: settings.paymentPolicy ?? "",
        successMessage: settings.successMessage ?? "",
      });
    }
  }, [settings]);

  const save = useMutation({
    mutationFn: async (data: FormState) => apiRequest("PATCH", `/api/admin/venue/settings?orgId=${orgId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/venue/settings"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const previewUrl = `${window.location.origin}/book?slug=${currentOrg?.slug || ""}`;

  if (isLoading || !form) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-48 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Settings className="w-6 h-6 text-white/40" />
          <div>
            <h1 className="text-2xl font-bold text-white" data-testid="text-venue-settings-title">Booking Site</h1>
            <p className="text-sm text-white/40">Configure your customer-facing booking website</p>
          </div>
        </div>
        <Button
          onClick={() => save.mutate(form)}
          disabled={save.isPending}
          data-testid="button-save-settings"
        >
          <Save className="w-4 h-4 mr-1.5" /> {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>

      {/* Public link card */}
      <div className="rounded-2xl border border-blue-500/15 bg-blue-500/[0.04] p-4">
        <div className="flex items-start gap-3">
          <Globe className="w-5 h-5 text-blue-300 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-white font-medium">Your public booking site</div>
            <div className="text-xs text-white/60 mt-0.5">Send this link to customers, or point a custom domain like <code className="text-white/80">book.unitedsportscentre.com</code> at your app to use it as your primary URL.</div>
            <div className="flex items-center gap-2 mt-2">
              <Input
                readOnly
                value={previewUrl}
                className="bg-white/[0.04] border-white/10 text-white/80 text-xs font-mono"
                data-testid="input-public-url"
              />
              <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(previewUrl); toast({ title: "Copied" }); }} data-testid="button-copy-url">
                <Copy className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" variant="outline" onClick={() => window.open(previewUrl, "_blank")} data-testid="button-open-public">
                <ExternalLink className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Branding */}
      <Section icon={<Palette className="w-4 h-4" />} title="Branding & content">
        <Field label="Site title">
          <Input value={form.siteTitle} onChange={e => setForm({ ...form, siteTitle: e.target.value })} data-testid="input-site-title" />
        </Field>
        <Field label="Welcome / intro text" hint="Shown above the facility list. Markdown not supported.">
          <Textarea value={form.introText} onChange={e => setForm({ ...form, introText: e.target.value })} className="min-h-[80px]" data-testid="input-intro" />
        </Field>
        <Field label="Brand colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.brandColor}
              onChange={e => setForm({ ...form, brandColor: e.target.value })}
              data-testid="input-brand-color"
              className="h-10 w-14 rounded border border-white/10 bg-transparent"
            />
            <Input
              value={form.brandColor}
              onChange={e => setForm({ ...form, brandColor: e.target.value })}
              className="font-mono"
              data-testid="input-brand-color-hex"
            />
          </div>
        </Field>
        <Field label="Footer text">
          <Textarea value={form.footerText} onChange={e => setForm({ ...form, footerText: e.target.value })} className="min-h-[60px]" data-testid="input-footer" />
        </Field>
      </Section>

      {/* Hours / scheduling */}
      <Section icon={<Clock className="w-4 h-4" />} title="Hours & scheduling">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Opening time">
            <TimePickerInput value={form.openingTime} onChange={e => setForm({ ...form, openingTime: e.target.value })} data-testid="input-opening" />
          </Field>
          <Field label="Closing time">
            <TimePickerInput value={form.closingTime} onChange={e => setForm({ ...form, closingTime: e.target.value })} data-testid="input-closing" />
          </Field>
          <Field label="Slot length (minutes)">
            <Input type="number" min={15} step={15} value={form.slotMinutes} onChange={e => setForm({ ...form, slotMinutes: parseInt(e.target.value) || 30 })} data-testid="input-slot" />
          </Field>
          <Field label="Min booking duration (minutes)">
            <Input type="number" min={30} step={30} value={form.minDurationMinutes} onChange={e => setForm({ ...form, minDurationMinutes: parseInt(e.target.value) || 60 })} data-testid="input-min-duration" />
          </Field>
          <Field label="Advance booking window (days · 0 = unlimited)">
            <Input type="number" min={0} value={form.advanceBookingDays} onChange={e => { const n = parseInt(e.target.value); setForm({ ...form, advanceBookingDays: Number.isNaN(n) ? 0 : Math.max(0, n) }); }} data-testid="input-advance" />
          </Field>
          <Field label="GST rate (%)">
            <Input type="number" min={0} step={0.01} value={form.gstRatePercent} onChange={e => setForm({ ...form, gstRatePercent: e.target.value })} data-testid="input-gst" />
          </Field>
        </div>
      </Section>

      {/* Contact + policy */}
      <Section icon={<Mail className="w-4 h-4" />} title="Contact & policies">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Contact email">
            <Input type="email" value={form.contactEmail} onChange={e => setForm({ ...form, contactEmail: e.target.value })} data-testid="input-contact-email" />
          </Field>
          <Field label="Contact phone">
            <Input value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} data-testid="input-contact-phone" />
          </Field>
        </div>
        <Field label="Payment policy" hint="Shown to customers before payment.">
          <Textarea value={form.paymentPolicy} onChange={e => setForm({ ...form, paymentPolicy: e.target.value })} className="min-h-[60px]" data-testid="input-payment-policy" />
        </Field>
        <Field label="Success message" hint="Shown after a successful booking.">
          <Textarea value={form.successMessage} onChange={e => setForm({ ...form, successMessage: e.target.value })} className="min-h-[60px]" data-testid="input-success-message" />
        </Field>
      </Section>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate(form)} disabled={save.isPending} data-testid="button-save-settings-bottom">
          <Save className="w-4 h-4 mr-1.5" /> {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-blue-500/10 bg-white/[0.02] p-5 space-y-4">
      <div className="flex items-center gap-2 text-white/80 font-medium">
        <span className="text-white/50">{icon}</span> {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs text-white/60 mb-1.5 block">{label}</Label>
      {children}
      {hint && <p className="text-[11px] text-white/30 mt-1">{hint}</p>}
    </div>
  );
}

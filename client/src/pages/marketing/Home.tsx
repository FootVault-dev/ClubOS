// Marketing Suite — /admin/marketing. One router entry with internal
// sub-navigation pills (matches the cufc-mailer.tsx / content-calendar pattern
// rather than registering a distinct route per view — campaign wizard + detail
// are the only views that get their own URLs, since they need direct linking).
import { useState } from "react";
import { LayoutDashboard, Users, ListFilter, Send, Settings as SettingsIcon } from "lucide-react";
import DashboardView from "./Dashboard";
import AudienceView from "./Audience";
import SegmentsView from "./Segments";
import CampaignsView from "./Campaigns";
import SettingsView from "./Settings";

type View = "dashboard" | "audience" | "segments" | "campaigns" | "settings";

const NAV: { key: View; label: string; icon: any }[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "audience", label: "Audience", icon: Users },
  { key: "segments", label: "Segments", icon: ListFilter },
  { key: "campaigns", label: "Campaigns", icon: Send },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

export default function MarketingHome() {
  const [view, setView] = useState<View>("dashboard");

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Marketing</h1>
          <p className="text-sm text-muted-foreground mt-1">Email + SMS marketing — audience, segments, campaigns and honest analytics.</p>
        </div>
        <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 overflow-x-auto max-w-full">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = view === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setView(item.key)}
                data-testid={`marketing-nav-${item.key}`}
                className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-colors whitespace-nowrap ${
                  active ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      {view === "dashboard" && <DashboardView onOpenCampaigns={() => setView("campaigns")} />}
      {view === "audience" && <AudienceView />}
      {view === "segments" && <SegmentsView />}
      {view === "campaigns" && <CampaignsView />}
      {view === "settings" && <SettingsView />}
    </div>
  );
}

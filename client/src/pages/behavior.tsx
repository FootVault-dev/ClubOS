// Behavior tab — tab wiring only (T9). The site/page table, scroll-depth
// funnel, section-timing bars, top-clicked-elements list, hour-of-day heat
// strip, and journey flow land in T10, reading the T8 GET /api/admin/behavior/*
// endpoints (which read only the *_daily rollup tables, per AGENTS.md §6).
import { Activity } from "lucide-react";

export default function BehaviorPage() {
  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Activity className="w-6 h-6 text-white/60" />
          Behavior
        </h1>
        <p className="text-sm text-white/40 mt-1">
          Heatmaps, scroll depth, section timing, and journey flow from the site's behavioral tracker.
        </p>
      </div>
      <div className="rounded-2xl border border-dashed border-white/5 bg-transparent p-6 text-center text-white/30 text-sm">
        Dashboard build in progress — behavioral events are already being collected nightly.
      </div>
    </div>
  );
}

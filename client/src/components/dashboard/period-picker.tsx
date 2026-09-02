import { useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DatePickerInput } from "@/components/ui/date-picker-input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DASHBOARD_PERIODS,
  PERIOD_LABELS,
  nzTodayIso,
  type DashboardPeriod,
  type DateRange,
} from "@shared/dashboard";

/**
 * The period filter.
 *
 * 🔴 The dates use DatePickerInput, never `<input type="date">`. A native date
 * input renders the BROWSER's picker — Chrome's and Safari's look nothing
 * alike, so the same screen looked different on Daniel's Mac and Paul's. Every
 * control in this console is drawn by us so it is identical on every device.
 *
 * A segmented row on desktop, wrapping to two lines on a phone; "Custom" opens
 * a popover with two date pickers.
 *
 * The chosen period is lifted into the page and pushed into the URL, so a
 * dashboard someone is looking at can be sent to someone else and show the
 * same thing.
 */
const QUICK: DashboardPeriod[] = ["today", "7d", "30d", "ytd"];

export function PeriodPicker({
  period,
  custom,
  onChange,
}: {
  period: DashboardPeriod;
  custom: DateRange;
  onChange: (period: DashboardPeriod, custom?: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(custom);
  const today = nzTodayIso();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
        {QUICK.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            data-testid={`button-period-${p}`}
            aria-pressed={period === p}
            className={`px-2.5 sm:px-3 h-8 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap ${
              period === p
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={period === "custom" ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            data-testid="button-period-custom"
          >
            <CalendarRange className="w-3.5 h-3.5" />
            {period === "custom" ? `${custom.from} → ${custom.to}` : "Custom"}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 space-y-3">
          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <DatePickerInput
              value={draft.from}
              max={today}
              onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
              data-testid="input-custom-from"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <DatePickerInput
              value={draft.to}
              max={today}
              onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
              data-testid="input-custom-to"
            />
          </div>
          <Button
            className="w-full"
            size="sm"
            disabled={!draft.from || !draft.to}
            onClick={() => {
              // A backwards range is a slip, not an error — the server swaps
              // it too, so both ends agree rather than one silently correcting.
              const range =
                draft.from <= draft.to
                  ? draft
                  : { from: draft.to, to: draft.from };
              onChange("custom", range);
              setOpen(false);
            }}
            data-testid="button-apply-custom"
          >
            Apply
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { DASHBOARD_PERIODS };

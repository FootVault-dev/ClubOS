// Drop-in replacement for <Input type="date" />. Visually matches the
// existing dark "premium-input" look used across the admin, but opens a
// proper Popover + Calendar (Monday-first week, day-of-week header) on
// click instead of the browser's native date picker.
//
// Same value contract as the native input: ISO yyyy-mm-dd string, with
// onChange receiving an event-shaped object so existing form code keeps
// working without changes.

import * as React from "react";
import { format, parse, isValid as isValidDate } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DatePickerInputProps {
  value?: string;                      // ISO 'yyyy-mm-dd' (or '' / undefined)
  onChange?: (e: { target: { value: string } }) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  min?: string;                        // ISO date
  max?: string;
  fromYear?: number;
  toYear?: number;
  autoFocus?: boolean;
  title?: string;
  "data-testid"?: string;
}

function parseIso(value?: string): Date | undefined {
  if (!value) return undefined;
  const d = parse(value, "yyyy-MM-dd", new Date());
  return isValidDate(d) ? d : undefined;
}

function toIso(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function DatePickerInput({
  value,
  onChange,
  placeholder = "dd/mm/yyyy",
  disabled,
  className,
  min,
  max,
  fromYear,
  toYear,
  autoFocus,
  title,
  ...rest
}: DatePickerInputProps) {
  const [open, setOpen] = React.useState(false);
  const selected = parseIso(value);
  const minDate = parseIso(min);
  const maxDate = parseIso(max);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          data-testid={rest["data-testid"]}
          autoFocus={autoFocus}
          title={title}
          className={cn(
            // Match the existing dark input look exactly so this drops into
            // any existing form without restyling.
            "flex h-10 w-full items-center justify-between rounded-xl border bg-white/[0.03] border-white/[0.06] px-3 py-2 text-sm text-left text-white/80",
            "hover:bg-white/[0.05] focus:outline-none focus:border-blue-500/30 transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
            !selected && "text-white/30",
            className,
          )}
        >
          <span className="truncate">
            {selected ? format(selected, "dd MMM yyyy (EEE)") : placeholder}
          </span>
          <CalendarIcon className="h-4 w-4 text-white/30 flex-shrink-0 ml-2" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0 bg-popover text-popover-foreground border border-border rounded-xl shadow-2xl"
      >
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            if (d) {
              onChange?.({ target: { value: toIso(d) } });
              setOpen(false);
            }
          }}
          weekStartsOn={1}      // Monday first — NZ + AU + UK convention
          showOutsideDays
          fromDate={minDate}
          toDate={maxDate}
          fromYear={fromYear}
          toYear={toYear}
          captionLayout={fromYear || toYear ? "dropdown-buttons" : undefined}
          className="text-white"
          classNames={{
            months: "flex flex-col space-y-2",
            month: "space-y-2 p-3",
            caption: "flex justify-center pt-1 relative items-center text-white/80 font-semibold",
            caption_label: "text-sm font-semibold",
            nav: "space-x-1 flex items-center",
            nav_button: "h-7 w-7 bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] rounded-md inline-flex items-center justify-center text-white/70",
            nav_button_previous: "absolute left-2",
            nav_button_next: "absolute right-2",
            table: "w-full border-collapse",
            head_row: "flex",
            head_cell: "text-white/30 rounded-md w-9 font-medium text-[10px] uppercase tracking-wider",
            row: "flex w-full mt-1",
            cell: "h-9 w-9 text-center text-sm p-0 relative",
            day: "h-9 w-9 p-0 font-normal text-white/70 hover:bg-white/[0.06] rounded-md inline-flex items-center justify-center",
            day_today: "border border-blue-500/40 text-white",
            day_selected: "bg-blue-600 text-white hover:bg-blue-600 hover:text-white focus:bg-blue-600",
            day_outside: "text-white/20",
            day_disabled: "text-white/15 cursor-not-allowed",
            day_hidden: "invisible",
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

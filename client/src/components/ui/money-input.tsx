import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * MoneyInput — ALWAYS shows and edits DOLLARS ($600.00), never raw cents.
 *
 * The DB stores money as integer cents; humans think in dollars. Keep the
 * dollar string in form state and convert at the boundary:
 *   load:  value={centsToDollarInput(row.teamCostCents)}
 *   save:  teamCostCents: dollarInputToCents(form.teamCost)
 * (both live in "@/lib/format")
 *
 * This is the standard money field for ClubOS — use it everywhere going
 * forward. Do NOT expose "(cents)" inputs in the UI again.
 */
export function MoneyInput({
  value,
  onChange,
  placeholder = "0.00",
  className,
  ...props
}: {
  value: string;
  onChange: (value: string) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type">) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm text-white/40">
        $
      </span>
      <Input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) =>
          // digits and a single decimal point only
          onChange(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"))
        }
        className={cn("pl-7", className)}
        {...props}
      />
    </div>
  );
}

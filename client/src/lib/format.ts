export function formatCurrency(
  amount: number | string,
  options?: { decimals?: number; fromCents?: boolean }
): string {
  let value = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(value)) value = 0;
  if (options?.fromCents) value = value / 100;
  const decimals = options?.decimals ?? 2;
  return `$${value.toLocaleString("en-NZ", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// Money is stored in the DB as integer CENTS, but humans read and enter DOLLARS.
// These bridge a dollar-string text input <-> cents. Never surface raw cents in the UI.
// Load an existing value with centsToDollarInput(); save it back with dollarInputToCents().
export function centsToDollarInput(cents?: number | null): string {
  if (cents == null) return "";
  return (Math.round(cents) / 100).toString();
}

export function dollarInputToCents(value: string | number): number {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}

export function formatNumber(value: number | string): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(n)) return "0";
  return n.toLocaleString("en-NZ");
}

export function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

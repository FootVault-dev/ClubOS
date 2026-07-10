/**
 * Wire shapes for the public invoice API + the jsonb column payloads on
 * usg_invoices. Mirrors apps/invoices/src/lib/types.ts — the SPA's own copy of
 * this contract (that app ships without ClubOS, seeded from a local record, so
 * it keeps its own type file; this one is what the server actually produces).
 * If the two ever diverge, this file is the source of truth — ClubOS is the
 * system of record.
 */

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";

/** Derived-only view of status the admin UI and public page both render.
 *  Never stored — see the migration header for why 'overdue' isn't a column. */
export type DerivedInvoiceStatus = "draft" | "sent" | "overdue" | "paid" | "void";

export type GstTreatment = "inclusive" | "exclusive";

/** Brand the invoice/page wears. The SUPPLIER is always the GST-registered legal entity. */
export type InvoiceBrand = "siu" | "cufc";

export const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "void"];
export const INVOICE_BRANDS: InvoiceBrand[] = ["siu", "cufc"];
export const GST_TREATMENTS: GstTreatment[] = ["inclusive", "exclusive"];

export function isInvoiceStatus(v: unknown): v is InvoiceStatus {
  return typeof v === "string" && (INVOICE_STATUSES as string[]).includes(v);
}
export function isInvoiceBrand(v: unknown): v is InvoiceBrand {
  return typeof v === "string" && (INVOICE_BRANDS as string[]).includes(v);
}
export function isGstTreatment(v: unknown): v is GstTreatment {
  return typeof v === "string" && (GST_TREATMENTS as string[]).includes(v);
}

export interface Party {
  /** The legal entity. On a tax invoice this must be the GST-registered name. */
  legalName: string;
  /** Optional trading identity, e.g. "South Island United". */
  tradingAs?: string;
  addressLines: string[];
  email?: string;
  gstNumber?: string;
}

export interface InvoiceSpendRow {
  label: string;
  amountCents: number;
}

export interface InvoiceSpendSummary {
  label: string;
  rows: InvoiceSpendRow[];
  totalLabel: string;
}

export interface InvoiceLine {
  description: string;
  detail?: string;
  amountCents: number;
}

export interface InvoiceBankDetails {
  accountName: string;
  accountNumber: string;
  /** Shown to the payer so their transfer can be matched on the statement. */
  reference: string;
  particulars?: string;
  code?: string;
}

/** The wire shape of GET /api/public/invoices/:token. Never includes id,
 *  organizationId, or stripePaymentIntentId. */
export interface PublicInvoice {
  token: string;
  number: string;
  status: InvoiceStatus;

  isDraft: boolean;
  draftReasons: string[];

  brand: InvoiceBrand;

  issuedOn: string; // YYYY-MM-DD, NZ calendar day
  dueOn: string;
  termsLabel: string;

  supplier: Party;
  recipient: Party;
  recipientContactEmail?: string;

  title: string;
  intro?: string;

  spendSummary?: InvoiceSpendSummary;
  lines: InvoiceLine[];

  gstTreatment: GstTreatment;

  bank: InvoiceBankDetails;

  cardEnabled: boolean;
  surchargeNote: string;

  notes?: string[];
}

/**
 * SUPPLIER_BY_BRAND — the invoicing entity's own details, keyed by the public
 * brand the invoice/page wears. usg_invoices has no supplier columns: every
 * CUFC/SIU invoice comes from the SAME GST-registered legal entity
 * (Christchurch United Football Club Incorporated), so the supplier is a
 * constant per brand face, not per-row data to re-enter on every invoice.
 *
 * GST number confirmed by Daniel 2026-07-09 for CUFC-2026-001 (NZ Football) —
 * passes IRD's check-digit algorithm. Reused verbatim for CUFC-2026-002 (The
 * Drifter, siu brand).
 */
export const SUPPLIER_BY_BRAND: Record<InvoiceBrand, Party> = {
  siu: {
    legalName: "Christchurch United Football Club Incorporated",
    tradingAs: "South Island United",
    addressLines: ["466 Yaldhurst Road, Yaldhurst", "Christchurch 8042", "New Zealand"],
    email: "info@cufc.co.nz",
    gstNumber: "020-252-642",
  },
  cufc: {
    legalName: "Christchurch United Football Club Incorporated",
    addressLines: ["466 Yaldhurst Road, Yaldhurst", "Christchurch 8042", "New Zealand"],
    email: "info@cufc.co.nz",
    gstNumber: "020-252-642",
  },
};

/**
 * Where an invoice of each brand is served from.
 *
 * One Vercel app (`apps/invoices`) serves every invoice, with a per-brand domain
 * attached to it — the same shape as the partner proposal pages. Send an invoice
 * on the domain matching its brand, so the payer sees a hostname they recognise
 * next to a bank account number.
 *
 * ONLY list a domain here once it is actually attached and serving. An unattached
 * host produces a dead link on a page asking someone for money, which is worse
 * than a vercel.app URL. `invoice.cufc.co.nz` is NOT attached yet — cufc deliberately
 * falls back. `pay.southislandunited.com` remains attached and 307s to the
 * canonical `invoice.` host, because links were already shared on it.
 */
export const INVOICE_SITE_FALLBACK = "https://usg-invoices.vercel.app";

export const INVOICE_SITE_BASE_BY_BRAND: Record<InvoiceBrand, string> = {
  siu: "https://invoice.southislandunited.com", // live 2026-07-10 (pay.* 307s here)
  cufc: INVOICE_SITE_FALLBACK,                  // invoice.cufc.co.nz not yet attached
};

export function invoiceUrl(brand: InvoiceBrand, token: string): string {
  return `${INVOICE_SITE_BASE_BY_BRAND[brand] ?? INVOICE_SITE_FALLBACK}/i/${token}`;
}

/** Passed to the payer verbatim on every invoice — not a per-row column because
 *  it never varies (the surcharge policy is fixed, not negotiated per invoice). */
export const DEFAULT_SURCHARGE_NOTE =
  "Paying by card adds a processing fee equal to what our payment provider charges us — never more. Bank transfer is free.";

/** Derived, never stored — a stored "overdue" goes stale the day nobody runs a job. */
export function isInvoiceOverdue(status: InvoiceStatus, dueOnIso: string, todayIso: string): boolean {
  if (status === "paid" || status === "void") return false;
  return dueOnIso < todayIso;
}

export function deriveInvoiceStatus(
  status: InvoiceStatus,
  dueOnIso: string,
  todayIso: string,
): DerivedInvoiceStatus {
  if (status === "paid") return "paid";
  if (status === "void") return "void";
  if (isInvoiceOverdue(status, dueOnIso, todayIso)) return "overdue";
  return status; // "draft" | "sent"
}

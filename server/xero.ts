// Xero integration. OAuth2 connect + invoice push for paid print orders.
//
// Setup (one time per environment):
//   1. Create a Xero app at https://developer.xero.com/app/manage
//   2. Set redirect URI: https://app.usg.co.nz/api/integrations/xero/callback
//   3. Required scopes: openid profile email accounting.transactions
//      accounting.contacts offline_access
//   4. Set XERO_CLIENT_ID + XERO_CLIENT_SECRET in env
//
// Token lifetime: access tokens are 30 minutes, refresh tokens 60 days.
// We refresh on every API call where the access token is within 5 min of
// expiry. If the refresh token expires (60 days idle), the user has to
// reconnect.

import { XeroClient, type Invoice, type LineItem, type Phone, type Contact } from "xero-node";
import { db } from "./db";
import { orgIntegrations, printXeroInvoices, type OrgIntegration, type PrintOrder, type PrintOrderItem } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { nzTodayIso } from "@shared/academy";

// ── Posting safety ───────────────────────────────────────────────────────────
// Nothing posts straight into the club's live ledger without a human saying so.
// Invoices are created as DRAFT unless XERO_AUTOPOST=1 is explicitly set, so
// connecting Xero can never silently start writing AUTHORISED invoices.
//
// The account codes below used to be hardcoded to Xero's NZ demo defaults
// ("200" Sales, "090" Business Bank Account). Those codes are not guaranteed to
// exist in CUFC's chart, and "090" is a BANK account — posting the gross invoice
// against it can never reconcile, because Stripe settles NET of its fees. Until a
// real Stripe clearing account exists in Xero and Victor confirms the codes, we
// refuse to guess.
const AUTOPOST = process.env.XERO_AUTOPOST === "1";
const SALES_ACCOUNT_CODE = process.env.XERO_SALES_ACCOUNT_CODE || "";
const CLEARING_ACCOUNT_CODE = process.env.XERO_CLEARING_ACCOUNT_CODE || "";

const REDIRECT_URI = process.env.XERO_REDIRECT_URI || "https://app.usg.co.nz/api/integrations/xero/callback";
// 🔴 This Xero app is on Xero's GRANULAR scopes, so the BROAD ones are refused
// with `invalid_scope` at the consent screen — the user never even reaches the
// Allow button. Probed one at a time against the live authorize endpoint on
// 2026-09-09: `accounting.transactions`, `accounting.transactions.read`,
// `accounting.reports.read` and `accounting.journals.read` are all rejected,
// while `accounting.settings`, `accounting.contacts` and `accounting.attachments`
// are fine. The list below is the exact set that was granted.
//
// The rejected scopes are the ones this file asked for until now, which is why
// the built-in connect flow had never successfully connected anything.
const SCOPES = [
  "openid", "profile", "email", "offline_access",
  // Writes a Receive Money for a Stripe payout — the granular replacement for
  // the refused `accounting.transactions`.
  "accounting.banktransactions",
  // The chart of accounts, tracking categories and tax rates.
  "accounting.settings.read",
  // The contact a payout document is filed against.
  "accounting.contacts",
  // Budget actuals. NOT `accounting.reports.read`, which this app refuses.
  "accounting.reports.profitandloss.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  // Term-fee deferral journals, later.
  "accounting.manualjournals",
];

function buildClient(): XeroClient {
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new Error("XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set");
  }
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID,
    clientSecret: process.env.XERO_CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    scopes: SCOPES,
  });
}

// Step 1: Build the Xero authorization URL. State carries the org id so we
// can attribute the connection on callback.
export async function buildAuthUrl(orgId: number): Promise<string> {
  const xero = buildClient();
  const state = Buffer.from(JSON.stringify({ orgId, ts: Date.now() })).toString("base64url");
  // The Xero SDK builds the consent URL. We attach state by replacing the
  // query string param after the fact, since buildConsentUrl doesn't expose it.
  const consentUrl = await xero.buildConsentUrl();
  const url = new URL(consentUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

// Step 2: Handle the callback — exchange the code for tokens, save against
// the org. Returns the connected tenant name for confirmation UI.
export async function handleCallback(callbackUrl: string, state: string): Promise<{ orgId: number; tenantName: string }> {
  const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
  const orgId = decoded.orgId as number;
  if (!orgId) throw new Error("Invalid state");

  const xero = buildClient();
  const tokenSet = await xero.apiCallback(callbackUrl);
  await xero.updateTenants(false);
  const tenants = xero.tenants;
  if (!tenants || tenants.length === 0) {
    throw new Error("No Xero organisations granted access");
  }
  // For multi-tenant Xero accounts we just take the first granted tenant.
  // A future v2 could let the user pick.
  const tenant = tenants[0];

  await db.insert(orgIntegrations)
    .values({
      organizationId: orgId,
      provider: "xero",
      isActive: true,
      accessToken: tokenSet.access_token,
      refreshToken: tokenSet.refresh_token,
      tokenExpiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
      externalId: tenant.tenantId,
      externalName: tenant.tenantName,
      configJson: { tenantType: tenant.tenantType },
      connectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [orgIntegrations.organizationId, orgIntegrations.provider],
      set: {
        isActive: true,
        accessToken: tokenSet.access_token,
        refreshToken: tokenSet.refresh_token,
        tokenExpiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
        externalId: tenant.tenantId,
        externalName: tenant.tenantName,
        connectedAt: new Date(),
        updatedAt: new Date(),
      },
    });

  return { orgId, tenantName: tenant.tenantName ?? "Xero" };
}

// Returns an authenticated Xero client for the given org, refreshing the
// access token if it's about to expire. Throws if no connection exists.
/**
 * Swap the refresh token for a new access token.
 *
 * 🔴 Deliberately NOT `xero.refreshToken()`. The SDK builds its OpenID client
 * lazily and that method throws "Cannot read properties of undefined (reading
 * 'refresh')" on a client that was only given a token set — which is every
 * client this file makes. The refresh path in this codebase had therefore never
 * once worked; it was simply never reached until a call landed more than 30
 * minutes after connecting. A plain POST to the token endpoint has no such
 * dependency.
 */
async function refreshAndStore(xero: XeroClient, connId: number, fallbackRefresh: string) {
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: fallbackRefresh }),
  });
  const t: any = await res.json();
  if (!t.access_token) throw new Error(`Xero refused to refresh the token: ${JSON.stringify(t).slice(0, 300)}`);
  // 🔴 Store the ROTATED refresh token before anything else can fail. Xero
  // invalidates the old one immediately, so losing this write costs the whole
  // connection and needs a human back at the consent screen.
  await db.update(orgIntegrations)
    .set({
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? fallbackRefresh,
      tokenExpiresAt: new Date(Date.now() + (t.expires_in ?? 1800) * 1000),
      updatedAt: new Date(),
    })
    .where(eq(orgIntegrations.id, connId));
  // The SDK holds its own copy; without this the refreshed token is stored but
  // the very next call still goes out with the dead one.
  await xero.setTokenSet({ access_token: t.access_token, refresh_token: t.refresh_token, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 1800) });
  return t;
}

/**
 * Run a Xero call, refreshing once if the token turns out to be dead.
 *
 * 🔴 Wrap every Xero API call in this. Checking an expiry before the call is a
 * guess about a clock; a 401 is the answer from Xero itself.
 */
export async function withXero<T>(orgId: number, fn: (xero: XeroClient, tenantId: string) => Promise<T>): Promise<T> {
  const { xero, tenantId } = await getXeroForOrg(orgId);
  try {
    return await fn(xero, tenantId);
  } catch (e: any) {
    if (e?.response?.statusCode !== 401) throw e;
    const [conn] = await db.select().from(orgIntegrations)
      .where(and(eq(orgIntegrations.organizationId, orgId), eq(orgIntegrations.provider, "xero"), eq(orgIntegrations.isActive, true)));
    if (!conn) throw e;
    await refreshAndStore(xero, conn.id, conn.refreshToken!);
    return await fn(xero, tenantId);
  }
}

export async function getXeroForOrg(orgId: number): Promise<{ xero: XeroClient; tenantId: string }> {
  const [conn] = await db.select().from(orgIntegrations)
    .where(and(eq(orgIntegrations.organizationId, orgId), eq(orgIntegrations.provider, "xero"), eq(orgIntegrations.isActive, true)));
  if (!conn || !conn.accessToken || !conn.refreshToken || !conn.externalId) {
    throw new Error("Xero not connected for this organisation");
  }

  const xero = buildClient();
  await xero.setTokenSet({
    access_token: conn.accessToken,
    refresh_token: conn.refreshToken,
    token_type: "Bearer",
    expires_at: conn.tokenExpiresAt ? Math.floor(conn.tokenExpiresAt.getTime() / 1000) : undefined,
  });

  // Refresh if expiring within 5 minutes.
  //
  // 🔴 `token_expires_at` is `timestamptz` for a reason. It was `timestamp`
  // WITHOUT a zone, so a JS Date round-tripped through New Zealand's offset and
  // this read "expires in 11.8 hours" for a token that had died 13 minutes
  // earlier — the refresh never fired and every call 401'd. A comparison against
  // a stored instant is only as good as that column's type.
  //
  // 🔴 And the clock is not trusted on its own: a token can be dead for reasons
  // this arithmetic cannot see (revoked, rotated elsewhere, a wrong server
  // clock), so `withXero` below retries once on a 401. Belt and braces, because
  // the failure is silent and only shows up as a broken post.
  const expiresIn = conn.tokenExpiresAt ? conn.tokenExpiresAt.getTime() - Date.now() : 0;
  if (expiresIn < 5 * 60 * 1000) await refreshAndStore(xero, conn.id, conn.refreshToken);

  return { xero, tenantId: conn.externalId };
}

export async function getOrgIntegration(orgId: number, provider: "xero" | "stripe"): Promise<OrgIntegration | null> {
  const [row] = await db.select().from(orgIntegrations)
    .where(and(eq(orgIntegrations.organizationId, orgId), eq(orgIntegrations.provider, provider)));
  return row ?? null;
}

export async function disconnectIntegration(orgId: number, provider: "xero" | "stripe"): Promise<void> {
  await db.update(orgIntegrations)
    .set({ isActive: false, accessToken: null, refreshToken: null, updatedAt: new Date() })
    .where(and(eq(orgIntegrations.organizationId, orgId), eq(orgIntegrations.provider, provider)));
}

// ── Push a paid print order to Xero ─────────────────────────────────────
// Creates a Xero invoice (status AUTHORISED — sent), then attaches a
// payment record marking it paid. Returns the Xero invoice number for
// reference.
export async function pushPaidOrderToXero(order: PrintOrder, items: PrintOrderItem[]): Promise<{ invoiceId: string; invoiceNumber: string }> {
  if (!order.organizationId) throw new Error("Order has no organization");

  // Refuse to guess an account code. A wrong code silently books revenue to the
  // wrong place in a real ledger, and nobody notices until year end.
  if (!SALES_ACCOUNT_CODE) {
    throw new Error(
      "XERO_SALES_ACCOUNT_CODE is not set. Refusing to post to a guessed account code. " +
      "Ask Victor for the correct sales account, then set XERO_SALES_ACCOUNT_CODE.",
    );
  }

  // Idempotency at the Xero boundary. The caller's `if (status === 'paid') return`
  // is a read-then-write check, so a webhook/self-heal race can reach here twice.
  // A duplicate AUTHORISED invoice in a live ledger is expensive to unwind.
  const [existing] = await db.select().from(printXeroInvoices)
    .where(eq(printXeroInvoices.printOrderId, order.id));
  if (existing?.xeroInvoiceId) {
    return { invoiceId: existing.xeroInvoiceId, invoiceNumber: existing.xeroInvoiceNumber ?? "" };
  }

  const { xero, tenantId } = await getXeroForOrg(order.organizationId);

  // NZ date, not UTC. `new Date().toISOString()` reports YESTERDAY in New Zealand
  // from midday UTC onward, which would date-stamp invoices into the wrong period.
  const today = nzTodayIso();

  // Build/find the contact
  const contactName = order.customerCompany || order.customerName;
  const contactEmail = order.customerEmail ?? undefined;
  const contactPhone = order.customerPhone ?? undefined;

  const phones: Phone[] = contactPhone
    ? [{ phoneType: "MOBILE" as any, phoneNumber: contactPhone }]
    : [];

  const contact: Contact = {
    name: contactName,
    emailAddress: contactEmail,
    phones: phones.length ? phones : undefined,
  };

  // Build line items — each print_order_item becomes one Xero line.
  // Subtotals are pre-GST. OUTPUT2 = NZ GST 15% on income (INPUT2 is purchases).
  const lineItems: LineItem[] = items.map(it => {
    const description = it.widthMm
      ? `${it.materialName} — ${it.widthMm}×${it.heightMm}mm × ${it.quantity}${it.sides === 2 ? " (double-sided)" : ""}`
      : `${it.materialName} × ${it.quantity}`;
    return {
      description,
      quantity: 1,                           // We bundle qty into the unit amount via subtotal
      unitAmount: it.subtotalCents / 100,
      accountCode: SALES_ACCOUNT_CODE,
      taxType: "OUTPUT2",                    // NZ GST 15% on outgoing income
    };
  });

  const invoice: Invoice = {
    type: "ACCREC" as any,                   // Accounts receivable
    contact,
    date: today,
    dueDate: today,
    invoiceNumber: order.orderNumber ?? undefined,
    reference: order.orderNumber ?? undefined,
    lineItems,
    // DRAFT unless a human has explicitly turned on auto-posting.
    status: (AUTOPOST ? "AUTHORISED" : "DRAFT") as any,
    lineAmountTypes: "Exclusive" as any,
  };

  const invoicesRes = await xero.accountingApi.createInvoices(tenantId, { invoices: [invoice] });
  const created = invoicesRes.body.invoices?.[0];
  if (!created || !created.invoiceID) throw new Error("Xero did not return an invoice ID");

  // Attach a Payment so the invoice shows as paid.
  //
  // This MUST hit a Stripe clearing account, never the bank account directly.
  // The invoice is GROSS; Stripe deposits NET of its fee. Posting the gross
  // amount against the bank leaves the bank reconciliation permanently short by
  // the fee. The clearing account holds gross-in, and is cleared by the payout
  // (net) plus the fee expense — and should net to zero.
  //
  // A payment cannot be attached to a DRAFT invoice in Xero, so this only runs
  // when auto-posting is on and a clearing account has been configured.
  const paymentAmount = order.totalCents / 100;
  if (paymentAmount > 0 && order.status === "paid" && AUTOPOST) {
    if (!CLEARING_ACCOUNT_CODE) {
      console.warn(
        `[Xero] Invoice ${created.invoiceNumber} created but NO payment attached: ` +
        `XERO_CLEARING_ACCOUNT_CODE is unset. Refusing to post gross revenue against a bank account.`,
      );
    } else {
      try {
        await xero.accountingApi.createPayments(tenantId, {
          payments: [{
            invoice: { invoiceID: created.invoiceID },
            account: { code: CLEARING_ACCOUNT_CODE },
            date: today,
            amount: paymentAmount,
            reference: `Stripe ${order.stripePaymentIntentId ?? ""}`,
          }],
        });
      } catch (e: any) {
        // Don't fail the whole push if just the payment attachment fails —
        // the invoice itself is in Xero, Dima can mark it paid manually.
        console.warn(`[Xero] Invoice ${created.invoiceNumber} created but payment record failed: ${e.message}`);
      }
    }
  }

  // Persist the link. Record what actually happened in Xero, not what we hoped:
  // a DRAFT invoice with no payment attached is not "paid".
  const postedPaid = AUTOPOST && !!CLEARING_ACCOUNT_CODE && order.status === "paid";
  await db.insert(printXeroInvoices).values({
    printOrderId: order.id,
    xeroInvoiceId: created.invoiceID,
    xeroInvoiceNumber: created.invoiceNumber,
    status: postedPaid ? "paid" : AUTOPOST ? "sent" : "draft",
    pushedAt: new Date(),
    paidAt: postedPaid ? new Date() : null,
  } as any);

  await db.update(orgIntegrations)
    .set({ lastSyncedAt: new Date() })
    .where(and(eq(orgIntegrations.organizationId, order.organizationId), eq(orgIntegrations.provider, "xero")));

  return { invoiceId: created.invoiceID, invoiceNumber: created.invoiceNumber ?? "" };
}

// ── P&L collector for the Budget module (Phase 5a) ──────────────────────
// Pulls monthly Profit & Loss for the trailing N months and returns parsed
// rows ready to upsert into `xero_actuals`.

export interface PnlRow {
  period: string;
  section: string;
  account: string;
  amountCents: number;
}

function parsePnlReport(report: any, periodLabel: string): PnlRow[] {
  const out: PnlRow[] = [];
  if (!report) return out;
  let currentSection = "";
  function walk(rows: any[]) {
    for (const row of rows ?? []) {
      const rowType = row.rowType ?? row.RowType ?? "";
      const title = row.title ?? row.Title ?? "";
      if (rowType === "Section") {
        currentSection = title;
        walk(row.rows ?? row.Rows ?? []);
      } else if (rowType === "Row" || rowType === "SummaryRow") {
        const cells = row.cells ?? row.Cells ?? [];
        if (cells.length >= 2) {
          const account = String(cells[0]?.value ?? cells[0]?.Value ?? "").trim();
          const raw = String(cells[1]?.value ?? cells[1]?.Value ?? "0").replace(/,/g, "").trim();
          const amount = Number(raw);
          if (account && Number.isFinite(amount)) {
            out.push({
              period: periodLabel,
              section: currentSection,
              account,
              amountCents: Math.round(amount * 100),
            });
          }
        }
      }
    }
  }
  walk(report.rows ?? report.Rows ?? []);
  return out;
}

// Pull the trailing N monthly P&L reports for the org. Walks backwards from
// the given anchor month (defaults to today), returning all rows flattened.
export async function fetchTrailingMonthlyPnl(opts: {
  orgId: number;
  months: number;
  anchor?: Date;
}): Promise<{ rows: PnlRow[]; errors: string[] }> {
  const { xero, tenantId } = await getXeroForOrg(opts.orgId);
  const anchor = opts.anchor ?? new Date();
  const rows: PnlRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < opts.months; i++) {
    let m = anchor.getUTCMonth() + 1 - i;
    let y = anchor.getUTCFullYear();
    while (m <= 0) { m += 12; y -= 1; }
    const fromDate = `${y}-${String(m).padStart(2, "0")}-01`;
    const last = new Date(y, m, 0).getDate();
    const toDate = `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    const period = `${y}-${String(m).padStart(2, "0")}`;
    try {
      const r = await xero.accountingApi.getReportProfitAndLoss(
        tenantId,
        fromDate, toDate,
        1,            // periods
        "MONTH",      // timeframe
        undefined, undefined, undefined, undefined,
        true,         // standardLayout
        false,        // paymentsOnly
      );
      const report = r.body.reports?.[0];
      rows.push(...parsePnlReport(report, period));
    } catch (e: any) {
      errors.push(`${period}: ${e?.message ?? String(e)}`);
    }
  }
  return { rows, errors };
}


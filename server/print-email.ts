// Transactional email templates for United Prints. Uses the existing
// Resend-backed sendEmail() helper. Plain-text-friendly HTML — every
// template should also read fine if the recipient's client strips styles.
//
// Each function is fire-and-forget: it logs failures but never throws, so
// payment + status flows aren't blocked by email outages.

import { sendEmail } from "./email";
import type { PrintOrder, PrintOrderItem, PrintQuote, PrintQuoteItem } from "@shared/schema";

const FROM = "United Prints <orders@unitedprints.co.nz>";
const SHOP_PHONE = "0800 800 199";
const SHOP_ADDRESS = "466 Yaldhurst Road, Hornby, Christchurch";

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function statusLink(token: string): string {
  return `https://order.unitedprints.co.nz/print/order/${token}`;
}

function uploadLink(token: string): string {
  return `https://order.unitedprints.co.nz/print/order/${token}/upload`;
}

function paymentLink(token: string): string {
  return `https://order.unitedprints.co.nz/print/checkout/${token}`;
}

function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;background:#fafafa;margin:0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #eee;border-radius:14px;padding:32px">
      <div style="font-size:14px;font-weight:700;color:#111;margin-bottom:24px">United Prints · Christchurch</div>
      <h1 style="font-size:22px;font-weight:800;margin:0 0 16px;color:#111">${title}</h1>
      ${body}
      <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px" />
      <p style="font-size:12px;color:#888;line-height:1.6;margin:0">
        ${SHOP_ADDRESS}<br/>
        ${SHOP_PHONE} · orders@unitedprints.co.nz<br/>
        A brand of Christchurch United Football Club Inc.
      </p>
    </div>
  </body></html>`;
}

function ctaButton(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${href}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600;font-size:14px">${label}</a></p>`;
}

// Order placed — quote sent, awaiting payment
export async function emailOrderPlaced(order: PrintOrder, item: PrintOrderItem | undefined, artworkPath: string) {
  if (!order.customerEmail) return;
  const itemSummary = item
    ? `${item.quantity} × ${item.materialName}${item.widthMm ? ` (${item.widthMm}×${item.heightMm}mm)` : ""}`
    : order.title;

  const artworkLine = artworkPath === "design_help"
    ? `<p style="font-size:14px;line-height:1.6">Our design team will be in touch within one working day to start your design.</p>`
    : artworkPath === "upload_later"
      ? `<p style="font-size:14px;line-height:1.6">When you're ready, upload your artwork via the link below — anytime.</p>${ctaButton(uploadLink(order.magicLinkToken!), "Upload artwork")}`
      : `<p style="font-size:14px;line-height:1.6">Reply to this email with your artwork attached, or upload via the link below.</p>${ctaButton(uploadLink(order.magicLinkToken!), "Upload artwork")}`;

  const body = `
    <p style="font-size:14px;line-height:1.6">Hi ${order.customerName.split(" ")[0]},</p>
    <p style="font-size:14px;line-height:1.6">Thanks for your order. Here's what we're making for you:</p>
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      <strong>${order.orderNumber}</strong><br/>
      ${itemSummary}<br/>
      <span style="color:#666">Total ${money(order.totalCents)} incl GST · Ready by ${order.pickupReadyDate ?? "—"}</span>
    </div>
    ${artworkLine}
    <p style="font-size:14px;line-height:1.6">Your order is paid — we'll keep you posted as it moves through design, production, and finishing. Track it anytime:</p>
    ${ctaButton(statusLink(order.magicLinkToken!), "Track my order")}
  `;
  try {
    await sendEmail({ to: order.customerEmail, from: FROM, subject: `Order confirmed — ${order.orderNumber}`, html: shell("Your order is confirmed", body) });
  } catch (e) { console.error("[Print email] order placed failed:", e); }
}

// Quote sent — order created but payment not yet completed (used when Dima
// sends a manual quote, or as a recovery if the public-flow customer
// abandons checkout).
export async function emailQuoteSent(order: PrintOrder) {
  if (!order.customerEmail) return;
  const body = `
    <p style="font-size:14px;line-height:1.6">Hi ${order.customerName.split(" ")[0]},</p>
    <p style="font-size:14px;line-height:1.6">Here's your quote for <strong>${order.title}</strong>.</p>
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      <strong>${order.orderNumber}</strong><br/>
      Total <strong>${money(order.totalCents)}</strong> incl GST<br/>
      <span style="color:#666">Ready by ${order.pickupReadyDate ?? "—"} once paid</span>
    </div>
    ${ctaButton(paymentLink(order.magicLinkToken!), "Pay & confirm")}
    <p style="font-size:13px;color:#666">This quote is good for 14 days. Questions? Just reply.</p>
  `;
  try {
    await sendEmail({ to: order.customerEmail, from: FROM, subject: `Quote — ${order.orderNumber}`, html: shell("Your quote", body) });
  } catch (e) { console.error("[Print email] quote sent failed:", e); }
}

// Magic-link upload reminder
export async function emailUploadReminder(order: PrintOrder) {
  if (!order.customerEmail || !order.magicLinkToken) return;
  const body = `
    <p style="font-size:14px;line-height:1.6">Hi ${order.customerName.split(" ")[0]},</p>
    <p style="font-size:14px;line-height:1.6">Quick nudge — we're holding your order <strong>${order.orderNumber}</strong> waiting on your artwork.</p>
    ${ctaButton(uploadLink(order.magicLinkToken), "Upload artwork now")}
    <p style="font-size:13px;color:#666">No artwork yet? Reply to this email and we can chat about design help.</p>
  `;
  try {
    await sendEmail({ to: order.customerEmail, from: FROM, subject: `We're waiting on your artwork — ${order.orderNumber}`, html: shell("Send us your artwork", body) });
  } catch (e) { console.error("[Print email] upload reminder failed:", e); }
}

// Order ready for pickup
export async function emailOrderReady(order: PrintOrder) {
  if (!order.customerEmail) return;
  const body = `
    <p style="font-size:14px;line-height:1.6">Hi ${order.customerName.split(" ")[0]},</p>
    <p style="font-size:14px;line-height:1.6">Your order <strong>${order.orderNumber}</strong> is ready for pickup.</p>
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      ${SHOP_ADDRESS}<br/>
      Mon–Fri 8:30am–5pm<br/>
      ${SHOP_PHONE}
    </div>
    <p style="font-size:14px;line-height:1.6">Thanks for choosing United Prints.</p>
  `;
  try {
    await sendEmail({ to: order.customerEmail, from: FROM, subject: `Ready for pickup — ${order.orderNumber}`, html: shell("Your order is ready", body) });
  } catch (e) { console.error("[Print email] order ready failed:", e); }
}

// Quote received — the unitedprints.co.nz "Instant Quote" page. Sent to the
// customer immediately, best-effort, alongside emailQuoteRequestDima() below.
function quoteItemsTable(items: PrintQuoteItem[]): string {
  const rows = items.map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:13px">${it.designName || "Untitled"}${it.material ? ` · ${it.material}` : ""}${it.sizeLabel ? ` · ${it.sizeLabel}` : ""}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:13px;text-align:center">×${it.quantity}</td>
      <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:13px;text-align:right">${money(it.lineExGstCents)}</td>
    </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows}</table>`;
}

export async function emailQuoteReceivedCustomer(quote: PrintQuote, items: PrintQuoteItem[]) {
  if (!quote.customerEmail) return;
  const firstName = (quote.customerName || "there").split(" ")[0];
  const body = `
    <p style="font-size:14px;line-height:1.6">Hi ${firstName},</p>
    <p style="font-size:14px;line-height:1.6">Thanks for your quote request — we've received it. Here's your indicative estimate:</p>
    ${quoteItemsTable(items)}
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      Subtotal <strong>${money(quote.subtotalCents)}</strong> ex GST<br/>
      GST <strong>${money(quote.gstCents)}</strong><br/>
      <span style="color:#666">Indicative total <strong>${money(quote.totalCents)}</strong> incl GST</span>
    </div>
    <p style="font-size:14px;line-height:1.6">This is an indicative estimate — our team confirms your final price, usually within 3 hours.</p>
    <p style="font-size:13px;color:#666">Questions? Just reply to this email.</p>
  `;
  try {
    await sendEmail({
      to: quote.customerEmail,
      from: FROM,
      replyTo: "orders@unitedprints.co.nz",
      subject: "We've got your quote request — United Prints",
      html: shell("Your indicative quote", body),
    });
  } catch (e) { console.error("[Print email] quote received (customer) failed:", e); }
}

// Quote received — internal notification to Dima/orders inbox.
export async function emailQuoteRequestDima(quote: PrintQuote, items: PrintQuoteItem[]) {
  const body = `
    <p style="font-size:14px;line-height:1.6"><strong>New quote request</strong> from ${quote.customerName || "a customer"} — ${quote.customerEmail || "no email"}, ${quote.customerPhone || "no phone"}.</p>
    ${quoteItemsTable(items)}
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      Subtotal <strong>${money(quote.subtotalCents)}</strong> ex GST<br/>
      GST <strong>${money(quote.gstCents)}</strong><br/>
      Indicative total <strong>${money(quote.totalCents)}</strong> incl GST
    </div>
    ${quote.note ? `<p style="font-size:13px"><strong>Note:</strong> ${quote.note}</p>` : ""}
    ${ctaButton("https://app.usg.co.nz/admin/print-quotes", "Review in ClubOS")}
  `;
  try {
    await sendEmail({
      to: "orders@unitedprints.co.nz",
      from: FROM,
      replyTo: quote.customerEmail || undefined,
      subject: `New quote request — ${quote.customerName || "website"} — ${money(quote.totalCents)}`,
      html: shell("New quote request", body),
    });
  } catch (e) { console.error("[Print email] quote request (Dima) failed:", e); }
}

// Internal — Dima notification of a new order
export async function emailDimaNewOrder(order: PrintOrder, item: PrintOrderItem | undefined) {
  const itemSummary = item
    ? `${item.quantity} × ${item.materialName}${item.widthMm ? ` (${item.widthMm}×${item.heightMm}mm)` : ""}`
    : order.title;
  const body = `
    <p style="font-size:14px;line-height:1.6"><strong>New paid order</strong> just landed.</p>
    <div style="background:#fafafa;border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin:16px 0">
      <strong>${order.orderNumber}</strong> · ${money(order.totalCents)}<br/>
      ${order.customerName} (${order.customerEmail})<br/>
      ${order.customerPhone || ""}<br/>
      <strong>${itemSummary}</strong><br/>
      Ready by: ${order.pickupReadyDate ?? "—"}<br/>
      Delivery: ${order.deliveryMethod}
    </div>
    ${order.customerNotes ? `<p style="font-size:13px"><strong>Customer notes:</strong> ${order.customerNotes}</p>` : ""}
    ${ctaButton(`https://app.usg.co.nz/admin/print-orders/${order.id}`, "Open in ClubOS")}
  `;
  try {
    await sendEmail({ to: "orders@unitedprints.co.nz", from: FROM, subject: `New order ${order.orderNumber} — ${money(order.totalCents)}`, html: shell("New order", body) });
  } catch (e) { console.error("[Print email] dima notification failed:", e); }
}

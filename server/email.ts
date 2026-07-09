import { storage } from "./storage";
import { instrumentEmailHtml, type EmailUtmOptions } from "@shared/email-attribution";
import { recordEmailClickToken } from "./email-token";
import { campFromForOrg, fromForOrg } from "@shared/org-domains";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

export interface EmailAttachment {
  filename: string;
  content: string;       // base64-encoded
  contentType?: string;  // e.g. "text/calendar; charset=utf-8; method=REQUEST"
}

interface EmailParams {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text?: string;
  campId?: number;
  registrationId?: number;
  attachments?: EmailAttachment[];
  // When set (T14), rewrite ours-domain hrefs in `html` to carry utm_source=email
  // + medium/campaign (+ ci for broadcasts) before send. Opt-in per call so only
  // customer-facing broadcast/transactional mail is instrumented, not internal notes.
  utm?: EmailUtmOptions;
}

// Strip HTML to a plain-text approximation. Used as a fallback when callers
// don't supply their own `text`. Mailbox providers downgrade reputation for
// HTML-only mail (a common spam signal), so always sending both raises
// deliverability scores into the 9.5+ range.
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendEmail(params: EmailParams): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log("[Email] Skipping — RESEND_API_KEY not configured. Would have sent to:", params.to);
    console.log("[Email] Subject:", params.subject);
    return false;
  }

  // T14: instrument ours-domain links with utm (+ ci) when the caller opts in.
  // Defensive — a rewrite failure must never stop the send.
  let html = params.html;
  if (params.utm) {
    try { html = instrumentEmailHtml(params.html, params.utm); } catch { html = params.html; }
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: params.from,
        to: [params.to],
        reply_to: params.replyTo || undefined,
        subject: params.subject,
        html,
        text: params.text ?? htmlToText(html),
        attachments: params.attachments?.map(a => ({
          filename: a.filename,
          content: a.content,
          content_type: a.contentType,
        })),
      }),
    });

    const result = await res.json();
    const success = res.ok;

    try {
      await storage.createEmailLog({
        campId: params.campId || null,
        registrationId: params.registrationId || null,
        toEmail: params.to,
        subject: params.subject,
        body: html,
        providerMessageId: result.id || null,
      });
    } catch (e) {
      console.error("[Email] Failed to log email:", e);
    }

    if (!success) {
      console.error("[Email] API error:", JSON.stringify(result));
    }

    return success;
  } catch (error) {
    console.error("[Email] Request failed:", error);
    return false;
  }
}

function substituteVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

export async function sendConfirmationEmail(params: {
  registrationId: number;
  campId: number;
  parentEmail: string;
  parentName: string;
  childrenNames: string[];
  campName: string;
  campDates: string;
  location: string;
  totalPaid: string;
}): Promise<boolean> {
  const existing = await storage.getEmailLogByRegistration(params.registrationId);
  if (existing) {
    console.log("[Email] Confirmation already sent for registration", params.registrationId);
    return true;
  }

  const settings = await storage.getCampSettings(params.campId);

  // Brand the defaults by the club that owns the camp. Per-camp overrides in
  // camp_settings always win. Each workspace sends from its OWN verified domain
  // (see @shared/org-domains) — SIU → southislandunited.com, CUFC → cufc.co.nz.
  let orgId: number | undefined;
  let isSiu = false;
  try {
    const program = await storage.getProgram(params.campId);
    orgId = program?.organizationId ?? undefined;
    isSiu = orgId === 2; // South Island United — drives the black/gold body below
  } catch {}

  const defaultFrom = campFromForOrg(orgId);
  const defaultSubject = "Booking Confirmed — {{campName}}";
  const siuDefaultBody = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #000000, #1B3D24); padding: 32px; border-radius: 16px 16px 0 0; text-align: center;">
        <h1 style="color: #C59949; margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 1px;">Booking Confirmed</h1>
        <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0;">{{campName}}</p>
      </div>
      <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-top: 0; border-radius: 0 0 16px 16px;">
        <p style="color: #334155; font-size: 16px; margin: 0 0 16px;">Hi {{parentName}},</p>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          Thank you for booking! Here are your details:
        </p>
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 0 0 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Children</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{childrenList}}</td></tr>
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Dates</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{campDates}}</td></tr>
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Location</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{location}}</td></tr>
            <tr style="border-top: 1px solid #e2e8f0;"><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 0 6px;">Total Paid</td><td style="color: #1e293b; font-size: 16px; font-weight: 600; padding: 10px 0 6px; text-align: right;">{{totalPaid}}</td></tr>
          </table>
        </div>
        <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
          If you have any questions, reply to this email or contact us at info@cufc.co.nz
        </p>
      </div>
      <p style="text-align: center; color: #94a3b8; font-size: 11px; margin: 16px 0 0;">South Island United — Uniting the South</p>
    </div>
  `;
  const defaultBody = isSiu ? siuDefaultBody : `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #1e3a5f, #2563eb); padding: 32px; border-radius: 16px 16px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0; font-size: 24px;">Booking Confirmed!</h1>
        <p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">{{campName}}</p>
      </div>
      <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-top: 0; border-radius: 0 0 16px 16px;">
        <p style="color: #334155; font-size: 16px; margin: 0 0 16px;">Hi {{parentName}},</p>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          Thank you for booking! Here are your details:
        </p>
        <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 0 0 24px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Children</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{childrenList}}</td></tr>
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Dates</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{campDates}}</td></tr>
            <tr><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 6px 0;">Location</td><td style="color: #1e293b; font-size: 14px; padding: 6px 0; text-align: right;">{{location}}</td></tr>
            <tr style="border-top: 1px solid #e2e8f0;"><td style="color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 0 6px;">Total Paid</td><td style="color: #1e293b; font-size: 16px; font-weight: 600; padding: 10px 0 6px; text-align: right;">{{totalPaid}}</td></tr>
          </table>
        </div>
        <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 0;">
          If you have any questions, reply to this email or contact us at info@cufc.co.nz
        </p>
      </div>
      <p style="text-align: center; color: #94a3b8; font-size: 11px; margin: 16px 0 0;">Christchurch United Football Club</p>
    </div>
  `;

  const vars = {
    campName: params.campName,
    parentName: params.parentName,
    childrenList: params.childrenNames.join(", "),
    campDates: params.campDates,
    location: params.location,
    totalPaid: params.totalPaid,
  };

  const from = settings?.fromEmail || defaultFrom;
  const subject = substituteVars(settings?.confirmationEmailSubject || defaultSubject, vars);
  const html = substituteVars(settings?.confirmationEmailBody || defaultBody, vars);
  const replyTo = settings?.replyTo || "info@cufc.co.nz";

  return sendEmail({
    to: params.parentEmail,
    from,
    replyTo,
    subject,
    html,
    campId: params.campId,
    registrationId: params.registrationId,
  });
}

// ---------------------------------------------------------------------------
// Mini Football Leagues — team registration emails (black + gold brand)
// ---------------------------------------------------------------------------

const MFL_FROM = "Mini Football Leagues <noreply@minifootball.co.nz>";
const MFL_REPLY_TO = "minifootball@cufc.co.nz";
const MFL_LOGO_URL = "https://join.minifootball.co.nz/logos/mini-football-leagues.png";

function mflShell(opts: { heading: string; bodyHtml: string }): string {
  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#000000; padding:36px 16px;">
    <div style="max-width: 560px; margin: 0 auto;">
      <div style="text-align:center; padding:4px 0 26px;">
        <img src="${MFL_LOGO_URL}" alt="Mini Football Leagues" width="84" height="84" style="display:inline-block; width:84px; height:84px; margin:0 0 18px;" />
        <h1 style="color:#ffffff; margin:0; font-size:22px; font-weight:700; letter-spacing:-0.2px;">${opts.heading}</h1>
      </div>
      <div style="background:#101010; border:1px solid #242424; border-radius:18px; padding:28px; color:#e6e6e6;">
        ${opts.bodyHtml}
        <p style="color:#7d7d7d; font-size:13px; line-height:1.55; margin:26px 0 0; border-top:1px solid #1f1f1f; padding-top:18px;">
          Questions? Just reply to this email and we'll sort you out.
        </p>
      </div>
      <p style="text-align:center; color:#5a5a5a; font-size:11px; line-height:1.7; margin:22px 0 0;">
        Mini Football Leagues · Christchurch United Football Club<br/>United Sports Centre, Christchurch
      </p>
    </div>
  </div>`;
}

function mflRow(label: string, value: string, emphasise = false): string {
  return `<tr${emphasise ? ' style="border-top:1px solid #2a2a2a;"' : ""}>
    <td style="color:#8a8a8a; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; padding:${emphasise ? "10px 0 6px" : "6px 0"};">${label}</td>
    <td style="color:${emphasise ? "#d1b96e" : "#fff"}; font-size:${emphasise ? "16px" : "14px"}; font-weight:${emphasise ? "600" : "400"}; padding:${emphasise ? "10px 0 6px" : "6px 0"}; text-align:right;">${value}</td>
  </tr>`;
}

/**
 * MFL broadcast / newsletter — wraps the composer's rich HTML in the black+gold
 * MFL shell with the subject as the heading and a functional unsubscribe link.
 * Sent one-per-recipient (the mailer route batches). The unsubscribeUrl is a
 * per-recipient signed link the public /api/public/unsubscribe route honours.
 */
export async function sendLeagueBroadcastEmail(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  replyTo?: string;
  unsubscribeUrl: string;
  campId?: number;
  orgId?: number;        // T14: for the per-recipient ci click token
  campaignId?: number;   // T14: emailCampaigns.id — utm_campaign + ci key
}): Promise<boolean> {
  const unsubFooter = `
    <p style="color:#5a5a5a; font-size:11px; line-height:1.6; margin:18px 0 0; border-top:1px solid #1f1f1f; padding-top:14px;">
      You're receiving this because you registered a team or player with Mini Football Leagues.
      <a href="${params.unsubscribeUrl}" style="color:#8a8a8a; text-decoration:underline;">Unsubscribe</a>
    </p>`;
  // T14: instrument this recipient's ours-domain links with utm=email/broadcast +
  // a signed per-recipient ci token (resolvable to their email → identity bind on click).
  const ci = params.campaignId ? await recordEmailClickToken(params.orgId ?? null, params.campaignId, params.to) : null;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.replyTo || MFL_REPLY_TO,
    subject: params.subject,
    html: mflShell({ heading: params.subject, bodyHtml: params.bodyHtml + unsubFooter }),
    ...(params.campId ? { campId: params.campId } : {}),
    ...(params.campaignId ? { utm: { source: "email", medium: "broadcast", campaign: String(params.campaignId), ci } } : {}),
  });
}

/**
 * CIC broadcast / newsletter — wraps the composer's rich HTML in the CIC shell
 * (black + gold for the Youth tournament, navy + lime for Summer 7's) with the
 * subject as the heading and a per-recipient signed unsubscribe link. Sent
 * one-per-recipient (the mailer route batches).
 */
export async function sendCicBroadcastEmail(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  brand: "youth" | "7s";
  replyTo?: string;
  unsubscribeUrl: string;
  orgId?: number;        // T14: per-recipient ci click token
  campaignId?: number;   // T14: emailCampaigns.id — utm_campaign + ci key
}): Promise<boolean> {
  const ci = params.campaignId ? await recordEmailClickToken(params.orgId ?? null, params.campaignId, params.to) : null;
  const is7s = params.brand === "7s";
  const accent = is7s ? "#cffd5a" : "#c9a43e";
  const bg = is7s ? "#0a1122" : "#0b0b08";
  const card = is7s ? "#10131c" : "#141511";
  const border = is7s ? "#252a38" : "#2c2d23";
  const eyebrow = is7s ? "CIC Summer 7's" : "Christchurch International Cup";
  const from = is7s ? "CIC 7's <noreply@cic7s.com>" : "Christchurch International Cup <noreply@cicyouth.com>";
  const audienceLine = is7s
    ? "You're receiving this because you registered your interest in CIC Summer 7's."
    : "You're receiving this because your club or team is part of the Christchurch International Cup.";
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:${bg};padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:${accent};margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${eyebrow}</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${params.subject}</h1>
      </div>
      <div style="background:${card};border:1px solid ${border};border-radius:18px;padding:26px;color:#e6e6e6;font-size:14px;line-height:1.65;">
        ${params.bodyHtml}
        <p style="color:#5a5a5a;font-size:11px;line-height:1.6;margin:20px 0 0;border-top:1px solid ${border};padding-top:14px;">
          ${audienceLine}
          <a href="${params.unsubscribeUrl}" style="color:#8a8a8a;text-decoration:underline;">Unsubscribe</a>
        </p>
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">
        ${eyebrow} · Christchurch United Football Club<br/>United Sports Centre, Christchurch
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from,
    replyTo: params.replyTo || "info@cicyouth.com",
    subject: params.subject,
    html,
    ...(params.campaignId ? { utm: { source: "email", medium: "broadcast", campaign: String(params.campaignId), ci } } : {}),
  });
}

// ── CUFC (Christchurch United) branded email helpers ──────────────────────────
// The first-team brand — navy + blue on dark, from the verified cufc.co.nz
// sending domain (matches fromForOrg(1)).
const CUFC_FROM = "Christchurch United <noreply@cufc.co.nz>";
const CUFC_REPLY_TO = "info@cufc.co.nz";

/**
 * CUFC website contact notification → info@cufc.co.nz. Same shape as the CIC
 * and CUGC contact notifications; the enquiry is also saved to inbox_messages.
 */
export async function sendCufcContactNotification(params: {
  to: string; name: string; email: string; phone?: string; subject?: string; message: string; sourceUrl?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#7d8ba8;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("From", params.name || "—"),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
    ...(params.subject ? [row("Subject", params.subject)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#030711;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#7d95ff;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch United FC</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New Website Enquiry</h1>
      </div>
      <div style="background:#0c1226;border:1px solid #1d2a55;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:18px 0 0;white-space:pre-wrap;">${(params.message || "").replace(/</g, "&lt;")}</p>
        ${params.sourceUrl ? `<p style="color:#7d8ba8;font-size:11px;margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a6480;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Football Club · Christchurch, New Zealand
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: params.email || CUFC_REPLY_TO,
    subject: `New website enquiry${params.name ? ` from ${params.name}` : ""} — cufc.co.nz`,
    html,
  });
}

/**
 * CUFC broadcast / newsletter — wraps the composer's rich HTML in the navy
 * Christchurch United shell with the subject as the heading and a
 * per-recipient signed unsubscribe link. Sent one-per-recipient (the mailer
 * route batches through runBroadcastQueue).
 */
export async function sendCufcBroadcastEmail(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  replyTo?: string;
  unsubscribeUrl: string;
}): Promise<boolean> {
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#030711;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#7d95ff;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch United FC</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${params.subject}</h1>
      </div>
      <div style="background:#0c1226;border:1px solid #1d2a55;border-radius:18px;padding:26px;color:#e6e6e6;font-size:14px;line-height:1.65;">
        ${params.bodyHtml}
        <p style="color:#5a6480;font-size:11px;line-height:1.6;margin:20px 0 0;border-top:1px solid #1d2a55;padding-top:14px;">
          You're receiving this because you're part of the Christchurch United community.
          <a href="${params.unsubscribeUrl}" style="color:#8a94b8;text-decoration:underline;">Unsubscribe</a>
        </p>
      </div>
      <p style="text-align:center;color:#5a6480;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Football Club · Christchurch, New Zealand
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: params.replyTo || CUFC_REPLY_TO,
    subject: params.subject,
    html,
  });
}

/** Registration confirmation — adapts to pay-in-full / deposit+weekly / deposit+balance. */
export async function sendLeagueConfirmationEmail(params: {
  registrationId: number;
  programId: number;
  captainEmail: string;
  captainName: string;
  teamName: string;
  divisionName: string;          // "" hides the night row (multi-team orders)
  paymentMode: string;           // 'upfront' | 'deposit_weekly' | 'installment'
  amountPaidNow: string;         // formatted — charged today
  totalPrice: string;            // formatted — full order total
  weeklyAmount?: string;         // formatted — deposit_weekly
  weeksTotal?: number | null;    // deposit_weekly
  balanceDue?: string;           // formatted — installment
  balanceDueDate?: string;       // installment
}): Promise<boolean> {
  const isWeekly = params.paymentMode === "deposit_weekly";
  const isInstalment = params.paymentMode === "installment";
  const isFull = !isWeekly && !isInstalment;

  const rows = [
    mflRow("Team", params.teamName),
    ...(params.divisionName ? [mflRow("Night", params.divisionName)] : []),
    ...(isFull
      ? [mflRow("Paid today", params.amountPaidNow), mflRow("Status", "Paid in full", true)]
      : isWeekly
      ? [mflRow("Paid today (deposit)", params.amountPaidNow),
         mflRow(`Then weekly × ${params.weeksTotal ?? 8}`, `${params.weeklyAmount}/wk`),
         mflRow("Total", params.totalPrice, true)]
      : [mflRow("Paid today (deposit)", params.amountPaidNow),
         mflRow(`Balance on ${params.balanceDueDate}`, params.balanceDue || "", true)]),
  ].join("");

  const intro = isFull
    ? `You're locked in and <strong style="color:#d1b96e;">paid in full</strong>. See you on the pitch! ⚽`
    : isWeekly
    ? `You're <strong style="color:#d1b96e;">locked in</strong>. We've taken your deposit today — the rest is split into <strong>${params.weeksTotal ?? 8} weekly payments of ${params.weeklyAmount}</strong>, charged automatically to your card once the season starts. Nothing else to do.`
    : `Your spot is <strong style="color:#d1b96e;">locked in</strong>. We've taken your deposit — the remaining <strong>${params.balanceDue}</strong> is charged automatically on <strong>${params.balanceDueDate}</strong>.`;

  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.captainName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">${intro}</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <a href="https://join.minifootball.co.nz/league" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">View the league →</a>`;

  return sendEmail({
    to: params.captainEmail,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: isFull ? `You're in! ${params.teamName} — Mini Football Leagues` : `Spot locked in — ${params.teamName}`,
    html: mflShell({ heading: isFull ? "You're in! 🎉" : "Spot locked in", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
    utm: { medium: "transactional", campaign: "league-confirmation" },
  });
}

/** Split Pay — a squad member's share has been charged. Their personal receipt. */
export async function sendSplitShareReceiptEmail(params: {
  to: string;
  memberName: string;
  teamName: string;
  amountCents: number;
  registrationId?: number;
}): Promise<boolean> {
  const amount = `$${(params.amountCents / 100).toFixed(2)} NZD`;
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.memberName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      Your share of <strong>${params.teamName}</strong> is <strong style="color:#d1b96e;">paid</strong>. Thanks for chipping in — see you on the pitch! ⚽
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">
        ${mflRow("Team", params.teamName)}
        ${mflRow("Your share", amount, true)}
      </table>
    </div>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Your share is paid — ${params.teamName}`,
    html: mflShell({ heading: "Share paid ✓", bodyHtml }),
    ...(params.registrationId ? { registrationId: params.registrationId } : {}),
  });
}

/** Player Pay — the whole squad has paid; the captain's team is confirmed. */
export async function sendSplitTeamConfirmedEmail(params: {
  registrationId: number;
  programId: number;
  captainEmail: string;
  captainName: string;
  teamName: string;
  divisionName: string;   // "" hides the night row
  playerCount: number;
  totalCents: number;
}): Promise<boolean> {
  const total = `$${(params.totalCents / 100).toFixed(2)} NZD`;
  const rows = [
    mflRow("Team", params.teamName),
    ...(params.divisionName ? [mflRow("Night", params.divisionName)] : []),
    mflRow("Players paid", `${params.playerCount} / ${params.playerCount}`),
    mflRow("Team fee", total, true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.captainName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      Great news — your whole squad has paid, so <strong>${params.teamName}</strong> is <strong style="color:#d1b96e;">officially in</strong>. All ${params.playerCount} players have covered their share and the full team fee is settled. Nothing else to do — see you on the pitch! ⚽
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <a href="https://join.minifootball.co.nz/league" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">View the league →</a>`;
  return sendEmail({
    to: params.captainEmail,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Your team's in! ${params.teamName} — everyone's paid`,
    html: mflShell({ heading: "Your team's in! 🎉", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
    utm: { medium: "transactional", campaign: "league-team-confirmed" },
  });
}

/** Season Ticket Rewards — a tier unlocked. Sends the voucher code (or a custom-kit heads-up). */
export async function sendSeasonRewardEmail(params: {
  to: string; memberName: string; tierName: string; rewardLabel: string; voucherCode: string | null;
}): Promise<boolean> {
  const rows = [
    mflRow("Tier reached", params.tierName, false),
    mflRow("Reward", params.rewardLabel, true),
    ...(params.voucherCode ? [mflRow("Your code", params.voucherCode, true)] : []),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.memberName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      You've hit <strong style="color:#d1b96e;">${params.tierName}</strong> on Season Ticket Rewards — thanks for being part of the leagues! ${params.voucherCode ? `Use the code below at checkout for your <strong>${params.rewardLabel}</strong>.` : `You've unlocked your <strong>${params.rewardLabel}</strong> — we'll be in touch to sort it out.`}
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    ${params.voucherCode ? `<a href="https://join.minifootball.co.nz/league" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Enter a team →</a>` : ""}`;
  return sendEmail({
    to: params.to, from: MFL_FROM, replyTo: MFL_REPLY_TO,
    subject: `You've unlocked ${params.tierName} — Season Ticket Rewards`,
    html: mflShell({ heading: `${params.tierName} unlocked 🎉`, bodyHtml }),
    utm: { medium: "transactional", campaign: "league-season-reward" },
  });
}

/** Website contact-form enquiry → the MFL support inbox (info@minifootball.co.nz).
 *  Reply-To is the enquirer so staff can reply straight from their inbox. */
export async function sendMflContactNotification(params: {
  to: string; name: string; email: string; phone?: string; subject?: string; message: string; sourceUrl?: string;
}): Promise<boolean> {
  const rows = [
    mflRow("From", params.name || "—"),
    mflRow("Email", params.email || "—"),
    ...(params.phone ? [mflRow("Phone", params.phone)] : []),
    ...(params.subject ? [mflRow("Subject", params.subject)] : []),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:16px; font-weight:600; margin:0 0 14px;">New website enquiry</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:18px 0 0; white-space:pre-wrap;">${(params.message || "").replace(/</g, "&lt;")}</p>
    ${params.sourceUrl ? `<p style="color:#5a5a5a; font-size:11px; margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.email || MFL_REPLY_TO,
    subject: `New enquiry${params.name ? ` from ${params.name}` : ""} — minifootball.co.nz`,
    html: mflShell({ heading: "New enquiry", bodyHtml }),
  });
}

/** Waitlist confirmation → the captain who joined the league waitlist. */
export async function sendMflWaitlistConfirmation(params: {
  to: string; contactName: string; teamName: string; nights: string[];
}): Promise<boolean> {
  const firstName = (params.contactName || "").trim().split(/\s+/)[0] || "there";
  const nightsLabel = params.nights.join(", ") || "your chosen night";
  const bodyHtml = `
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:0;">Hey ${firstName},</p>
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:14px 0 0;">
      <strong style="color:#ffffff;">${params.teamName}</strong> is on the waitlist for <strong style="color:#d1b96e;">${nightsLabel}</strong>.
      Spots open when a team drops out or we add capacity — and the waitlist gets first call, in order.
    </p>
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:14px 0 0;">
      We'll email or call you the moment a spot opens. No payment needed until then.
    </p>
    <a href="https://join.minifootball.co.nz/league" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">See nights with spots left →</a>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `You're on the waitlist — ${params.teamName}`,
    html: mflShell({ heading: "You're on the waitlist ⚽", bodyHtml }),
    utm: { medium: "transactional", campaign: "mfl-waitlist" },
  });
}

/** Waitlist signup heads-up → the MFL coordinator (info@minifootball.co.nz).
 *  Reply-To is the captain so staff can reply straight from their inbox. */
export async function sendMflWaitlistNotification(params: {
  to: string; teamName: string; contactName: string; email: string; phone?: string; nights: string[];
}): Promise<boolean> {
  const rows = [
    mflRow("Team", params.teamName || "—"),
    mflRow("Captain", params.contactName || "—"),
    mflRow("Email", params.email || "—"),
    ...(params.phone ? [mflRow("Phone", params.phone)] : []),
    mflRow("Wants", params.nights.join(", ") || "—", true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:16px; font-weight:600; margin:0 0 14px;">New waitlist signup</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <p style="color:#8a8a8a; font-size:13px; line-height:1.6; margin:16px 0 0;">
      They're waiting on a sold-out night. When a spot opens, contact them first — manage the list in ClubOS → Leagues → Teams.
    </p>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.email || MFL_REPLY_TO,
    subject: `Waitlist: ${params.teamName} wants ${params.nights.join(", ") || "a spot"}`,
    html: mflShell({ heading: "New waitlist signup", bodyHtml }),
  });
}

/** CIC 7's "Register Your Interest" submission → the tournament team (info@cic7s.com).
 *  Reply-To is the registrant so staff can reply straight from their inbox. */
export async function sendCic7sRegistrationNotification(params: {
  to: string; firstName: string; lastName?: string; email: string;
  location?: string; phone?: string; category?: string; sourceUrl?: string;
}): Promise<boolean> {
  const fullName = `${params.firstName}${params.lastName ? ` ${params.lastName}` : ""}`.trim();
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("Name", fullName || "—"),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
    ...(params.location ? [row("Location", params.location)] : []),
    ...(params.category ? [row("Category", params.category)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0a1122;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <h1 style="color:#cffd5a;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">CIC 7's — New Registration of Interest</h1>
      </div>
      <div style="background:#10131c;border:1px solid #252a38;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        ${params.sourceUrl ? `<p style="color:#5a5a5a;font-size:11px;margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">
        CIC Summer 7's · Christchurch United Football Club<br/>This registration is also saved in ClubOS → Tournaments → CIC 7's → Registrations.
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "CIC 7's <noreply@cic7s.com>",
    replyTo: params.email || undefined,
    subject: `New CIC 7's registration${fullName ? ` — ${fullName}` : ""}${params.category ? ` (${params.category})` : ""}`,
    html,
  });
}

/** CIC Youth (cicyouth.com) "Register Your Interest" enquiry → the CIC inbox
 *  (info@cicyouth.com). Black + gold shell. Reply-To is the enquirer so staff
 *  can reply straight from their inbox. */
export async function sendCicContactNotification(params: {
  to: string; name: string; email: string; phone?: string; subject?: string; message: string; sourceUrl?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("From", params.name || "—"),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
    ...(params.subject ? [row("Subject", params.subject)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c9a43e;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch International Cup</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New Registration of Interest</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:18px 0 0;white-space:pre-wrap;">${(params.message || "").replace(/</g, "&lt;")}</p>
        ${params.sourceUrl ? `<p style="color:#5a5a5a;font-size:11px;margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch International Cup · Christchurch United Football Club<br/>This registration is also saved in ClubOS → Tournaments → CIC → Registrations.
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch International Cup <noreply@cicyouth.com>",
    replyTo: params.email || "info@cicyouth.com",
    subject: `New interest registration${params.name ? ` from ${params.name}` : ""} — cicyouth.com`,
    html,
  });
}

/** CIC — a club registered its interest (one or more age groups) via the
 *  cicyouth.com "Register Your Interest" form. Emails info@cicyouth.com. */
export async function sendCicInterestNotification(params: {
  to: string; firstName: string; lastName?: string; email: string; phone?: string;
  club?: string; location?: string; ageGroups: string[]; sourceUrl?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const name = `${params.firstName}${params.lastName ? " " + params.lastName : ""}`.trim();
  const chips = params.ageGroups.map((g) =>
    `<span style="display:inline-block;background:#c9a43e;color:#0b0b08;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px;margin:0 6px 6px 0;">${g}</span>`).join("");
  const rows = [
    row("Contact", name || "—"),
    ...(params.club ? [row("Club", params.club)] : []),
    ...(params.location ? [row("City", params.location)] : []),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c9a43e;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch International Cup</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New Registration of Interest</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#9aa0a6;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:18px 0 10px;">Age groups (${params.ageGroups.length})</p>
        <div>${chips || '<span style="color:#5a5a5a;font-size:13px;">None specified</span>'}</div>
        ${params.sourceUrl ? `<p style="color:#5a5a5a;font-size:11px;margin:18px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Football Club<br/>Saved in ClubOS → Tournaments → CIC → Registrations (organised by age group).
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch International Cup <noreply@cicyouth.com>",
    replyTo: params.email || "info@cicyouth.com",
    subject: `New interest registration${name ? ` from ${name}` : ""} — ${params.ageGroups.join(", ") || "CIC"}`,
    html,
  });
}

/** A new volunteer signed up via the cicyouth.com /volunteer form. Notifies staff
 *  so they can review + allocate them in ClubOS → CIC → Volunteers. CIC-branded. */
export async function sendCicVolunteerNotification(params: {
  to: string; firstName: string; lastName?: string; email: string; phone?: string;
  dateOfBirth?: string; location?: string; availability?: string[]; interests?: string[];
  isAcademyPlayer?: boolean; academyAgeGroup?: string; notes?: string; sourceUrl?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:130px;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const name = `${params.firstName}${params.lastName ? " " + params.lastName : ""}`.trim();
  const chip = (t: string) =>
    `<span style="display:inline-block;background:#2c2d23;color:#e9e4cf;font-weight:600;font-size:12px;padding:4px 10px;border-radius:999px;margin:0 6px 6px 0;">${t}</span>`;
  const rows = [
    row("Volunteer", name || "—"),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
    ...(params.dateOfBirth ? [row("Date of birth", params.dateOfBirth)] : []),
    ...(params.location ? [row("City", params.location)] : []),
    ...(params.isAcademyPlayer ? [row("Academy player", `Yes${params.academyAgeGroup ? ` · ${params.academyAgeGroup}` : ""} — needs volunteer hours`)] : []),
    ...(params.notes ? [row("Note", params.notes)] : []),
  ].join("");
  const avail = (params.availability || []).map(chip).join("");
  const interests = (params.interests || []).map(chip).join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c9a43e;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch International Cup</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New Volunteer Signup</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        ${avail ? `<p style="color:#9aa0a6;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:18px 0 10px;">Availability</p><div>${avail}</div>` : ""}
        ${interests ? `<p style="color:#9aa0a6;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin:18px 0 10px;">Keen to help with</p><div>${interests}</div>` : ""}
        ${params.sourceUrl ? `<p style="color:#5a5a5a;font-size:11px;margin:18px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Football Club<br/>Review + allocate in ClubOS → Tournaments → CIC → Volunteers.
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch International Cup <noreply@cicyouth.com>",
    replyTo: params.email || "info@cicyouth.com",
    subject: `New CIC volunteer${name ? ` — ${name}` : ""}${params.isAcademyPlayer ? " (academy)" : ""}`,
    html,
  });
}

/** Live chat — a website visitor started a new conversation. Notifies staff so
 *  they can jump into ClubOS → (workspace) → Live Chat and reply. Brand-agnostic. */
export async function sendChatNewConversationNotification(params: {
  to: string; brandName: string; fromEmail: string; accent?: string;
  visitorName?: string; visitorEmail?: string; visitorPhone?: string;
  message: string; sourceUrl?: string; adminUrl?: string;
}): Promise<boolean> {
  const accent = params.accent || "#c9a43e";
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("From", params.visitorName || "Website visitor"),
    ...(params.visitorEmail ? [row("Email", params.visitorEmail)] : []),
    ...(params.visitorPhone ? [row("Phone", params.visitorPhone)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:${accent};margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${params.brandName}</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New live chat message</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:18px 0 0;white-space:pre-wrap;">${(params.message || "").replace(/</g, "&lt;")}</p>
        ${params.sourceUrl ? `<p style="color:#5a5a5a;font-size:11px;margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}
        ${params.adminUrl ? `<div style="text-align:center;margin:22px 0 4px;"><a href="${params.adminUrl}" style="display:inline-block;background:${accent};color:#0b0b08;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:10px;">Reply in ClubOS</a></div>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">Reply live in ClubOS → Live Chat. The visitor is emailed when you respond.</p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: `${params.brandName} <${params.fromEmail}>`,
    replyTo: params.visitorEmail || undefined,
    subject: `New live chat${params.visitorName ? ` from ${params.visitorName}` : ""} — ${params.brandName}`,
    html,
  });
}

/** Live chat — staff replied while the visitor was away. Emails the visitor the
 *  reply so they come back to the conversation. Brand-agnostic. */
export async function sendChatReplyNotification(params: {
  to: string; brandName: string; fromEmail: string; replyTo?: string; accent?: string;
  visitorName?: string; agentName?: string; message: string; chatUrl?: string;
}): Promise<boolean> {
  const accent = params.accent || "#c9a43e";
  const hi = params.visitorName ? `Hi ${params.visitorName.split(" ")[0]},` : "Hi there,";
  const who = params.agentName ? `${params.agentName} from ${params.brandName}` : `The ${params.brandName} team`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:${accent};margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${params.brandName}</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">You have a reply</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <p style="color:#e6e6e6;font-size:14px;line-height:1.6;margin:0 0 14px;">${hi}</p>
        <p style="color:#9aa0a6;font-size:13px;margin:0 0 6px;">${who} replied to your message:</p>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:0;white-space:pre-wrap;border-left:3px solid ${accent};padding:2px 0 2px 14px;">${(params.message || "").replace(/</g, "&lt;")}</p>
        ${params.chatUrl ? `<div style="text-align:center;margin:24px 0 4px;"><a href="${params.chatUrl}" style="display:inline-block;background:${accent};color:#0b0b08;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:10px;">Continue the conversation</a></div>` : ""}
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">Just reply to this email and it reaches us too.</p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: `${params.brandName} <${params.fromEmail}>`,
    replyTo: params.replyTo || params.fromEmail,
    subject: `${params.agentName ? params.agentName + " replied" : "You have a reply"} — ${params.brandName}`,
    html,
  });
}

/** Club logo licence — a participating club's rep signed the CIC logo agreement
 *  (cicyouth.com/club-logo-agreement). Emails info@cicyouth.com the proof record. */
export async function sendClubLogoConsentNotification(params: {
  to: string; clubName: string; repName: string; repRole?: string; repEmail: string;
  repPhone?: string; licenceVersion: string; logoUploaded?: boolean; agreedAt: string;
  pdfBase64?: string; filename?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#9aa0a6;font-size:13px;width:130px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("Club", params.clubName),
    row("Representative", params.repName),
    ...(params.repRole ? [row("Role", params.repRole)] : []),
    row("Email", params.repEmail),
    ...(params.repPhone ? [row("Phone", params.repPhone)] : []),
    row("Licence version", `v${params.licenceVersion}`),
    row("Digital signature", params.repName),
    row("Signed at", new Date(params.agreedAt).toLocaleString("en-NZ")),
    ...(params.logoUploaded ? [row("Logo uploaded", "Yes")] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c9a43e;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch International Cup</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">Club Logo Licence — Signed</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#8a8f98;font-size:13px;line-height:1.6;margin:18px 0 0;">${params.repName} confirmed they are authorised to sign, that the club owns or is licensed to use its marks, and agreed to licence v${params.licenceVersion} granting CIC use of the club's crest on the CIC website and app.</p>
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">Recorded in ClubOS → Tournaments → CIC → Logo Consents.</p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch International Cup <noreply@cicyouth.com>",
    replyTo: params.repEmail,
    subject: `Club logo licence signed — ${params.clubName}`,
    html,
    attachments: params.pdfBase64
      ? [{ filename: params.filename || `CIC-Logo-Licence-${params.clubName}.pdf`, content: params.pdfBase64, contentType: "application/pdf" }]
      : undefined,
  });
}

// The club rep's OWN copy of what they signed — a friendly confirmation with the
// signed licence PDF attached (their proof, and good faith).
export async function sendClubLogoLicenceCopy(params: {
  to: string; clubName: string; repName: string; repRole?: string;
  licenceVersion: string; agreedAt: string; pdfBase64: string; filename: string;
}): Promise<boolean> {
  const firstName = params.repName.split(" ")[0] || params.repName;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#c9a43e;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch International Cup</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">Thanks, ${firstName} — you're all set</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <p style="color:#e6e6e6;font-size:15px;line-height:1.65;margin:0 0 14px;">Thank you for granting the Christchurch International Cup permission to feature <strong style="color:#ffffff;">${params.clubName}</strong>. Your crest can now appear across the CIC website and app — and, over time, our wider print, signage and merchandise.</p>
        <p style="color:#9aa0a6;font-size:14px;line-height:1.65;margin:0 0 6px;">Your signed copy of the licence (v${params.licenceVersion}) is attached to this email for your records.</p>
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">Questions? Just reply, or email info@cicyouth.com.</p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch International Cup <noreply@cicyouth.com>",
    replyTo: "info@cicyouth.com",
    subject: `Your signed logo licence — ${params.clubName}`,
    html,
    attachments: [{ filename: params.filename, content: params.pdfBase64, contentType: "application/pdf" }],
  });
}

export async function sendCugcContactNotification(params: {
  to: string; name: string; email: string; phone?: string; subject?: string; message: string; sourceUrl?: string;
}): Promise<boolean> {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#7d8ba8;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("From", params.name || "—"),
    row("Email", params.email || "—"),
    ...(params.phone ? [row("Phone", params.phone)] : []),
    ...(params.subject ? [row("Subject", params.subject)] : []),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#020a18;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#d9b10f;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch United Gymnastics Club</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">New Website Enquiry</h1>
      </div>
      <div style="background:#013590;border:1px solid #1c4aa8;border-radius:18px;padding:24px;">
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:18px 0 0;white-space:pre-wrap;">${(params.message || "").replace(/</g, "&lt;")}</p>
        ${params.sourceUrl ? `<p style="color:#7d8ba8;font-size:11px;margin:16px 0 0;">via ${params.sourceUrl}</p>` : ""}
      </div>
      <p style="text-align:center;color:#5a6480;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Gymnastics Club · Christchurch United Football Club<br/>This enquiry is also saved in ClubOS → Gymnastics → Inbox.
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: params.email || "info@cugc.co.nz",
    subject: `New website enquiry${params.name ? ` from ${params.name}` : ""} — cugc.co.nz`,
    html,
  });
}

// ── CUGC branded email shell ─────────────────────────────────────────────────
// White card + navy (#013590) crest header + gold (#d9b10f) eyebrow — the exact
// cugc.co.nz palette. Crest served from the live site (public URL, email-safe).
const CUGC_LOGO_URL = "https://cugc.co.nz/img/logo.png";
const cugcEsc = (s: string) => (s || "").replace(/</g, "&lt;");
const cugcMoney = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const cugcRow = (label: string, value: string, opts?: { strong?: boolean }) =>
  `<tr>
    <td style="padding:8px 0;color:#64748b;font-size:13px;width:140px;vertical-align:top;border-bottom:1px solid #eef2f9;">${label}</td>
    <td style="padding:8px 0;color:${opts?.strong ? "#013590" : "#191919"};font-size:14px;font-weight:${opts?.strong ? "800" : "600"};border-bottom:1px solid #eef2f9;">${value}</td>
  </tr>`;
function cugcEmailShell(opts: { headline: string; body: string; footerNote?: string }): string {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f1f4fa;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="background:#ffffff;border:1px solid #e3e9f5;border-radius:18px;overflow:hidden;">
        <div style="background:#013590;text-align:center;padding:30px 24px 26px;">
          <img src="${CUGC_LOGO_URL}" width="76" height="76" alt="United Gymnastics crest" style="display:block;margin:0 auto 14px;border:0;" />
          <p style="color:#d9b10f;margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;">Christchurch United Gymnastics Club</p>
          <h1 style="color:#ffffff;margin:0;font-size:23px;font-weight:800;letter-spacing:-0.2px;">${opts.headline}</h1>
        </div>
        <div style="padding:28px 28px 26px;">${opts.body}</div>
      </div>
      <p style="text-align:center;color:#8492af;font-size:11px;line-height:1.8;margin:20px 0 0;">
        ${opts.footerNote ? `${opts.footerNote}<br/>` : ""}Christchurch United Gymnastics Club · 466 Yaldhurst Rd, Christchurch<br/>
        <a href="https://cugc.co.nz" style="color:#013590;text-decoration:none;font-weight:600;">cugc.co.nz</a> ·
        <a href="https://www.instagram.com/unitedgymnasticsnz/" style="color:#013590;text-decoration:none;">Instagram</a> ·
        <a href="https://www.facebook.com/chchunitedRG/" style="color:#013590;text-decoration:none;">Facebook</a>
      </p>
    </div>
  </div>`;
}

/**
 * CUGC enrolment confirmation — fired by the CUGC Stripe webhook once payment
 * clears. Sent to the PARENT. Clean white-card CUGC branding with the crest;
 * the club's internal copy is the fuller sendCugcEnrolmentNotification below.
 * `amount` is in cents.
 */
export async function sendCugcEnrolmentConfirmation(params: {
  to: string;
  parentName: string;
  gymnastName: string;
  programName: string;
  optionLabel: string;
  sessionTime?: string;
  term?: string;
  amount: number; // cents
}): Promise<boolean> {
  const rows = [
    cugcRow("Gymnast", cugcEsc(params.gymnastName) || "—"),
    cugcRow("Program", cugcEsc(params.programName) || "—"),
    cugcRow("Option", cugcEsc(params.optionLabel) || "—"),
    ...(params.sessionTime ? [cugcRow("Session", cugcEsc(params.sessionTime))] : []),
    ...(params.term ? [cugcRow("Term", cugcEsc(params.term))] : []),
    cugcRow("Paid", cugcMoney(params.amount), { strong: true }),
  ].join("");
  const body = `
    <p style="color:#191919;font-size:15px;line-height:1.65;margin:0 0 6px;font-weight:700;">Hi ${cugcEsc(params.parentName) || "there"},</p>
    <p style="color:#3d3d3d;font-size:15px;line-height:1.65;margin:0 0 18px;">Thank you for enrolling with us — <strong style="color:#013590;">${cugcEsc(params.gymnastName)}'s place is confirmed</strong> and we can't wait to welcome them to the gym. Here are the details:</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 18px;">${rows}</table>
    <p style="color:#3d3d3d;font-size:14px;line-height:1.65;margin:0 0 4px;">We'll be in touch before the term starts with everything you need for the first session. Questions in the meantime? Just reply to this email or call us on <a href="tel:+6421535005" style="color:#013590;font-weight:600;text-decoration:none;">021 535 005</a>.</p>
    <p style="text-align:center;color:#013590;font-size:15px;font-style:italic;font-weight:600;margin:22px 0 0;">Be Bright, Be Beautiful, Be You.</p>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: "info@cugc.co.nz",
    subject: `Enrolment confirmed — ${params.gymnastName} · ${params.programName}`,
    html: cugcEmailShell({ headline: "Enrolment Confirmed ✓", body }),
  });
}

/**
 * CUGC enrolment notification — the CLUB's copy, sent to info@cugc.co.nz the
 * moment a paid registration lands. Full admin detail (contact, DOB, emergency,
 * medical, consent, source) so the team can action it without opening ClubOS.
 * Reply-to is the parent, so "Reply" goes straight to the family.
 */
export async function sendCugcEnrolmentNotification(params: {
  to: string;
  gymnastName: string;
  gymnastDob?: string;
  programName: string;
  optionLabel: string;
  sessionTime?: string;
  term?: string;
  amount: number;      // cents actually paid
  fullAmount?: number; // cents full price (shows a discount note when lower was paid)
  parentName: string;
  parentEmail: string;
  phone?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  medical?: string;
  photoConsent?: string;
  heardVia?: string;
}): Promise<boolean> {
  const discounted = typeof params.fullAmount === "number" && params.fullAmount > params.amount;
  const rows = [
    cugcRow("Gymnast", cugcEsc(params.gymnastName) || "—"),
    ...(params.gymnastDob ? [cugcRow("Date of birth", cugcEsc(params.gymnastDob))] : []),
    cugcRow("Program", cugcEsc(params.programName) || "—"),
    cugcRow("Option", cugcEsc(params.optionLabel) || "—"),
    ...(params.sessionTime ? [cugcRow("Session", cugcEsc(params.sessionTime))] : []),
    ...(params.term ? [cugcRow("Term", cugcEsc(params.term))] : []),
    cugcRow("Paid", `${cugcMoney(params.amount)}${discounted ? ` <span style="color:#64748b;font-weight:400;">(full price ${cugcMoney(params.fullAmount!)} — discount code used)</span>` : ""}`, { strong: true }),
    cugcRow("Parent / caregiver", cugcEsc(params.parentName) || "—"),
    cugcRow("Email", `<a href="mailto:${cugcEsc(params.parentEmail)}" style="color:#013590;text-decoration:none;font-weight:600;">${cugcEsc(params.parentEmail)}</a>`),
    ...(params.phone ? [cugcRow("Phone", cugcEsc(params.phone))] : []),
    ...(params.emergencyName || params.emergencyPhone
      ? [cugcRow("Emergency contact", cugcEsc([params.emergencyName, params.emergencyPhone].filter(Boolean).join(" · ")))]
      : []),
    ...(params.medical ? [cugcRow("Medical notes", cugcEsc(params.medical))] : []),
    ...(params.photoConsent ? [cugcRow("Photo consent", cugcEsc(params.photoConsent))] : []),
    ...(params.heardVia ? [cugcRow("Heard about us via", cugcEsc(params.heardVia))] : []),
  ].join("");
  const body = `
    <p style="color:#3d3d3d;font-size:15px;line-height:1.65;margin:0 0 18px;">A new enrolment has just come through <a href="https://cugc.co.nz" style="color:#013590;font-weight:600;text-decoration:none;">cugc.co.nz</a> — <strong style="color:#013590;">paid and confirmed</strong>. The family has received their confirmation email.</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 18px;">${rows}</table>
    <p style="color:#64748b;font-size:13px;line-height:1.65;margin:0;">Hit reply to email ${cugcEsc(params.parentName) || "the family"} directly, or manage this registration in <a href="https://app.usg.co.nz" style="color:#013590;font-weight:600;text-decoration:none;">ClubOS → Gymnastics → Registrations</a>.</p>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: params.parentEmail || "info@cugc.co.nz",
    subject: `New enrolment — ${params.gymnastName} · ${params.programName} · ${cugcMoney(params.amount)}`,
    html: cugcEmailShell({ headline: "New Enrolment 🎉", body, footerNote: "Internal notification for CUGC admins." }),
  });
}

// ── South Island United membership (public self-serve join) ─────────────────
const SIU_MEMBERSHIP_NOTIFY = "daniel@southislandunited.com"; // internal "new member" recipient
const siuEsc = (s: any) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string));
const siuMoney = (c: number) => `$${((c || 0) / 100).toLocaleString("en-NZ", { maximumFractionDigits: 0 })}`;
const siuPer = (i?: string) => (i === "monthly" ? " / month" : i === "lifetime" ? " (lifetime)" : " / year");

/** Member welcome — SIU black/gold, sent once payment clears. */
export async function sendMembershipWelcomeEmail(params: {
  to: string; memberName: string; tierName: string; amount: number; billingInterval?: string; benefits?: string[]; orgId?: number;
}): Promise<boolean> {
  const benefits = (params.benefits || []).map((b) => `<tr><td style="padding:5px 0;color:#e6e6e6;font-size:14px;line-height:1.5;">◆&nbsp;&nbsp;${siuEsc(b)}</td></tr>`).join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#000000,#1B3D24);padding:34px;border-radius:16px 16px 0 0;text-align:center;">
      <h1 style="color:#C59949;margin:0;font-size:24px;text-transform:uppercase;letter-spacing:1.5px;">Welcome to the Club</h1>
      <p style="color:rgba(255,255,255,0.85);margin:10px 0 0;font-size:14px;">${siuEsc(params.tierName)} Membership · South Island United</p>
    </div>
    <div style="background:#0A0A09;padding:32px;border:1px solid #1f1f1f;border-top:0;color:#e6e6e6;">
      <p style="font-size:16px;margin:0 0 14px;">Kia ora ${siuEsc(params.memberName) || "there"},</p>
      <p style="color:#b8b8b8;font-size:14px;line-height:1.65;margin:0 0 22px;">You're officially part of South Island United. Thank you for backing the club as we build something special in the OFC Pro League — your membership directly powers what we're creating.</p>
      <div style="background:#111;border:1px solid #242424;border-radius:12px;padding:20px;margin:0 0 22px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="color:#8c8c8c;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:12px;border-bottom:1px solid #242424;">Tier</td><td style="color:#C59949;font-size:15px;font-weight:600;text-align:right;padding-bottom:12px;border-bottom:1px solid #242424;">${siuEsc(params.tierName)}</td></tr>
          <tr><td style="color:#8c8c8c;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;padding-top:12px;">Paid</td><td style="color:#ffffff;font-size:15px;font-weight:700;text-align:right;padding-top:12px;">${siuMoney(params.amount)}${siuPer(params.billingInterval)}</td></tr>
        </table>
      </div>
      ${benefits ? `<p style="color:#8c8c8c;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 8px;">What's included</p><table style="width:100%;border-collapse:collapse;margin:0 0 22px;">${benefits}</table>` : ""}
      <p style="color:#b8b8b8;font-size:13px;line-height:1.6;margin:0;">We'll be in touch with everything you need to make the most of your membership. Questions? Just reply to this email.</p>
    </div>
    <p style="text-align:center;color:#8c8c8c;font-size:11px;margin:16px 0 0;">South Island United — Uniting the South</p>
  </div>`;
  return sendEmail({
    to: params.to,
    from: fromForOrg(params.orgId ?? 2, "South Island United"),
    replyTo: "info@southislandunited.com",
    subject: `Welcome to South Island United — ${params.tierName} Membership`,
    html,
  });
}

/** Internal "new member" notification — the club's copy. */
export async function sendMembershipNotificationEmail(params: {
  memberName: string; memberEmail: string; memberPhone?: string; tierName: string; amount: number; billingInterval?: string; orgId?: number;
}): Promise<boolean> {
  const row = (l: string, v: string) => `<tr><td style="padding:6px 0;color:#64748b;font-size:13px;">${l}</td><td style="padding:6px 0;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">${v}</td></tr>`;
  const html = `
  <div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#000000,#1B3D24);padding:24px;border-radius:14px 14px 0 0;">
      <h1 style="color:#C59949;margin:0;font-size:18px;">New Membership 🎉</h1>
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 14px 14px;padding:22px;">
      <p style="color:#334155;font-size:14px;margin:0 0 16px;">A new member just joined and <strong>paid</strong> via the SIU membership page. Their welcome email has been sent.</p>
      <table style="width:100%;border-collapse:collapse;">
        ${row("Member", siuEsc(params.memberName))}
        ${row("Email", `<a href="mailto:${siuEsc(params.memberEmail)}" style="color:#1B3D24;">${siuEsc(params.memberEmail)}</a>`)}
        ${params.memberPhone ? row("Phone", siuEsc(params.memberPhone)) : ""}
        ${row("Tier", siuEsc(params.tierName))}
        ${row("Paid", siuMoney(params.amount) + siuPer(params.billingInterval))}
      </table>
      <p style="color:#64748b;font-size:12px;margin:16px 0 0;">Manage in ClubOS → South Island United → Membership.</p>
    </div>
  </div>`;
  return sendEmail({
    to: SIU_MEMBERSHIP_NOTIFY,
    from: fromForOrg(params.orgId ?? 2, "South Island United Membership"),
    replyTo: params.memberEmail,
    subject: `New member — ${params.memberName} · ${params.tierName} · ${siuMoney(params.amount)}`,
    html,
  });
}

/**
 * CUGC free session (trial) booking confirmation — sent to the parent the
 * moment they book. Mirrors the enrolment-confirmation branding. The booking
 * is for a CONCRETE class date/time so coaches can plan and attendance can be
 * marked off in Gymnastics → Free Sessions.
 */
export async function sendCugcFreeSessionConfirmation(params: {
  to: string;
  parentName: string;
  childName: string;
  programName: string;
  sessionLabel: string;
  sessionDate: string; // ISO date
}): Promise<boolean> {
  const niceDate = (() => {
    try {
      return new Date(`${params.sessionDate}T09:00:00+12:00`).toLocaleDateString("en-NZ", {
        weekday: "long", day: "numeric", month: "long",
      });
    } catch { return params.sessionDate; }
  })();
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#7d8ba8;font-size:13px;width:120px;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;
  const rows = [
    row("Gymnast", params.childName || "—"),
    row("Program", params.programName || "—"),
    row("Date", niceDate),
    row("Session", params.sessionLabel || "—"),
    row("Cost", "Free"),
  ].join("");
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#020a18;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#d9b10f;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch United Gymnastics Club</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">Free Session Booked</h1>
      </div>
      <div style="background:#013590;border:1px solid #1c4aa8;border-radius:18px;padding:24px;">
        <p style="color:#e6e6e6;font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${(params.parentName || "there").replace(/</g, "&lt;")}, you're booked in — we'll see ${(params.childName || "your gymnast").replace(/</g, "&lt;")} at this class:</p>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
        <p style="color:#bcd0f0;font-size:13px;line-height:1.6;margin:18px 0 0;">Comfy clothes and a drink bottle — that's all they need. Arrive 10 minutes early so we can say hello and get them settled. Need to change the day? Just reply to this email.</p>
      </div>
      <p style="text-align:center;color:#5a6480;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Gymnastics Club · United Sports Centre, Hornby<br/>This booking is saved in ClubOS → Gymnastics → Free Sessions.
      </p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: "info@cugc.co.nz",
    subject: `Free session booked — ${params.childName} · ${niceDate}`,
    html,
  });
}

/** Internal heads-up to the club when a free session is booked. */
export async function sendCugcFreeSessionNotification(params: {
  to: string;
  childName: string;
  childAge?: number | null;
  parentName: string;
  email: string;
  phone?: string | null;
  programName: string;
  sessionLabel: string;
  sessionDate: string;
  notes?: string | null;
}): Promise<boolean> {
  const line = (label: string, value: string) =>
    `<p style="margin:4px 0;color:#e6e6e6;font-size:14px;"><span style="color:#7d8ba8;">${label}:</span> ${value}</p>`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#020a18;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="background:#013590;border:1px solid #1c4aa8;border-radius:18px;padding:24px;">
        <p style="color:#d9b10f;margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">New free session booking</p>
        ${line("Gymnast", `${params.childName}${params.childAge ? ` (age ${params.childAge})` : ""}`)}
        ${line("Program", params.programName)}
        ${line("Class", `${params.sessionLabel} — ${params.sessionDate}`)}
        ${line("Parent", params.parentName)}
        ${line("Email", params.email)}
        ${params.phone ? line("Phone", params.phone) : ""}
        ${params.notes ? line("Notes", params.notes.replace(/</g, "&lt;")) : ""}
        <p style="color:#bcd0f0;font-size:13px;line-height:1.6;margin:14px 0 0;">Manage it in ClubOS → Gymnastics → Free Sessions (mark attended / no-show / reschedule).</p>
      </div>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: params.email,
    subject: `Free session: ${params.childName} · ${params.sessionLabel} ${params.sessionDate}`,
    html,
  });
}

/** Balance instalment successfully collected. */
export async function sendLeagueBalancePaidEmail(params: {
  registrationId: number;
  programId: number;
  captainEmail: string;
  captainName: string;
  teamName: string;
  balancePaid: string;
}): Promise<boolean> {
  const bodyHtml = `
    <p style="color:#e6e6e6; font-size:16px; margin:0 0 16px;">Hi ${params.captainName},</p>
    <p style="color:#bdbdbd; font-size:14px; line-height:1.6; margin:0 0 24px;">
      We've collected the remaining balance of <strong style="color:#d1b96e;">${params.balancePaid}</strong> for
      <strong>${params.teamName}</strong>. Your team is now paid in full — nothing more to do. See you on the pitch!
    </p>`;

  return sendEmail({
    to: params.captainEmail,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Paid in full — ${params.teamName}`,
    html: mflShell({ heading: "Paid In Full", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
  });
}

/** Internal notification to the MFL coordinator when a team registers + pays. */
export async function sendLeagueSignupNotification(params: {
  programId: number;
  registrationId: number;
  bookingRef: string;
  captainName: string;
  captainEmail: string;
  captainPhone: string;
  paymentMode: string;        // 'upfront' | 'deposit_weekly' | 'installment'
  amountPaidNow: string;
  totalPrice: string;
  weeklyAmount?: string;
  weeksTotal?: number | null;
  teams: { name: string; night: string }[];
}): Promise<boolean> {
  const multi = params.teams.length > 1;
  const plan = params.paymentMode === "deposit_weekly"
    ? `Deposit + ${params.weeksTotal ?? 8} weekly (${params.weeklyAmount}/wk)`
    : params.paymentMode === "installment" ? "Deposit + balance" : "Paid in full";

  const teamRows = params.teams.map((t) => mflRow(t.night || "—", t.name || "Unnamed team")).join("");
  const captainRows = [
    mflRow("Captain", params.captainName || "—"),
    mflRow("Email", params.captainEmail || "—"),
    mflRow("Phone", params.captainPhone || "—"),
  ].join("");

  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">New team signup</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.6; margin:0 0 20px;">${multi ? `${params.teams.length} teams just registered and paid.` : `A team just registered and paid.`}</p>
    <div style="background:#000; border:1px solid #232323; border-radius:14px; padding:18px 20px; margin:0 0 14px;">
      <p style="color:#8a8a8a; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; margin:0 0 8px;">${multi ? "Teams (league / night)" : "Team (league / night)"}</p>
      <table style="width:100%; border-collapse:collapse;">${teamRows}</table>
    </div>
    <div style="background:#000; border:1px solid #232323; border-radius:14px; padding:18px 20px; margin:0 0 14px;">
      <table style="width:100%; border-collapse:collapse;">${captainRows}</table>
    </div>
    <div style="background:#000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">
        ${mflRow("Paid today", params.amountPaidNow)}
        ${mflRow("Order total", params.totalPrice)}
        ${mflRow("Plan", plan)}
        ${mflRow("Ref", `#${params.bookingRef}`, true)}
      </table>
    </div>`;

  return sendEmail({
    to: "info@minifootball.co.nz",
    from: MFL_FROM,
    replyTo: params.captainEmail || MFL_REPLY_TO,
    subject: `New MFL signup — ${multi ? `${params.teams.length} teams` : (params.teams[0]?.name || "team")}`,
    html: mflShell({ heading: "New Team Signup", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
  });
}

// ---------------------------------------------------------------------------
// Football Institute — new application notification (CUFC royal blue + gold,
// matching the marketing site at The Football Institute).
// ---------------------------------------------------------------------------

const FI_FROM = "CUFC Football Institute <noreply@cufc.co.nz>";
const FI_NOTIFY_TO = "academy@cufc.co.nz";

function fiRow(label: string, value: string): string {
  if (!value) return "";
  return `<tr>
    <td style="color:#8a93b8; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; padding:7px 0; vertical-align:top; white-space:nowrap;">${label}</td>
    <td style="color:#0c1640; font-size:14px; font-weight:500; padding:7px 0 7px 16px; text-align:right;">${value}</td>
  </tr>`;
}

/** Internal notification to the Academy inbox when a Football Institute application arrives. */
export async function sendFootballInstituteApplicationNotification(params: {
  applicantName: string;
  yearLevel?: string;
  position?: string;
  currentSchool?: string;
  currentClub?: string;
  parentName?: string;
  email: string;
  phone?: string;
  studentEmail?: string;
  videoUrl?: string;
  message?: string;
  intakeYear?: number;
}): Promise<boolean> {
  const rows = [
    fiRow("Year level", params.yearLevel || ""),
    fiRow("Position", params.position || ""),
    fiRow("Current school", params.currentSchool || ""),
    fiRow("Current club", params.currentClub || ""),
    fiRow("Intake", params.intakeYear ? String(params.intakeYear) : ""),
  ].join("");
  const contactRows = [
    fiRow("Parent / guardian", params.parentName || ""),
    fiRow("Email", params.email || ""),
    fiRow("Phone", params.phone || ""),
    fiRow("Student email", params.studentEmail || ""),
    fiRow("Video", params.videoUrl ? `<a href="${params.videoUrl}" style="color:#263996;">${params.videoUrl}</a>` : ""),
  ].join("");

  const bodyHtml = `
  <div style="background:#f4f6fb; padding:24px 12px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <div style="max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(135deg,#263996,#0c1640); padding:32px; border-radius:16px 16px 0 0; text-align:center; border-bottom:3px solid #D4AF37;">
        <h1 style="color:#ffffff; margin:0; font-size:22px;">New Football Institute Application</h1>
        <p style="color:#D4AF37; margin:8px 0 0; font-size:12px; text-transform:uppercase; letter-spacing:2px; font-weight:600;">United × Ao Tawhiti</p>
      </div>
      <div style="background:#ffffff; padding:28px; border:1px solid #e3e7f0; border-top:0; border-radius:0 0 16px 16px;">
        <p style="color:#0c1640; font-size:18px; font-weight:700; margin:0 0 4px;">${params.applicantName}</p>
        <p style="color:#5a6078; font-size:14px; margin:0 0 20px;">A new student-athlete has applied through the website.</p>
        <div style="background:#f7f8fb; border:1px solid #e3e7f0; border-radius:12px; padding:8px 18px; margin:0 0 14px;">
          <table style="width:100%; border-collapse:collapse;">${rows}</table>
        </div>
        <div style="background:#f7f8fb; border:1px solid #e3e7f0; border-radius:12px; padding:8px 18px; margin:0 0 14px;">
          <table style="width:100%; border-collapse:collapse;">${contactRows}</table>
        </div>
        ${params.message ? `<div style="background:#f7f8fb; border:1px solid #e3e7f0; border-radius:12px; padding:16px 18px;">
          <p style="color:#8a93b8; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; margin:0 0 8px;">Their message</p>
          <p style="color:#0c1640; font-size:14px; line-height:1.6; margin:0; white-space:pre-wrap;">${params.message}</p>
        </div>` : ""}
        <p style="color:#8a93b8; font-size:12px; margin:20px 0 0;">Manage this application in ClubOS → Football Institute.</p>
      </div>
    </div>
  </div>`;

  return sendEmail({
    to: FI_NOTIFY_TO,
    from: FI_FROM,
    replyTo: params.email || FI_NOTIFY_TO,
    subject: `New Football Institute application — ${params.applicantName}`,
    html: bodyHtml,
  });
}

// ---------------------------------------------------------------------------
// United Sports Centre — member booking-request emails (dark navy + indigo,
// matching the book.unitedsportscentre.com booking site).
// ---------------------------------------------------------------------------

const USC_FROM = "United Sports Centre <bookings@unitedsportscentre.com>";
const USC_REPLY_TO = "info@cufc.co.nz";
const USC_BRAND = "#6366f1";
const USC_LOGO_URL = "https://book.unitedsportscentre.com/logos/united-sports-group.png";

function uscShell(opts: { heading: string; sub?: string; bodyHtml: string; accent?: string }): string {
  const accent = opts.accent || USC_BRAND;
  return `
  <div style="background:#0a0e1a; padding:24px 12px; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
    <div style="max-width:600px; margin:0 auto;">
      <div style="background:linear-gradient(180deg, #11162a, #0d1222); padding:36px 32px 28px; border-radius:16px 16px 0 0; text-align:center; border:1px solid rgba(255,255,255,0.08); border-bottom:2px solid ${accent};">
        <img src="${USC_LOGO_URL}" alt="United Sports Centre" height="44" style="height:44px; width:auto; margin:0 0 16px;" />
        <h1 style="color:#ffffff; margin:0; font-size:24px; letter-spacing:0.3px;">${opts.heading}</h1>
        <p style="color:${accent}; margin:10px 0 0; font-size:12px; text-transform:uppercase; letter-spacing:2px; font-weight:600;">${opts.sub || "United Sports Centre"}</p>
      </div>
      <div style="background:#0d1222; padding:32px; border:1px solid rgba(255,255,255,0.08); border-top:0; border-radius:0 0 16px 16px; color:#e6e8f0;">
        ${opts.bodyHtml}
      </div>
      <p style="text-align:center; color:#5a6078; font-size:11px; margin:18px 0 0; line-height:1.6;">
        United Sports Centre · Operated by Christchurch United Football Club<br/>
        Questions? Email <a href="mailto:info@cufc.co.nz" style="color:#8b8fa8; text-decoration:underline;">info@cufc.co.nz</a>
      </p>
    </div>
  </div>`;
}

function uscRow(label: string, value: string, emphasise = false): string {
  return `<tr${emphasise ? ' style="border-top:1px solid rgba(255,255,255,0.08);"' : ""}>
    <td style="color:#8b8fa8; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; padding:${emphasise ? "12px 0 7px" : "7px 0"}; vertical-align:top;">${label}</td>
    <td style="color:${emphasise ? USC_BRAND : "#ffffff"}; font-size:${emphasise ? "16px" : "14px"}; font-weight:${emphasise ? "600" : "400"}; padding:${emphasise ? "12px 0 7px" : "7px 0"}; text-align:right;">${value}</td>
  </tr>`;
}

function uscCard(rows: string): string {
  return `<div style="background:#080c18; border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:20px; margin:0 0 8px;">
    <table style="width:100%; border-collapse:collapse;">${rows}</table>
  </div>`;
}

/** Staff notification — a new member booking request needs review. */
export async function sendBookingRequestNotificationEmail(params: {
  to: string;
  requestId: number;
  memberName: string;
  memberEmail: string;
  memberPhone: string;
  facilityName: string;
  sizeLabel: string | null;
  dateLong: string;
  timeRange: string;
  reviewUrl: string;
}): Promise<boolean> {
  const rows = [
    uscRow("Member", params.memberName),
    uscRow("Email", params.memberEmail),
    uscRow("Phone", params.memberPhone),
    uscRow("Facility", params.facilityName + (params.sizeLabel ? ` (${params.sizeLabel})` : "")),
    uscRow("Date", params.dateLong),
    uscRow("Time", params.timeRange, true),
  ].join("");

  const bodyHtml = `
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 20px;">
      A club member has requested a facility booking. They've agreed to the facility waiver —
      review and approve or decline the request in ClubOS.
    </p>
    ${uscCard(rows)}
    <p style="text-align:center; margin:24px 0 4px;">
      <a href="${params.reviewUrl}" style="display:inline-block; background:${USC_BRAND}; color:#ffffff; font-weight:600; font-size:14px; text-decoration:none; padding:14px 30px; border-radius:9999px;">Review request</a>
    </p>`;

  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: params.memberEmail,
    subject: `New booking request — ${params.facilityName}, ${params.dateLong} ${params.timeRange}`,
    html: uscShell({ heading: "New Member Booking Request", sub: `Request #${params.requestId}`, bodyHtml }),
  });
}

/** Member confirmation — their request was approved and the slot is theirs. */
export async function sendBookingRequestConfirmedEmail(params: {
  to: string;
  memberName: string;
  facilityName: string;
  sizeLabel: string | null;
  dateLong: string;
  timeRange: string;
  requestId: number;
}): Promise<boolean> {
  const rows = [
    uscRow("Facility", params.facilityName + (params.sizeLabel ? ` (${params.sizeLabel})` : "")),
    uscRow("Date", params.dateLong),
    uscRow("Time", params.timeRange, true),
  ].join("");

  const bodyHtml = `
    <p style="color:#e6e8f0; font-size:16px; margin:0 0 16px;">Hi ${params.memberName},</p>
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 24px;">
      Great news — your booking request has been <strong style="color:${USC_BRAND};">approved</strong>.
      Your slot at the United Sports Centre is confirmed:
    </p>
    ${uscCard(rows)}
    <div style="background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.25); border-radius:12px; padding:14px 16px; margin:16px 0 0;">
      <p style="color:#bfc3d4; font-size:12px; line-height:1.6; margin:0;">
        <strong style="color:#ffffff;">Before you arrive:</strong> wear footwear suitable for the surface,
        and please leave the facility as you found it. This booking is covered by the Facility Use Terms
        &amp; Liability Waiver you agreed to when requesting. Need to cancel or change? Email
        <a href="mailto:info@cufc.co.nz" style="color:${USC_BRAND};">info@cufc.co.nz</a> at least 24 hours before your slot.
      </p>
    </div>
    <p style="color:#8b8fa8; font-size:13px; line-height:1.6; margin:24px 0 0;">
      See you at the centre! <span style="color:#5a6078;">(Booking reference: MBR-${params.requestId})</span>
    </p>`;

  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: USC_REPLY_TO,
    subject: `Booking confirmed — ${params.facilityName}, ${params.dateLong} ${params.timeRange}`,
    html: uscShell({ heading: "Booking Confirmed", sub: "Member Booking", bodyHtml }),
  });
}

/** Confirmation for a booking created by staff in the admin calendar.
 *  Handles single bookings, multi-facility bookings, and recurring series
 *  (one email listing the dates, not one email per occurrence). */
export async function sendManualBookingConfirmationEmail(params: {
  to: string;
  customerName: string;
  facilityNames: string[];
  dateLongs: string[];   // pre-formatted, sorted, e.g. "Friday, 12 June 2026"
  timeRange: string;
  amountLabel?: string | null;
}): Promise<boolean> {
  const MAX_DATES = 12;
  const shownDates = params.dateLongs.slice(0, MAX_DATES);
  const moreCount = params.dateLongs.length - shownDates.length;

  const rows = [
    uscRow(params.facilityNames.length > 1 ? "Facilities" : "Facility", params.facilityNames.join("<br/>")),
    params.dateLongs.length === 1
      ? uscRow("Date", params.dateLongs[0])
      : uscRow(`Dates (${params.dateLongs.length})`, shownDates.join("<br/>") + (moreCount > 0 ? `<br/>+ ${moreCount} more` : "")),
    uscRow("Time", params.timeRange, true),
    ...(params.amountLabel ? [uscRow("Amount", params.amountLabel)] : []),
  ].join("");

  const bodyHtml = `
    <p style="color:#e6e8f0; font-size:16px; margin:0 0 16px;">Hi ${params.customerName},</p>
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 24px;">
      Your booking at the United Sports Centre is <strong style="color:${USC_BRAND};">confirmed</strong>. Here are the details:
    </p>
    ${uscCard(rows)}
    <p style="color:#8b8fa8; font-size:13px; line-height:1.6; margin:24px 0 0;">
      Need to change or cancel? Reply to this email or contact
      <a href="mailto:info@cufc.co.nz" style="color:${USC_BRAND};">info@cufc.co.nz</a> at least 24 hours before your booking. See you at the centre!
    </p>`;

  const subjectDate = params.dateLongs.length === 1 ? params.dateLongs[0] : `${params.dateLongs.length} sessions`;
  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: USC_REPLY_TO,
    subject: `Booking confirmed — ${params.facilityNames[0]}, ${subjectDate}`,
    html: uscShell({ heading: "Booking Confirmed", sub: "United Sports Centre", bodyHtml }),
  });
}

/** Customer confirmation for a PAID public venue booking (book.unitedsportscentre.com).
 *  Sent when the Stripe payment for a booking group succeeds. Lists every session
 *  in the group with its own date/time/price so single-session and multi-session
 *  orders both render correctly. */
export async function sendVenueBookingConfirmationEmail(params: {
  to: string;
  customerName: string;
  sessions: { facilityName: string; dateLong: string; timeRange: string; sizeLabel?: string | null; amountLabel: string }[];
  totalLabel: string;
  reference: string;
}): Promise<boolean> {
  const rows = params.sessions.map(s =>
    uscRow(
      `${s.facilityName}${s.sizeLabel ? ` <span style="color:#8b8fa8;">(${s.sizeLabel})</span>` : ""}`,
      `${s.dateLong}<br/><span style="color:#8b8fa8;">${s.timeRange} · ${s.amountLabel}</span>`,
    )
  ).join("");

  const bodyHtml = `
    <p style="color:#e6e8f0; font-size:16px; margin:0 0 16px;">Hi ${params.customerName},</p>
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 24px;">
      Thanks for your booking — your reservation is <strong style="color:${USC_BRAND};">confirmed</strong> and payment received. Here are your details:
    </p>
    ${uscCard(rows + uscRow("Total paid", params.totalLabel, true))}
    <p style="color:#8b8fa8; font-size:13px; line-height:1.6; margin:24px 0 0;">
      Need to change or cancel? Reply to this email or contact
      <a href="mailto:info@cufc.co.nz" style="color:${USC_BRAND};">info@cufc.co.nz</a> at least 24 hours before your booking.
      <br/><span style="color:#5a6078;">Reference: ${params.reference}</span>
    </p>`;

  const subjectDate = params.sessions.length === 1 ? params.sessions[0].dateLong : `${params.sessions.length} sessions`;
  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: USC_REPLY_TO,
    subject: `Booking confirmed — ${params.sessions[0]?.facilityName || "United Sports Centre"}, ${subjectDate}`,
    html: uscShell({ heading: "Booking Confirmed", sub: "United Sports Centre", bodyHtml }),
  });
}

/** Cancellation notice — staff removed a booking from the admin calendar and
 *  chose to notify the customer. Covers single bookings and whole series. */
export async function sendBookingCancellationEmail(params: {
  to: string;
  customerName: string;
  facilityNames: string[];
  dateLongs: string[];   // pre-formatted, sorted
  timeRange: string;
}): Promise<boolean> {
  const MAX_DATES = 12;
  const shownDates = params.dateLongs.slice(0, MAX_DATES);
  const moreCount = params.dateLongs.length - shownDates.length;

  const rows = [
    uscRow(params.facilityNames.length > 1 ? "Facilities" : "Facility", params.facilityNames.join("<br/>")),
    params.dateLongs.length === 1
      ? uscRow("Date", params.dateLongs[0])
      : uscRow(`Dates (${params.dateLongs.length})`, shownDates.join("<br/>") + (moreCount > 0 ? `<br/>+ ${moreCount} more` : "")),
    uscRow("Time", params.timeRange, true),
  ].join("");

  const bodyHtml = `
    <p style="color:#e6e8f0; font-size:16px; margin:0 0 16px;">Hi ${params.customerName},</p>
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 24px;">
      Unfortunately the following booking${params.dateLongs.length > 1 ? "s have" : " has"} been
      <strong style="color:#ef4444;">cancelled</strong>:
    </p>
    ${uscCard(rows)}
    <p style="color:#8b8fa8; font-size:13px; line-height:1.6; margin:24px 0 0;">
      If you've already paid, our team will be in touch about a refund. If this is unexpected or
      you'd like to rebook, reply to this email or contact
      <a href="mailto:info@cufc.co.nz" style="color:${USC_BRAND};">info@cufc.co.nz</a> — sorry for any inconvenience.
    </p>`;

  const subjectDate = params.dateLongs.length === 1 ? params.dateLongs[0] : `${params.dateLongs.length} sessions`;
  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: USC_REPLY_TO,
    subject: `Booking cancelled — ${params.facilityNames[0]}, ${subjectDate}`,
    html: uscShell({ heading: "Booking Cancelled", sub: "United Sports Centre", bodyHtml, accent: "#ef4444" }),
  });
}

/** Member notice — their request couldn't be accommodated. */
export async function sendBookingRequestDeclinedEmail(params: {
  to: string;
  memberName: string;
  facilityName: string;
  dateLong: string;
  timeRange: string;
  reason?: string | null;
}): Promise<boolean> {
  const bodyHtml = `
    <p style="color:#e6e8f0; font-size:16px; margin:0 0 16px;">Hi ${params.memberName},</p>
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 16px;">
      Unfortunately we couldn't accommodate your booking request for
      <strong style="color:#ffffff;">${params.facilityName}</strong> on
      <strong style="color:#ffffff;">${params.dateLong}, ${params.timeRange}</strong>.
    </p>
    ${params.reason ? `<p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0 0 16px;"><em>"${params.reason}"</em></p>` : ""}
    <p style="color:#bfc3d4; font-size:14px; line-height:1.6; margin:0;">
      You're welcome to request another time at
      <a href="https://book.unitedsportscentre.com/members" style="color:${USC_BRAND};">book.unitedsportscentre.com/members</a>,
      or reply to this email and we'll help you find a slot that works.
    </p>`;

  return sendEmail({
    to: params.to,
    from: USC_FROM,
    replyTo: USC_REPLY_TO,
    subject: `Booking request update — ${params.facilityName}, ${params.dateLong}`,
    html: uscShell({ heading: "Booking Request Update", sub: "Member Booking", bodyHtml }),
  });
}

/** Balance auto-charge failed — ask the captain to pay the balance manually. */
export async function sendLeagueBalanceFailedEmail(params: {
  registrationId: number;
  programId: number;
  captainEmail: string;
  captainName: string;
  teamName: string;
  balanceDue: string;
  payUrl: string;
}): Promise<boolean> {
  const bodyHtml = `
    <p style="color:#e6e6e6; font-size:16px; margin:0 0 16px;">Hi ${params.captainName},</p>
    <p style="color:#bdbdbd; font-size:14px; line-height:1.6; margin:0 0 24px;">
      We tried to collect the remaining balance of <strong style="color:#d1b96e;">${params.balanceDue}</strong> for
      <strong>${params.teamName}</strong>, but the payment didn't go through. No stress — just pay it here to keep your spot:
    </p>
    <p style="text-align:center; margin:0 0 24px;">
      <a href="${params.payUrl}" style="display:inline-block; background:#d1b96e; color:#000; font-weight:600; text-decoration:none; padding:14px 28px; border-radius:9999px;">Pay balance (${params.balanceDue})</a>
    </p>`;

  return sendEmail({
    to: params.captainEmail,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Action needed — balance for ${params.teamName}`,
    html: mflShell({ heading: "Balance Payment Needed", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
  });
}

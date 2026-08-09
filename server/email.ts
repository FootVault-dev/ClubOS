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

// ── CUFC Open Trainings ───────────────────────────────────────────────────────
// The invite-only funnel's three emails: parent acknowledgement at submit,
// staff notification to the academy office, and the approval confirmation.
// Same navy shell as the contact notification above.

const cufcShellWrap = (heading: string, inner: string) => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#030711;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:#7d95ff;margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Christchurch United FC</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${heading}</h1>
      </div>
      <div style="background:#0c1226;border:1px solid #1d2a55;border-radius:18px;padding:24px;color:#e6e6e6;font-size:14px;line-height:1.65;">
        ${inner}
      </div>
      <p style="text-align:center;color:#5a6480;font-size:11px;line-height:1.7;margin:20px 0 0;">
        Christchurch United Football Club · Christchurch, New Zealand
      </p>
    </div>
  </div>`;

const cufcInfoRow = (label: string, value: string) =>
  `<tr><td style="padding:6px 0;color:#7d8ba8;font-size:13px;width:130px;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#ffffff;font-size:14px;font-weight:600;">${value}</td></tr>`;

const esc = (v: string) => String(v || "").replace(/</g, "&lt;");

/** Parent acknowledgement — sent the moment a request lands. Promises a
 *  review, not a booking: nothing is confirmed until staff approve it. */
export async function sendCufcOpenTrainingReceived(params: {
  to: string; guardianName: string; childName: string; groupLabel: string;
}): Promise<boolean> {
  const html = cufcShellWrap("Open Training Request Received", `
    <p style="margin:0 0 14px;">Kia ora ${esc(params.guardianName)},</p>
    <p style="margin:0 0 14px;">Thanks for requesting a free open training for <strong>${esc(params.childName)}</strong> (${esc(params.groupLabel)}).</p>
    <p style="margin:0 0 14px;">Our academy staff review every request. Once yours is approved you'll get an email from us confirming the session details.</p>
    <p style="margin:0;">Open trainings are free of charge. If anything changes in the meantime, just reply to this email.</p>
  `);
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: "academy@cufc.co.nz",
    subject: `Open training request received — ${params.childName}`,
    html,
  });
}

/** Staff notification → the academy office inbox. */
export async function sendCufcOpenTrainingNotification(params: {
  to: string; childName: string; dob: string; grade: number | null; groupLabel: string;
  guardianName: string; email: string; phone: string;
  currentClub?: string | null; notes?: string | null; sourceUrl?: string;
}): Promise<boolean> {
  const rows = [
    cufcInfoRow("Player", esc(params.childName)),
    cufcInfoRow("Date of birth", esc(params.dob) + (params.grade != null ? ` (U${params.grade})` : "")),
    cufcInfoRow("Age group", esc(params.groupLabel)),
    cufcInfoRow("Parent / guardian", esc(params.guardianName)),
    cufcInfoRow("Email", esc(params.email)),
    cufcInfoRow("Phone", esc(params.phone)),
    ...(params.currentClub ? [cufcInfoRow("Current club", esc(params.currentClub))] : []),
  ].join("");
  const html = cufcShellWrap("New Open Training Request", `
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    ${params.notes ? `<p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:18px 0 0;white-space:pre-wrap;">${esc(params.notes)}</p>` : ""}
    <p style="color:#7d8ba8;font-size:12px;margin:18px 0 0;">Review it in ClubOS → Christchurch United → Open Trainings.</p>
    ${params.sourceUrl ? `<p style="color:#7d8ba8;font-size:11px;margin:8px 0 0;">via ${esc(params.sourceUrl)}</p>` : ""}
  `);
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: params.email || CUFC_REPLY_TO,
    subject: `Open training request — ${params.childName} (${params.groupLabel})`,
    html,
  });
}

/** Approval confirmation — sent on the transition into `approved`. If staff
 *  entered session details they're included verbatim; otherwise the email
 *  promises a follow-up rather than inventing a time or venue. */
export async function sendCufcOpenTrainingConfirmed(params: {
  to: string; guardianName: string; childName: string; sessionDetails?: string | null;
}): Promise<boolean> {
  const html = cufcShellWrap("Open Training Confirmed", `
    <p style="margin:0 0 14px;">Kia ora ${esc(params.guardianName)},</p>
    <p style="margin:0 0 14px;">Good news — <strong>${esc(params.childName)}</strong>'s open training request has been approved.</p>
    ${params.sessionDetails
      ? `<div style="background:#101a3a;border:1px solid #2a3a6b;border-radius:12px;padding:16px;margin:0 0 14px;">
           <p style="color:#7d95ff;margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Session details</p>
           <p style="color:#ffffff;font-size:14px;line-height:1.65;margin:0;white-space:pre-wrap;">${esc(params.sessionDetails)}</p>
         </div>`
      : `<p style="margin:0 0 14px;">Our academy staff will be in touch shortly with the session details.</p>`}
    <p style="margin:0;">The session is free of charge. If you have any questions, just reply to this email.</p>
  `);
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: "academy@cufc.co.nz",
    subject: `Open training confirmed — ${params.childName}`,
    html,
  });
}

/**
 * Parent account sign-in code.
 *
 * Deliberately plain: one number, big enough to read on a phone in a car park,
 * and no link. A magic link in a forwarded email is a live session; a 6-digit
 * code paired with the address that asked for it is not. Sent only to an
 * address the club already holds as a guardian.
 */
export async function sendCufcParentLoginCode(params: {
  to: string; firstName: string | null; code: string; minutes: number;
}): Promise<boolean> {
  const greeting = params.firstName ? `Kia ora ${esc(params.firstName)},` : "Kia ora,";
  const html = cufcShellWrap("Your sign-in code", `
    <p style="margin:0 0 14px;">${greeting}</p>
    <p style="margin:0 0 18px;">Here's your code to sign in to your Christchurch United account.</p>
    <p style="margin:0 0 18px;text-align:center;">
      <span style="display:inline-block;background:#030711;border:1px solid #1d2a55;border-radius:14px;padding:16px 26px;color:#ffffff;font-size:34px;font-weight:800;letter-spacing:9px;font-family:'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;">${esc(params.code)}</span>
    </p>
    <p style="margin:0 0 14px;">It expires in ${params.minutes} minutes and can only be used once.</p>
    <p style="margin:0;color:#7d8ba8;">If you didn't ask to sign in, you can ignore this email — nobody can get into your account without this code.</p>
  `);
  return sendEmail({
    to: params.to,
    from: CUFC_FROM,
    replyTo: "academy@cufc.co.nz",
    subject: `${params.code} is your Christchurch United sign-in code`,
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

/** Split Pay — a squad member's share has been charged. Their personal receipt.
 *  While the squad is still short, the receipt also carries the team's share
 *  link so ANY paid member can pass it on (not just the captain). */
export async function sendSplitShareReceiptEmail(params: {
  to: string;
  memberName: string;
  teamName: string;
  amountCents: number;
  registrationId?: number;
  shareUrl?: string | null;      // included while the split is still open
  paidCount?: number;
  targetCount?: number | null;
}): Promise<boolean> {
  const amount = `$${(params.amountCents / 100).toFixed(2)} NZD`;
  const shareBlock = params.shareUrl
    ? `
    <p style="color:#b9b9b9; font-size:13px; line-height:1.6; margin:22px 0 8px;">
      ${params.paidCount != null && params.targetCount ? `<strong style="color:#d1b96e;">${params.paidCount} of ${params.targetCount}</strong> shares are in so far. ` : ""}The team's spot is confirmed once the whole squad has paid — pass this link to anyone who hasn't yet:
    </p>
    <p style="margin:0; word-break:break-all;"><a href="${params.shareUrl}" style="color:#d1b96e; font-size:13px;">${params.shareUrl}</a></p>`
    : "";
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
    </div>${shareBlock}`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Your share is paid — ${params.teamName}`,
    html: mflShell({ heading: "Share paid ✓", bodyHtml }),
    ...(params.registrationId ? { registrationId: params.registrationId } : {}),
  });
}

/** Player Pay — the captain's copy of the team share link. Sent once when the
 *  split is created ('created') and again by the reminder sweep / an admin
 *  resend ('reminder') until the squad completes. The raw URL is printed in
 *  full on purpose: it makes the email findable by searching "player pay" or
 *  the team name, and the link copyable — the exact failure this fixes is a
 *  captain losing the link with no way to get it back. */
export async function sendSplitShareLinkEmail(params: {
  to: string;
  captainName: string;
  teamName: string;
  shareUrl: string;
  shareCents: number;
  paidCount: number;
  targetCount: number | null;
  kind: "created" | "reminder";
  registrationId?: number;
  programId?: number;
}): Promise<boolean> {
  const share = `$${(params.shareCents / 100).toFixed(2)}`;
  const target = params.targetCount && params.targetCount > 0 ? params.targetCount : null;
  const progress = target ? `${params.paidCount} of ${target}` : `${params.paidCount}`;
  const isCreated = params.kind === "created";

  const intro = isCreated
    ? `Your team's registration is in — now it's over to the squad. Everyone pays their own share (<strong style="color:#d1b96e;">${share}</strong> each) on the page below, and <strong>${params.teamName}</strong> is confirmed the moment ${target ? `all ${target}` : "everyone"} have paid. Send the link to your team chat and keep this email — it's your team's payment page whenever you need it.`
    : `Quick nudge — <strong>${params.teamName}</strong> has <strong style="color:#d1b96e;">${progress}</strong> shares paid${target ? "" : " so far"}. The team's spot is only confirmed once the whole squad is in, so fire the link below into your team chat again for anyone who hasn't paid yet.`;

  const rows = [
    mflRow("Team", params.teamName),
    mflRow("Each share", `${share} NZD`),
    ...(target ? [mflRow("Paid so far", progress, true)] : []),
  ].join("");

  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.captainName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">${intro}</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <a href="${params.shareUrl}" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Open your team's payment page →</a>
    <p style="color:#7d7d7d; font-size:12px; line-height:1.6; margin:16px 0 0;">
      Your team's Player Pay link (share it with the squad):<br/>
      <a href="${params.shareUrl}" style="color:#d1b96e; word-break:break-all;">${params.shareUrl}</a>
    </p>`;

  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: isCreated
      ? `Your Player Pay link — ${params.teamName}`
      : `${params.teamName}: ${progress}${target ? "" : ` share${params.paidCount === 1 ? "" : "s"}`} paid — share your Player Pay link`,
    html: mflShell({ heading: isCreated ? "Your Player Pay link" : `${progress} paid`, bodyHtml }),
    ...(params.programId ? { campId: params.programId } : {}),
    ...(params.registrationId ? { registrationId: params.registrationId } : {}),
    utm: { medium: "transactional", campaign: isCreated ? "league-split-link" : "league-split-reminder" },
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

// ---------------------------------------------------------------------------
// MFL Store — shop order emails (black + gold brand, same shell as league mail)
// ---------------------------------------------------------------------------

export interface ShopOrderEmailLine {
  title: string;
  colourName?: string | null;
  size?: string | null;
  qty: number;
  lineCents: number;
  /** Per-shirt personalisation (name/number) — rendered as a "Printing" sub-row. */
  units?: { name?: string; number?: string }[] | null;
}

/** "Printing: SMITH #9 · JONES #10" sub-row under a personalised line. */
function shopUnitsRow(units: { name?: string; number?: string }[]): string {
  const spec = units
    .map((u) => [u.name, u.number ? `#${u.number}` : null].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" · ");
  if (!spec) return "";
  return `<tr><td colspan="2" style="color:#8a8a8a; font-size:12px; line-height:1.5; padding:0 0 6px;">Printing: ${spec}</td></tr>`;
}

const shopMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Order confirmation → the customer. Totals are GST-inclusive. */
export async function sendShopOrderConfirmation(params: {
  to: string;
  firstName: string;
  orderNumber: string;
  lines: ShopOrderEmailLine[];
  subtotalCents: number;
  discountCents: number;
  discountCode?: string | null;
  shippingLabel?: string | null;
  shippingCents: number;
  gstCents: number;
  totalCents: number;
  requiresAddress: boolean;
  addressSummary?: string | null;
}): Promise<boolean> {
  const firstName = (params.firstName || "").trim() || "there";
  const lineRows = params.lines.map((l) => {
    const detail = [l.colourName, l.size].filter(Boolean).join(" · ");
    return mflRow(`${l.qty} × ${l.title}${detail ? ` (${detail})` : ""}`, shopMoney(l.lineCents))
      + (l.units && l.units.length > 0 ? shopUnitsRow(l.units) : "");
  });
  const rows = [
    ...lineRows,
    ...(params.discountCents > 0
      ? [mflRow(`Discount${params.discountCode ? ` (${params.discountCode})` : ""}`, `−${shopMoney(params.discountCents)}`)]
      : []),
    mflRow(params.shippingLabel || "Shipping", params.shippingCents > 0 ? shopMoney(params.shippingCents) : "Free"),
    mflRow("Total paid", shopMoney(params.totalCents), true),
  ].join("");
  const fulfilment = params.requiresAddress
    ? `We're packing your order now and will ship it to:<br/><strong style="color:#ffffff;">${params.addressSummary || ""}</strong>`
    : `We'll email you as soon as it's ready to collect from <strong style="color:#ffffff;">United Sports Centre, 466 Yaldhurst Rd</strong>.`;
  const bodyHtml = `
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:0;">Hey ${firstName},</p>
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:14px 0 0;">
      Thanks for your order — it's confirmed. Your order number is <strong style="color:#d1b96e;">${params.orderNumber}</strong>.
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px; margin:18px 0 0;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <p style="color:#8a8a8a; font-size:12px; line-height:1.6; margin:10px 0 0;">All prices include GST (GST content ${shopMoney(params.gstCents)}).</p>
    <p style="color:#e6e6e6; font-size:14px; line-height:1.65; margin:16px 0 0;">${fulfilment}</p>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Order confirmed — ${params.orderNumber}`,
    html: mflShell({ heading: "Order confirmed ⚽", bodyHtml }),
  });
}

/** New paid order heads-up → the MFL coordinator (info@minifootball.co.nz).
 *  Reply-To is the customer so staff can reply straight from their inbox. */
export async function sendShopOrderNotification(params: {
  to: string;
  orderNumber: string;
  customerName: string;
  email: string;
  phone?: string | null;
  lines: ShopOrderEmailLine[];
  totalCents: number;
  shippingLabel?: string | null;
  requiresAddress: boolean;
  addressSummary?: string | null;
}): Promise<boolean> {
  const rows = [
    mflRow("Order", params.orderNumber),
    mflRow("Customer", params.customerName || "—"),
    mflRow("Email", params.email || "—"),
    ...(params.phone ? [mflRow("Phone", params.phone)] : []),
    ...params.lines.map((l) => {
      const detail = [l.colourName, l.size].filter(Boolean).join(" · ");
      return mflRow(`${l.qty} × ${l.title}${detail ? ` (${detail})` : ""}`, shopMoney(l.lineCents))
        + (l.units && l.units.length > 0 ? shopUnitsRow(l.units) : "");
    }),
    mflRow(params.shippingLabel || "Fulfilment", params.requiresAddress ? (params.addressSummary || "Courier") : "Pickup"),
    mflRow("Total paid", shopMoney(params.totalCents), true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:16px; font-weight:600; margin:0 0 14px;">New store order 🛒</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <p style="color:#8a8a8a; font-size:13px; line-height:1.6; margin:16px 0 0;">
      Manage it in ClubOS → Mini Football → Store → Orders.
    </p>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.email || MFL_REPLY_TO,
    subject: `New order ${params.orderNumber} — ${params.customerName}`,
    html: mflShell({ heading: "New store order", bodyHtml }),
  });
}

// ── MFL Store — Player Pay (team kit group payment) emails ──────────────────

/** Player Pay invite → each player: pay your share to lock in your kit. */
export async function sendShopShareInvite(params: {
  to: string;
  coachFirstName: string;
  teamName: string;
  kitTitle: string;
  colourName?: string | null;
  playerName: string;
  shirtNumber?: string | null;
  size: string;
  amountCents: number;
  payUrl: string;
}): Promise<boolean> {
  const rows = [
    mflRow("Kit", `${params.kitTitle}${params.colourName ? ` (${params.colourName})` : ""}`),
    mflRow("Name on shirt", params.playerName),
    ...(params.shirtNumber ? [mflRow("Number", `#${params.shirtNumber}`)] : []),
    mflRow("Size", params.size),
    mflRow("Your share", shopMoney(params.amountCents), true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.playerName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      ${params.coachFirstName} set up your <strong style="color:#d1b96e;">${params.teamName}</strong> kit — pay your share to lock in your kit. The order goes to print once everyone's paid.
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <a href="${params.payUrl}" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Pay my share →</a>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `${params.coachFirstName} set up your ${params.teamName} kit — pay your share`,
    html: mflShell({ heading: "Lock in your kit ⚽", bodyHtml }),
  });
}

/** Player Pay setup summary → the coach: everyone's link is out, track who's paid. */
export async function sendShopTeamSetupSummary(params: {
  to: string;
  coachFirstName: string;
  teamName: string;
  orderNumber: string;
  kitTitle: string;
  colourName?: string | null;
  players: { name: string; number?: string | null; size: string; amountCents: number }[];
  totalCents: number;
  coachUrl: string;
}): Promise<boolean> {
  const rows = [
    mflRow("Order", params.orderNumber),
    mflRow("Kit", `${params.kitTitle}${params.colourName ? ` (${params.colourName})` : ""}`),
    ...params.players.map((p) =>
      mflRow(`${p.name}${p.number ? ` #${p.number}` : ""} · ${p.size}`, shopMoney(p.amountCents)),
    ),
    mflRow("Team total", shopMoney(params.totalCents), true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.coachFirstName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      Your <strong style="color:#d1b96e;">${params.teamName}</strong> kit order is set up and every player has been emailed their personal pay link.
      Nothing is charged to you — each player pays their own share, and the order goes to print once everyone's paid.
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>
    <a href="${params.coachUrl}" style="display:inline-block; margin:22px 0 0; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Track who's paid →</a>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `${params.teamName} kit order is live — ${params.orderNumber}`,
    html: mflShell({ heading: "Kit order set up ✓", bodyHtml }),
  });
}

/** Player Pay share receipt → the player who just paid. */
export async function sendShopShareReceipt(params: {
  to: string;
  playerName: string;
  teamName: string;
  orderNumber: string;
  kitTitle: string;
  size: string;
  shirtNumber?: string | null;
  amountCents: number;
}): Promise<boolean> {
  const rows = [
    mflRow("Order", params.orderNumber),
    mflRow("Kit", `${params.kitTitle} · ${params.size}${params.shirtNumber ? ` · #${params.shirtNumber}` : ""}`),
    mflRow("Paid", shopMoney(params.amountCents), true),
  ].join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.playerName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      Your share of the <strong style="color:#d1b96e;">${params.teamName}</strong> kit is <strong style="color:#d1b96e;">paid</strong>. Your kit is locked in — it goes to print once the whole team has paid.
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Your kit share is paid — ${params.teamName}`,
    html: mflShell({ heading: "Share paid ✓", bodyHtml }),
  });
}

/** Player Pay all-paid confirmation → the coach: team's all paid, order confirmed. */
export async function sendShopTeamAllPaidConfirmation(params: {
  to: string;
  coachFirstName: string;
  teamName: string;
  orderNumber: string;
  playerCount: number;
  totalCents: number;
  shippingLabel?: string | null;
  requiresAddress: boolean;
  addressSummary?: string | null;
}): Promise<boolean> {
  const rows = [
    mflRow("Order", params.orderNumber),
    mflRow("Players paid", `${params.playerCount} / ${params.playerCount}`),
    mflRow(params.shippingLabel || "Fulfilment", params.requiresAddress ? (params.addressSummary || "Courier") : "Pickup"),
    mflRow("Team total", shopMoney(params.totalCents), true),
  ].join("");
  const fulfilment = params.requiresAddress
    ? `We're sending the order to print now and will ship it to <strong style="color:#ffffff;">${params.addressSummary || "your address"}</strong>.`
    : `We're sending the order to print now — we'll email you when it's ready to collect from <strong style="color:#ffffff;">United Sports Centre, 466 Yaldhurst Rd</strong>.`;
  const bodyHtml = `
    <p style="color:#ffffff; font-size:17px; font-weight:600; margin:0 0 6px;">Hi ${params.coachFirstName},</p>
    <p style="color:#b9b9b9; font-size:14px; line-height:1.65; margin:0 0 22px;">
      Great news — your whole team has paid, so the <strong style="color:#d1b96e;">${params.teamName}</strong> kit order is <strong style="color:#d1b96e;">confirmed</strong>. ${fulfilment}
    </p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">${rows}</table>
    </div>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `${params.teamName} is all paid — order ${params.orderNumber} confirmed`,
    html: mflShell({ heading: "Your team's all paid 🎉", bodyHtml }),
  });
}

/** Player Pay fully-paid heads-up → the MFL coordinator, with the print spec. */
export async function sendShopPrintReadyNotification(params: {
  to: string;
  orderNumber: string;
  teamName: string;
  coachName: string;
  coachEmail: string;
  coachPhone?: string | null;
  kitTitle: string;
  colourName?: string | null;
  sponsors: { label: string; text?: string; logoUrl?: string }[];
  roster: { name: string; number?: string | null; size: string }[];
  totalCents: number;
  shippingLabel?: string | null;
  requiresAddress: boolean;
  addressSummary?: string | null;
}): Promise<boolean> {
  const sponsorRows = params.sponsors.map((s) => {
    const value = s.logoUrl
      ? `<img src="${s.logoUrl}" alt="${s.label} logo" style="max-height:80px; max-width:200px; background:#ffffff; border-radius:6px; padding:4px;" /><br/><a href="${s.logoUrl}" style="color:#8a8a8a; font-size:11px;">${s.logoUrl}</a>`
      : `<span style="font-family:monospace;">${s.text || "—"}</span>`;
    return `<tr>
      <td style="color:#8a8a8a; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; padding:6px 0; vertical-align:top;">${s.label}</td>
      <td style="color:#fff; font-size:14px; padding:6px 0; text-align:right;">${value}</td>
    </tr>`;
  }).join("");
  const rosterRows = params.roster.map((p, i) => `<tr>
    <td style="color:#8a8a8a; font-size:12px; padding:4px 8px 4px 0; font-family:monospace;">${i + 1}</td>
    <td style="color:#fff; font-size:13px; padding:4px 8px 4px 0; font-family:monospace;">${p.name}</td>
    <td style="color:#d1b96e; font-size:13px; padding:4px 8px 4px 0; font-family:monospace;">${p.number ? `#${p.number}` : ""}</td>
    <td style="color:#fff; font-size:13px; padding:4px 0; font-family:monospace; text-align:right;">${p.size}</td>
  </tr>`).join("");
  const bodyHtml = `
    <p style="color:#ffffff; font-size:16px; font-weight:600; margin:0 0 14px;">Order ${params.orderNumber} fully paid — READY TO PRINT 🖨️</p>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px;">
      <table style="width:100%; border-collapse:collapse;">
        ${mflRow("Team", params.teamName)}
        ${mflRow("Kit", `${params.kitTitle}${params.colourName ? ` (${params.colourName})` : ""}`)}
        ${mflRow("Coach", `${params.coachName} · ${params.coachEmail}${params.coachPhone ? ` · ${params.coachPhone}` : ""}`)}
        ${mflRow(params.shippingLabel || "Fulfilment", params.requiresAddress ? (params.addressSummary || "Courier") : "Pickup")}
        ${sponsorRows}
        ${mflRow("Total paid", shopMoney(params.totalCents), true)}
      </table>
    </div>
    <div style="background:#000000; border:1px solid #232323; border-radius:14px; padding:18px 20px; margin:12px 0 0;">
      <p style="color:#8a8a8a; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; margin:0 0 8px;">Roster — ${params.roster.length} shirts</p>
      <table style="width:100%; border-collapse:collapse;">${rosterRows}</table>
    </div>
    <p style="color:#8a8a8a; font-size:13px; line-height:1.6; margin:16px 0 0;">
      Manage it in ClubOS → Mini Football → Store → Orders.
    </p>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.coachEmail || MFL_REPLY_TO,
    subject: `ORDER ${params.orderNumber} fully paid — READY TO PRINT (${params.teamName})`,
    html: mflShell({ heading: "Ready to print 🖨️", bodyHtml }),
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

/** Staff Chat (the in-house Slack) — away-escalation email for a mention / DM /
 *  opted-in channel message. Sent ONLY when the recipient has no active chat
 *  session (away ≥5 min), never in NZ quiet hours, max one per channel per
 *  15 min — the durable safety net under in-app badges. Org-agnostic system
 *  mail → sends from cufc.co.nz per shared/org-domains doctrine. */
export async function sendStaffChatNotification(params: {
  to: string; recipientName: string; senderName: string;
  /** "#match-day-ops" or "a direct message" */
  context: string; messageExcerpt: string; mentioned?: boolean; chatUrl: string;
}): Promise<boolean> {
  const accent = "#c9a43e";
  const isDm = !params.context.startsWith("#");
  const headline = params.mentioned
    ? `${params.senderName} mentioned you`
    : isDm
      ? `${params.senderName} messaged you`
      : `New message in ${params.context}`;
  const whereLine = params.mentioned
    ? `${params.senderName} mentioned you in ${params.context}:`
    : isDm
      ? `${params.senderName} sent you a direct message:`
      : `${params.senderName} posted in ${params.context}:`;
  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:520px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:${accent};margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">United Sports Group · Staff Chat</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${headline.replace(/</g, "&lt;")}</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <p style="color:#e6e6e6;font-size:14px;line-height:1.6;margin:0 0 14px;">Hi ${params.recipientName.split(" ")[0].replace(/</g, "&lt;")},</p>
        <p style="color:#9aa0a6;font-size:13px;margin:0 0 6px;">${whereLine.replace(/</g, "&lt;")}</p>
        <p style="color:#e6e6e6;font-size:14px;line-height:1.65;margin:0;white-space:pre-wrap;border-left:3px solid ${accent};padding:2px 0 2px 14px;">${(params.messageExcerpt || "").replace(/</g, "&lt;")}</p>
        <div style="text-align:center;margin:24px 0 4px;"><a href="${params.chatUrl}" style="display:inline-block;background:${accent};color:#0b0b08;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:10px;">Open Chat</a></div>
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">You get these only when you're away from ClubOS. Mute any channel from its header — mentions still reach you.</p>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: "ClubOS Chat <noreply@cufc.co.nz>",
    subject: `${headline} — Staff Chat`,
    html,
  });
}

/** Daily / weekly digest — the opt-in "here's what you missed" summary.
 *  Sent by server/digest-cron.ts at the hour each person chose (NZ), at most
 *  once per NZ calendar day. Never sent when there is nothing to report — an
 *  empty digest teaches people to filter us. Org-agnostic system mail, so it
 *  sends from cufc.co.nz per shared/org-domains doctrine. */
export async function sendDigestEmail(params: {
  to: string;
  recipientName: string;
  kind: "daily" | "weekly";
  content: {
    channels: { name: string; unread: number; mentions: number }[];
    totalUnread: number;
    totalMentions: number;
    overdueTasks: { title: string; dueDate: string | null; project: string | null }[];
    dueSoonTasks: { title: string; dueDate: string | null; project: string | null }[];
  };
  appUrl: string;
}): Promise<boolean> {
  const accent = "#c9a43e";
  const esc = (s: string) => (s || "").replace(/</g, "&lt;");
  const c = params.content;
  const period = params.kind === "daily" ? "today" : "this week";

  const section = (title: string, inner: string) =>
    inner
      ? `<p style="color:${accent};margin:22px 0 10px;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;">${title}</p>${inner}`
      : "";

  const chatRows = c.channels
    .slice(0, 12)
    .map((ch) => {
      // A mention is the thing they actually need to see, so it leads the line
      // and unread volume is the supporting detail — not the other way round.
      const bits = [
        ch.mentions > 0
          ? `<span style="color:${accent};font-weight:700;">${ch.mentions} mention${ch.mentions === 1 ? "" : "s"}</span>`
          : "",
        ch.unread > 0 ? `${ch.unread} unread` : "",
      ].filter(Boolean);
      return `<tr><td style="padding:7px 0;color:#e6e6e6;font-size:14px;">${esc(ch.name)}</td>
        <td style="padding:7px 0;color:#9aa0a6;font-size:13px;text-align:right;">${bits.join(" · ")}</td></tr>`;
    })
    .join("");

  const taskRow = (t: { title: string; dueDate: string | null; project: string | null }, overdue: boolean) =>
    `<tr><td style="padding:7px 0;color:#e6e6e6;font-size:14px;">${esc(t.title)}${
      t.project ? `<span style="color:#5a5a5a;font-size:12px;"> · ${esc(t.project)}</span>` : ""
    }</td><td style="padding:7px 0;font-size:13px;text-align:right;color:${overdue ? "#ef6461" : "#9aa0a6"};">${
      t.dueDate ? esc(nzDisplayDate(t.dueDate)) : ""
    }</td></tr>`;

  const overdueRows = c.overdueTasks.slice(0, 12).map((t) => taskRow(t, true)).join("");
  const dueSoonRows = c.dueSoonTasks.slice(0, 12).map((t) => taskRow(t, false)).join("");

  const headline =
    c.totalMentions > 0
      ? `You were mentioned ${c.totalMentions} time${c.totalMentions === 1 ? "" : "s"}`
      : c.overdueTasks.length > 0
        ? `${c.overdueTasks.length} task${c.overdueTasks.length === 1 ? " is" : "s are"} overdue`
        : `What you missed ${period}`;

  const html = `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#0b0b08;padding:36px 16px;">
    <div style="max-width:560px;margin:0 auto;">
      <div style="text-align:center;padding:4px 0 22px;">
        <p style="color:${accent};margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">United Sports Group · ClubOS</p>
        <h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.2px;">${esc(headline)}</h1>
      </div>
      <div style="background:#141511;border:1px solid #2c2d23;border-radius:18px;padding:24px;">
        <p style="color:#e6e6e6;font-size:14px;line-height:1.6;margin:0;">Hi ${esc(params.recipientName.split(" ")[0])}, here's your ${params.kind} summary.</p>
        ${section("Chat", chatRows ? `<table style="width:100%;border-collapse:collapse;">${chatRows}</table>` : "")}
        ${section("Overdue", overdueRows ? `<table style="width:100%;border-collapse:collapse;">${overdueRows}</table>` : "")}
        ${section("Coming up", dueSoonRows ? `<table style="width:100%;border-collapse:collapse;">${dueSoonRows}</table>` : "")}
        <div style="text-align:center;margin:26px 0 4px;"><a href="${params.appUrl}/admin/chat" style="display:inline-block;background:${accent};color:#0b0b08;font-weight:700;font-size:14px;text-decoration:none;padding:11px 22px;border-radius:10px;">Open ClubOS</a></div>
      </div>
      <p style="text-align:center;color:#5a5a5a;font-size:11px;line-height:1.7;margin:20px 0 0;">You're getting this because you switched on the ${params.kind} digest.<br/><a href="${params.appUrl}/admin/notification-settings" style="color:#8a8a8a;">Change or turn off your notification settings</a></p>
    </div>
  </div>`;

  return sendEmail({
    to: params.to,
    from: "ClubOS <noreply@cufc.co.nz>",
    subject: params.kind === "daily" ? "Your ClubOS daily summary" : "Your ClubOS week ahead",
    html,
  });
}

/** Render a bare YYYY-MM-DD as "Fri 8 Aug" WITHOUT constructing a Date from it —
 *  `new Date("2026-08-08")` is midnight UTC, which is the previous day in NZ and
 *  has already printed the wrong date on a live invoice once. */
function nzDisplayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(mo, 10) - 1]}${
    parseInt(y, 10) !== new Date().getFullYear() ? ` ${y}` : ""
  }`;
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
 * CUGC newsletter / broadcast — the Gymnastics Mailer's send function.
 * Reuses the club's own white-card crest shell so a newsletter looks like every
 * other email the gym sends, with the compulsory unsubscribe footer and an
 * optional 1×1 open-tracking pixel appended last (so a broken image URL can
 * never push itself into the middle of the copy).
 */
export async function sendCugcBroadcastEmail(params: {
  to: string;
  subject: string;
  bodyHtml: string;
  replyTo?: string;
  unsubscribeUrl: string;
  pixelUrl?: string;
}): Promise<boolean> {
  const body = `
    <div style="color:#3d3d3d;font-size:15px;line-height:1.65;">${params.bodyHtml}</div>
    <p style="color:#8492af;font-size:11px;line-height:1.6;margin:22px 0 0;border-top:1px solid #eef2f9;padding-top:14px;">
      You're receiving this because you're part of the Christchurch United Gymnastics Club community.
      <a href="${params.unsubscribeUrl}" style="color:#013590;text-decoration:underline;">Unsubscribe</a>
    </p>
    ${params.pixelUrl ? `<img src="${params.pixelUrl}" width="1" height="1" style="display:none;" alt="" />` : ""}`;
  return sendEmail({
    to: params.to,
    from: "Christchurch United Gymnastics Club <noreply@cugc.co.nz>",
    replyTo: params.replyTo || "info@cugc.co.nz",
    subject: params.subject,
    html: cugcEmailShell({ headline: params.subject, body }),
  });
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

/** Staff-triggered payment reminder — a captain is behind on weekly charges
 *  (or a failed instalment balance). One-click from the Payments tab; carries
 *  an open-tracking pixel + a tagged pay link so opens show in the admin. */
export async function sendLeaguePaymentReminderEmail(params: {
  registrationId: number;
  programId: number;
  captainEmail: string;
  captainName: string;
  teamName: string;
  kind: "weekly_missed" | "balance_failed";
  missedCount: number;
  missedAmount: string;   // formatted, e.g. $95.00
  payoffAmount: string;   // formatted — clears the registration in one go
  payUrl: string;         // /league/balance/:id?rt=token
  pixelUrl: string;       // /api/public/league/reminder/:token/pixel.gif
}): Promise<boolean> {
  const isWeekly = params.kind === "weekly_missed";
  const missedLine = isWeekly
    ? `<strong style="color:#f87171;">${params.missedCount} weekly payment${params.missedCount === 1 ? "" : "s"}</strong> for <strong>${params.teamName}</strong> ${params.missedCount === 1 ? "hasn't" : "haven't"} gone through — <strong style="color:#d1b96e;">${params.missedAmount}</strong> is currently behind.`
    : `The balance payment of <strong style="color:#d1b96e;">${params.missedAmount}</strong> for <strong>${params.teamName}</strong> didn't go through.`;
  const bodyHtml = `
    <p style="color:#e6e6e6; font-size:16px; margin:0 0 16px;">Hi ${params.captainName},</p>
    <p style="color:#bdbdbd; font-size:14px; line-height:1.6; margin:0 0 16px;">
      Quick heads-up — ${missedLine}
    </p>
    ${isWeekly ? `<p style="color:#bdbdbd; font-size:14px; line-height:1.6; margin:0 0 24px;">
      We'll keep retrying the card on file automatically, so topping up that card may be all you need.
      The fastest way to square it away is to pay the rest of the term in one go — that clears what's behind and stops all future weekly charges:
    </p>` : `<p style="color:#bdbdbd; font-size:14px; line-height:1.6; margin:0 0 24px;">
      No stress — just pay it here to keep your spot:
    </p>`}
    <p style="text-align:center; margin:0 0 24px;">
      <a href="${params.payUrl}" style="display:inline-block; background:#d1b96e; color:#000; font-weight:600; text-decoration:none; padding:14px 28px; border-radius:9999px;">${isWeekly ? `Pay remaining ${params.payoffAmount}` : `Pay balance (${params.missedAmount})`}</a>
    </p>
    <p style="color:#8a8a8a; font-size:12px; line-height:1.6; margin:0;">
      Card trouble or need a hand? Just reply to this email and we'll sort it.
    </p>
    <img src="${params.pixelUrl}" width="1" height="1" style="display:none;" alt="" />`;

  return sendEmail({
    to: params.captainEmail,
    from: MFL_FROM,
    replyTo: MFL_REPLY_TO,
    subject: `Payment catch-up — ${params.teamName}`,
    html: mflShell({ heading: "Payment Catch-Up", bodyHtml }),
    campId: params.programId,
    registrationId: params.registrationId,
  });
}

// ── Hiring — a new job application landed ────────────────────────────────────
// Sent to whoever the job names in `notify_email`, falling back to the club
// inbox. Best-effort at the call site: a Resend outage must never cost us an
// application. Nothing about a minor beyond what a reviewer needs to make
// contact — the child's answers stay in ClubOS, behind the tab.
const HIRING_NOTIFY_TO = "info@cufc.co.nz";
const HIRING_APP_URL = process.env.APP_URL || "https://app.usg.co.nz";

function hiringRow(label: string, value: string): string {
  if (!value) return "";
  return `<tr>
    <td style="color:#8a93b8; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; padding:7px 0; vertical-align:top; white-space:nowrap;">${label}</td>
    <td style="color:#0c1640; font-size:14px; font-weight:500; padding:7px 0 7px 16px; text-align:right;">${value}</td>
  </tr>`;
}

const hiringEscape = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function sendHiringApplicationNotification(params: {
  to?: string;
  jobTitle: string;
  jobSlug: string;
  applicationId: number;
  applicantName: string;
  email: string;
  phone: string;
  city?: string;
  guardianRequired: boolean;
  guardianName?: string;
  guardianPhone?: string;
  auditionUrl?: string;
  hasAuditionFile: boolean;
  answers: Record<string, string | boolean>;
  questions: { id: string; label: string; type: string }[];
}): Promise<boolean> {
  const link = `${HIRING_APP_URL}/admin/hiring`;

  const contactRows = [
    hiringRow("Applicant", hiringEscape(params.applicantName)),
    hiringRow("Email", `<a href="mailto:${hiringEscape(params.email)}" style="color:#263996;">${hiringEscape(params.email)}</a>`),
    hiringRow("Phone", `<a href="tel:${hiringEscape(params.phone)}" style="color:#263996;">${hiringEscape(params.phone)}</a>`),
    hiringRow("Location", hiringEscape(params.city || "")),
    params.guardianRequired
      ? hiringRow("Guardian", `${hiringEscape(params.guardianName || "—")}${params.guardianPhone ? ` · ${hiringEscape(params.guardianPhone)}` : ""}`)
      : "",
  ].join("");

  const auditionRows = [
    params.auditionUrl
      ? hiringRow("Audition link", `<a href="${hiringEscape(params.auditionUrl)}" style="color:#263996;">${hiringEscape(params.auditionUrl.slice(0, 60))}</a>`)
      : "",
    params.hasAuditionFile ? hiringRow("Audition file", "Uploaded — play it in ClubOS") : "",
  ].join("");

  // Long written answers read better as blocks than as table rows.
  const written = params.questions
    .filter((q) => q.type === "textarea" && typeof params.answers[q.id] === "string")
    .map((q) => {
      const body = hiringEscape(String(params.answers[q.id])).replace(/\n/g, "<br/>");
      return `<div style="margin-top:18px;">
        <div style="color:#8a93b8; font-size:11px; text-transform:uppercase; letter-spacing:0.6px; margin-bottom:6px;">${hiringEscape(q.label)}</div>
        <div style="color:#0c1640; font-size:14px; line-height:1.6; background:#f7f8fb; border:1px solid #e3e7f0; border-radius:10px; padding:12px 14px;">${body}</div>
      </div>`;
    })
    .join("");

  const guardianFlag = params.guardianRequired
    ? `<div style="margin-top:16px; padding:12px 14px; border-radius:10px; background:#fff6e5; border:1px solid #f0a91e;">
         <strong style="color:#0c1640; font-size:13px;">Under 16 — guardian consent given.</strong>
         <div style="color:#5b6480; font-size:13px; margin-top:3px;">Contact the guardian, not the applicant, to arrange anything.</div>
       </div>`
    : "";

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
    <div style="background:#0c1640; padding:26px 28px;">
      <div style="color:#d4af37; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">New application</div>
      <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">${hiringEscape(params.jobTitle)}</div>
    </div>
    <div style="padding:24px 28px;">
      <table style="width:100%; border-collapse:collapse;">${contactRows}${auditionRows}</table>
      ${guardianFlag}
      ${written}
      <div style="margin-top:26px;">
        <a href="${link}" style="display:inline-block; background:#263996; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 22px; border-radius:999px;">Review in ClubOS</a>
      </div>
      <div style="color:#8a93b8; font-size:12px; margin-top:18px;">Application #${params.applicationId} · ${hiringEscape(params.jobSlug)}</div>
    </div>
  </div>`;

  return sendEmail({
    to: params.to || HIRING_NOTIFY_TO,
    from: fromForOrg(7, "United Sports Group"),
    // Reply goes to the guardian when there is one — never straight to a child.
    replyTo: params.guardianRequired ? undefined : params.email,
    subject: `New ${params.jobTitle} application — ${params.applicantName}`,
    html,
  });
}

// ── CIC referee accounts ──────────────────────────────────────────────────────
const REFEREE_NOTIFY_TO = process.env.CIC_REFEREE_NOTIFY_EMAIL || "info@cicyouth.com";
const REFEREE_APP_BASE = (process.env.REFEREE_APP_URL || "https://app.usg.co.nz").replace(/\/+$/, "");

// Heads-up to CIC staff that someone signed up to referee — so they can approve
// them promptly in the ClubOS Referees tab. Best-effort; never blocks signup.
export async function sendRefereeSignupNotification(params: {
  orgId: number;
  refereeName: string;
  email: string;
  phone: string;
}): Promise<boolean> {
  const link = `${REFEREE_APP_BASE}/admin/cic-referees`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
    <div style="background:#0e0e10; padding:26px 28px;">
      <div style="color:#c9a43e; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">New referee sign-up</div>
      <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">${hiringEscape(params.refereeName)}</div>
    </div>
    <div style="padding:24px 28px;">
      <table style="width:100%; border-collapse:collapse;">
        <tr><td style="color:#8a8a8a; font-size:13px; padding:6px 0;">Email</td><td style="color:#0c0c0c; font-size:14px; padding:6px 0;"><a href="mailto:${hiringEscape(params.email)}" style="color:#946a00;">${hiringEscape(params.email)}</a></td></tr>
        <tr><td style="color:#8a8a8a; font-size:13px; padding:6px 0;">Phone</td><td style="color:#0c0c0c; font-size:14px; padding:6px 0;"><a href="tel:${hiringEscape(params.phone)}" style="color:#946a00;">${hiringEscape(params.phone)}</a></td></tr>
      </table>
      <div style="color:#5b5b5b; font-size:13px; margin-top:16px;">They can't score anything until you approve them.</div>
      <div style="margin-top:22px;">
        <a href="${link}" style="display:inline-block; background:#c9a43e; color:#0e0e10; text-decoration:none; font-weight:700; font-size:14px; padding:12px 22px; border-radius:999px;">Review in ClubOS</a>
      </div>
    </div>
  </div>`;
  return sendEmail({
    to: REFEREE_NOTIFY_TO,
    from: fromForOrg(params.orgId, "Christchurch International Cup"),
    replyTo: params.email,
    subject: `New CIC referee sign-up — ${params.refereeName}`,
    html,
  });
}

// Tell an approved referee they're in, with the link to sign in and score.
export async function sendRefereeApprovedEmail(params: {
  orgId: number;
  to: string;
  refereeName: string;
}): Promise<boolean> {
  const link = `${REFEREE_APP_BASE}/login`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; max-width:600px; margin:0 auto; background:#ffffff;">
    <div style="background:#0e0e10; padding:26px 28px;">
      <div style="color:#c9a43e; font-size:11px; font-weight:700; letter-spacing:2px; text-transform:uppercase;">You're approved</div>
      <div style="color:#ffffff; font-size:22px; font-weight:700; margin-top:6px;">CIC Referee Scoring</div>
    </div>
    <div style="padding:24px 28px;">
      <div style="color:#0c0c0c; font-size:15px; line-height:1.6;">Hi ${hiringEscape(params.refereeName)},</div>
      <div style="color:#3a3a3a; font-size:14px; line-height:1.7; margin-top:10px;">Your referee account is active. You can now sign in and score your Christchurch International Cup games from your phone — score, goalscorers, cards, MVP, golden glove and penalty shootouts, all in one place.</div>
      <div style="margin-top:22px;">
        <a href="${link}" style="display:inline-block; background:#c9a43e; color:#0e0e10; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">Open referee scoring</a>
      </div>
      <div style="color:#8a8a8a; font-size:12px; margin-top:18px;">Sign in with the email and password you used to sign up. Tip: add the page to your home screen for one-tap access.</div>
    </div>
  </div>`;
  return sendEmail({
    to: params.to,
    from: fromForOrg(params.orgId, "Christchurch International Cup"),
    subject: "You're approved — CIC referee scoring",
    html,
  });
}

// ── MFL referee accounts (Mini Football Leagues) ──────────────────────────────
// Clone of the two CIC referee emails above, for the league's own referee
// scoring system (server/league-referee-routes.ts). MFL-branded (black + gold,
// reuses the mflShell/mflRow helpers already defined in this file) rather than
// the CIC one-off HTML, and sent from org 3's verified domain via fromForOrg.
const MFL_REFEREE_NOTIFY_TO = process.env.MFL_REFEREE_NOTIFY_EMAIL || "info@minifootball.co.nz";
// A dedicated ref.minifootball.co.nz host is coming; today's login lives on
// the shared ClubOS app domain, same as the CIC referee login.
const MFL_REFEREE_LOGIN_URL = "https://app.usg.co.nz/mfl-ref";

// Heads-up to MFL staff that someone signed up to referee — so they can
// approve them promptly in the ClubOS Referees tab. Best-effort; never blocks
// signup.
export async function sendMflRefereeSignupNotification(params: {
  orgId: number;
  refereeName: string;
  email: string;
  phone: string;
}): Promise<boolean> {
  const link = `${REFEREE_APP_BASE}/admin/mfl-referees`;
  const body = `
    <table style="width:100%; border-collapse:collapse;">
      ${mflRow("Name", hiringEscape(params.refereeName))}
      ${mflRow("Email", `<a href="mailto:${hiringEscape(params.email)}" style="color:#d1b96e;">${hiringEscape(params.email)}</a>`)}
      ${mflRow("Phone", `<a href="tel:${hiringEscape(params.phone)}" style="color:#d1b96e;">${hiringEscape(params.phone)}</a>`)}
    </table>
    <div style="color:#9a9a9a; font-size:13px; margin-top:16px;">They can't score anything until you approve them.</div>
    <div style="margin-top:22px;">
      <a href="${link}" style="display:inline-block; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:14px; padding:12px 24px; border-radius:999px;">Review in ClubOS</a>
    </div>`;
  return sendEmail({
    to: MFL_REFEREE_NOTIFY_TO,
    from: fromForOrg(params.orgId, "Mini Football Leagues"),
    replyTo: params.email,
    subject: `New MFL referee sign-up — ${params.refereeName}`,
    html: mflShell({ heading: "New referee sign-up", bodyHtml: body }),
  });
}

// Tell an approved referee they're in, with the link to sign in and score.
export async function sendMflRefereeApprovedEmail(params: {
  orgId: number;
  to: string;
  refereeName: string;
}): Promise<boolean> {
  const body = `
    <div style="color:#e6e6e6; font-size:15px; line-height:1.6;">Hi ${hiringEscape(params.refereeName)},</div>
    <div style="color:#b7b7b7; font-size:14px; line-height:1.7; margin-top:10px;">Your referee account is active. You can now sign in and score your Mini Football Leagues games from your phone — score, goalscorers and cards, all in one place.</div>
    <div style="margin-top:22px;">
      <a href="${MFL_REFEREE_LOGIN_URL}" style="display:inline-block; background:#d1b96e; color:#000000; text-decoration:none; font-weight:700; font-size:15px; padding:13px 26px; border-radius:999px;">Open referee scoring</a>
    </div>
    <div style="color:#7d7d7d; font-size:12px; margin-top:18px;">Sign in with the email and password you used to sign up. A dedicated ref.minifootball.co.nz address is coming — this link works today. Tip: add the page to your home screen for one-tap access.</div>`;
  return sendEmail({
    to: params.to,
    from: fromForOrg(params.orgId, "Mini Football Leagues"),
    subject: "You're approved — MFL referee scoring",
    html: mflShell({ heading: "You're approved", bodyHtml: body }),
  });
}

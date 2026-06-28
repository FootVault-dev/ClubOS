import { storage } from "./storage";

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
        html: params.html,
        text: params.text ?? htmlToText(params.html),
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
        body: params.html,
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

  const defaultFrom = "CUFC Camps <noreply@cufc.co.nz>";
  const defaultSubject = "Booking Confirmed — {{campName}}";
  const defaultBody = `
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

const MFL_FROM = "Mini Football Leagues <noreply@cufc.co.nz>";
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
}): Promise<boolean> {
  const unsubFooter = `
    <p style="color:#5a5a5a; font-size:11px; line-height:1.6; margin:18px 0 0; border-top:1px solid #1f1f1f; padding-top:14px;">
      You're receiving this because you registered a team or player with Mini Football Leagues.
      <a href="${params.unsubscribeUrl}" style="color:#8a8a8a; text-decoration:underline;">Unsubscribe</a>
    </p>`;
  return sendEmail({
    to: params.to,
    from: MFL_FROM,
    replyTo: params.replyTo || MFL_REPLY_TO,
    subject: params.subject,
    html: mflShell({ heading: params.subject, bodyHtml: params.bodyHtml + unsubFooter }),
    ...(params.campId ? { campId: params.campId } : {}),
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

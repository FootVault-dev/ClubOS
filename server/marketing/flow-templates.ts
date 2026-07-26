/**
 * Marketing Suite — the v1 launch flow library (Phase E), ranked by expected
 * impact (03-flows-automation-roi.md §C + synthesis directive (c)).
 *
 * These are server-side seed definitions exposed via GET /flows/templates and
 * used to stamp a new flow's trigger + graph when a user picks a template. Every
 * template ships with tasteful, plain-English starter copy + merge tags and is
 * fully editable after creation — the copy is a starting point, not a lock-in.
 *
 * Consent note: the abandoned-enrolment emails are OPERATIONAL (isMarketing:false)
 * — they're about a specific registration the person began, so they ride the
 * 'inferred' consent basis the enrolment relationship establishes (synthesis §(d)
 * gate 1). The term-reminder + welcome flows are MARKETING and only reach people
 * with express, subscribed consent (the send gate enforces this — no exceptions).
 */

import type { FlowGraph } from "./flow-graph";

export interface FlowTemplate {
  key: string;
  name: string;
  /** Plain-English description shown in the template gallery. */
  description: string;
  /** Expected-impact note (honest — no fabricated club benchmarks; ecommerce analogue only). */
  expectedImpact: string;
  triggerType: "event" | "date_property" | "list" | "segment";
  triggerConfig: Record<string, unknown>;
  entryFilter?: Record<string, unknown> | null;
  graph: FlowGraph;
}

const btn = (label: string) =>
  `<p style="margin:28px 0;"><a href="#" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${label}</a></p>`;

const wrap = (inner: string) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;max-width:560px;">${inner}</div>`;

// ── #1 Abandoned enrolment recovery ──────────────────────────────────────────
const abandonedEnrolment: FlowTemplate = {
  key: "abandoned_enrolment",
  name: "Abandoned enrolment recovery",
  description:
    "When someone starts a registration but doesn't finish paying, this quietly nudges them to complete it — 1 hour later, the next day, then a final reminder. Stops automatically the moment they pay.",
  expectedImpact:
    "The single highest-revenue automation for the club. Recovers high-ticket sign-ups (a term or tournament entry is worth far more than a $50 kit). Modelled on abandoned-cart flows — the top-earning flow type in ecommerce.",
  triggerType: "event",
  triggerConfig: {
    metricName: "Started Registration",
    exitOn: "Completed Registration",
    kind: "abandoned_enrolment",
    reEntry: "after_exit",
  },
  entryFilter: null,
  graph: {
    entry: "s1",
    steps: [
      { id: "s1", type: "delay", config: { value: 1, unit: "hours" }, next: "s2" },
      {
        id: "s2",
        type: "email",
        config: {
          isMarketing: false,
          subject: "You're nearly signed up, {{first_name}}",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>We noticed you started a registration but didn't quite finish. No worries — your spot is still open and it only takes a minute to complete.</p>
             ${btn("Finish your registration")}
             <p>If you have any questions or hit a snag, just reply to this email — a real person will help.</p>
             <p>See you on the pitch,<br/>The team</p>`,
          ),
        },
        next: "s3",
      },
      { id: "s3", type: "delay", config: { value: 23, unit: "hours" }, next: "s4" },
      {
        id: "s4",
        type: "email",
        config: {
          isMarketing: false,
          subject: "Still keen? Your place is waiting",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Just a friendly reminder that your registration is still unfinished. Places do fill up, so we'd hate for you to miss out.</p>
             ${btn("Complete my registration")}
             <p>Stuck on anything — cost, dates, or which group is the right fit? Reply here and we'll sort it with you.</p>
             <p>Cheers,<br/>The team</p>`,
          ),
        },
        next: "s5",
      },
      { id: "s5", type: "delay", config: { value: 24, unit: "hours" }, next: "s6" },
      {
        id: "s6",
        type: "email",
        config: {
          isMarketing: false,
          subject: "Last chance to secure your spot",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>This is the last reminder we'll send about your unfinished registration. If you still want in, now's the time — after this we'll release the spot.</p>
             ${btn("Secure my spot now")}
             <p>If the timing isn't right, no problem at all — we'll catch you next time.</p>
             <p>Ngā mihi,<br/>The team</p>`,
          ),
        },
        next: null,
      },
    ],
  },
};

// ── #2 Term re-registration reminder ─────────────────────────────────────────
const termReRegistration: FlowTemplate = {
  key: "term_re_registration",
  name: "Term re-registration reminder",
  description:
    "Reminds current families to re-enrol before a new term starts — first 14 days out, again 7 days later, then a final call 5 days after that. Set the term start date on the trigger.",
  expectedImpact:
    "The club's recurring-revenue engine. Academy families and league teams re-register every term — the biggest repeatable lever there is. Runs off a term start date you set (program/term wiring is a fast-follow).",
  triggerType: "date_property",
  triggerConfig: {
    source: "term_start",
    date: null, // set an ISO date (YYYY-MM-DD) — the term's start day
    offsetDays: -14,
    time: "09:00",
    kind: "term_re_registration",
    reEntry: "never",
  },
  entryFilter: null,
  graph: {
    entry: "s1",
    steps: [
      {
        id: "s1",
        type: "email",
        config: {
          isMarketing: true,
          subject: "Re-enrol for next term — spots are opening",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Next term is coming up fast and we'd love to keep your place. Re-enrolling now guarantees your preferred day and group before they fill.</p>
             ${btn("Re-enrol for next term")}
             <p>Same great sessions, same familiar faces. Any questions about days or levels, just reply.</p>
             <p>See you soon,<br/>The team</p>`,
          ),
        },
        next: "s2",
      },
      { id: "s2", type: "delay", config: { value: 7, unit: "days" }, next: "s3" },
      {
        id: "s3",
        type: "email",
        config: {
          isMarketing: true,
          subject: "A quick nudge — re-enrolment is still open",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Just checking in — you haven't re-enrolled yet and we don't want you to miss your spot for next term.</p>
             ${btn("Secure our place")}
             <p>It takes two minutes and locks in your usual session.</p>
             <p>Cheers,<br/>The team</p>`,
          ),
        },
        next: "s4",
      },
      { id: "s4", type: "delay", config: { value: 5, unit: "days" }, next: "s5" },
      {
        id: "s5",
        type: "email",
        config: {
          isMarketing: true,
          subject: "Final call for next term",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Term starts in a few days and this is our last reminder. If you'd like to keep your place, please re-enrol today.</p>
             ${btn("Re-enrol now")}
             <p>If you're not continuing this term, no worries — you're always welcome back.</p>
             <p>Ngā mihi,<br/>The team</p>`,
          ),
        },
        next: null,
      },
    ],
  },
};

// ── #3 Welcome series ─────────────────────────────────────────────────────────
const welcomeSeries: FlowTemplate = {
  key: "welcome_series",
  name: "Welcome series",
  description:
    "Greets a new family the moment they complete their first registration, then follows up over the next week with what's on and how to get the most out of the club. Switch the trigger to a list to welcome list sign-ups instead.",
  expectedImpact:
    "The second-highest-converting flow after abandoned-cart. Sets first impressions, lifts retention and lifetime value, and warms new families toward their next purchase.",
  triggerType: "event",
  triggerConfig: {
    metricName: "Completed Registration",
    kind: "welcome",
    reEntry: "never",
  },
  entryFilter: null,
  graph: {
    entry: "s1",
    steps: [
      {
        id: "s1",
        type: "email",
        config: {
          isMarketing: true,
          subject: "Welcome to the club, {{first_name}}!",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Welcome aboard — we're stoked to have you with us. You're all set, and we can't wait to see you at your first session.</p>
             <p>Over the next week we'll send a couple of short notes with everything you need: what to bring, where to go, and how things work.</p>
             ${btn("View your details")}
             <p>Any questions in the meantime, just reply — we're here to help.</p>
             <p>See you soon,<br/>The team</p>`,
          ),
        },
        next: "s2",
      },
      { id: "s2", type: "delay", config: { value: 3, unit: "days" }, next: "s3" },
      {
        id: "s3",
        type: "email",
        config: {
          isMarketing: true,
          subject: "What's on at the club",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>Now that you're settled in, here's a quick look at what's happening — sessions, events, and the little extras that make being part of the club fun.</p>
             ${btn("See what's on")}
             <p>Come along, bring a mate, and make the most of it.</p>
             <p>Cheers,<br/>The team</p>`,
          ),
        },
        next: "s4",
      },
      { id: "s4", type: "delay", config: { value: 4, unit: "days" }, next: "s5" },
      {
        id: "s5",
        type: "email",
        config: {
          isMarketing: true,
          subject: "Gear up + join the community",
          bodyHtml: wrap(
            `<p>Hi {{first_name}},</p>
             <p>One last welcome note. If you'd like to kit up or grab something from the shop, here's where to look — and there's a whole community to get involved with too.</p>
             ${btn("Visit the shop")}
             <p>Thanks for being part of it. We're glad you're here.</p>
             <p>Ngā mihi,<br/>The team</p>`,
          ),
        },
        next: null,
      },
    ],
  },
};

export const FLOW_TEMPLATES: FlowTemplate[] = [abandonedEnrolment, termReRegistration, welcomeSeries];

export function getFlowTemplate(key: string): FlowTemplate | undefined {
  return FLOW_TEMPLATES.find((t) => t.key === key);
}

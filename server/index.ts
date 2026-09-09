import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupAuth } from "./auth";
import { viewAsReadOnly } from "./view-as-routes";
import { attributionCookieMiddleware } from "./attribution-cookies";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // 25mb so base64-encoded uploads (e.g. e-Sign PDF documents) fit — the
    // Express default is 100kb, which 413s on any real PDF.
    limit: "25mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "25mb" }));

setupAuth(app);

// 🔴 Mounted immediately after the session, before every route: while a super
// admin is viewing ClubOS as a member of staff, nothing may be written. See
// server/view-as-routes.ts — a write made while impersonating would be recorded
// under the staff member's name.
app.use(viewAsReadOnly);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse).slice(0, 500)}`;
      }

      log(logLine);
    }
  });

  next();
});

// AttributionOS (T4): ensure first-party usg_vid / usg_cid cookies on real page
// loads, before any route runs. Defensive — never throws, never touches /api or
// static assets. See server/attribution-cookies.ts.
app.use(attributionCookieMiddleware);

(async () => {
  const { seedDatabase, migrateScheduleData } = await import("./seed");
  await seedDatabase().catch((e) => console.error("Seed error:", e));
  await migrateScheduleData().catch((e) => console.error("Schedule migration error:", e));
  await registerRoutes(httpServer, app);

  // Sandbox workspace — Club Dossier (isolated module; super_admin-gated).
  const { registerClubDossierRoutes } = await import("./club-dossier-routes");
  registerClubDossierRoutes(app);

  // Sandbox workspace — Market Research (read-only competitor intelligence).
  const { registerMarketResearchRoutes } = await import("./market-research-routes");
  registerMarketResearchRoutes(app);

  // Staff feedback board — Feature Requests / Bug Reports (any logged-in staff
  // can submit; managers triage). Universal tab, gated by requireAuth only.
  const { registerFeedbackRoutes } = await import("./feedback-routes");
  registerFeedbackRoutes(app);

  // Task Tracker — the organisation-wide project & task system. Universal tab
  // in every workspace (same pattern as Chat and Feedback), so it is gated by
  // requireAuth only and its tables are deliberately not org-scoped.
  const { registerTaskTrackerRoutes } = await import("./task-tracker-routes");
  registerTaskTrackerRoutes(app);

  // Knowledge Base — the club vault (articles per brand) + Rambo, the assistant
  // that reads it. Universal tab like Chat/Feedback/Task Tracker, so gated by
  // requireAuth only; visibility is per ARTICLE, and Rambo's live-stat tools are
  // filtered per request against the caller's real ClubOS tab access.
  // See migrations/2026-08-12_knowledge_base.sql + shared/knowledge-base.ts.
  const { registerKnowledgeBaseRoutes } = await import("./kb-routes");
  registerKnowledgeBaseRoutes(app);

  // Club Drive — the club's own file store. Universal tab like the above, so
  // gated by requireAuth only; visibility is per NODE and INHERITS down the
  // folder tree, judged by the same decider the KB and Rambo use. Rambo gets a
  // search_drive tool whose results are filtered file-by-file for the asker.
  // See migrations/2026-08-15_club_drive.sql + shared/drive.ts.
  const { registerDriveRoutes } = await import("./drive-routes");
  registerDriveRoutes(app);

  // United Prints workspace — Warehouse Management System. Dark-launched
  // (requireTab("warehouse") — super_admin only until T17 wires "warehouse"
  // into shared/tabs.ts). This registers items/locations/barcode-alias CRUD +
  // label-payload endpoints (T4); later loop tasks add reservations,
  // receiving, scan, pick/dispatch, requisitions, loans, counts and sync.
  const { registerWarehouseRoutes } = await import("./warehouse-routes");
  registerWarehouseRoutes(app);

  // Warehouse v2 (D18–D25): asset instances (the things the club owns
  // one-by-one), the self-service field-template editor, and the counter
  // sale. Same requireTab("warehouse") gate; the template editor additionally
  // requires an admin, since it changes the SHAPE of everyone's data.
  const { registerWarehouseV2Routes } = await import("./warehouse-v2-routes");
  registerWarehouseV2Routes(app);

  // Warehouse models (D32–D35): the model layer above the barcoded variants,
  // the autocomplete the counting cockpit runs on, and the catalogue CSV in
  // Dima's column order. Same requireTab("warehouse") gate as v1 and v2.
  const { registerWarehouseModelRoutes } = await import("./warehouse-models-routes");
  registerWarehouseModelRoutes(app);

  // United Prints workspace — Warehouse channel sync (T12/SPEC §4.3): the
  // public Shopify webhook endpoint (siu/cufc) + the debounced push queue
  // wired into server/warehouse.ts's post-commit hook. Entirely inert
  // without config — WH_SYNC_ENABLED unset means the push queue no-ops, and
  // a store missing its WH_SHOPIFY_<STORE>_WEBHOOK_SECRET just 200s an
  // ignored event rather than crashing.
  const { registerWarehouseSyncRoutes } = await import("./warehouse-sync");
  registerWarehouseSyncRoutes(app);

  // Staff Chat — the in-house Slack (channels + DMs, replaces the WhatsApp
  // staff groups). Universal tab like Feedback: requireAuth only, every
  // workspace. See migrations/2026-07-22_staff_chat.sql + shared/staff-chat.ts.
  const { registerStaffChatRoutes } = await import("./staff-chat-routes");
  registerStaffChatRoutes(app);

  // Notification preferences + staff push-device registration. Universal
  // (requireAuth only) because settings belong to a PERSON, not a workspace —
  // they must answer identically on web and phone, in any workspace.
  // See migrations/2026-08-07_notifications.sql + shared/notifications.ts.
  const { registerNotificationRoutes } = await import("./notification-routes");
  registerNotificationRoutes(app);

  // Opt-in daily / weekly digests. 15-minute sweep, idempotent on the NZ
  // calendar day — see server/digest-cron.ts. Nobody receives anything unless
  // they switched it on themselves, so this is inert until someone opts in.
  const { startDigestCron } = await import("./digest-cron");
  startDigestCron();

  // Hiring — job postings + applications. Admin side is gated by
  // requireTab("hiring") to the USG workspace; the public apply endpoints are
  // CORS-allow-listed to our own brand sites and carry no session.
  const { registerHiringRoutes } = await import("./hiring-routes");
  registerHiringRoutes(app);

  // Print Quotes — indicative quotes from unitedprints.co.nz's Instant Quote
  // page, approved/rejected into the existing Orders pipeline. Admin side is
  // gated by requireTab("quotes") to the United Prints workspace; the public
  // submit endpoint is CORS-allow-listed to unitedprints.co.nz and carries no
  // session.
  const { registerPrintQuoteRoutes } = await import("./print-quote-routes");
  registerPrintQuoteRoutes(app);

  // Internal print requests — club staff ask the print shop for something,
  // Dima approves it into a job or declines it. Gated by requireTab("requests");
  // approving/declining is separately gated on the workspace role, because the
  // tab whitelist can't tell a submitter from an approver.
  const { registerPrintRequestRoutes } = await import("./print-request-routes");
  registerPrintRequestRoutes(app);

  // Site FAQs — the questions on a brand's website and in its live-chat widget,
  // edited in ClubOS instead of the website's source. Public read is CORS-allow-
  // listed to the brand sites; editing is gated by requireTab("faqs").
  const { registerFaqRoutes } = await import("./faq-routes");
  registerFaqRoutes(app);

  // Print expenses — every purchase the shop makes, with its invoice stored
  // inline (Supabase storage is egress-restricted). Gated by
  // requireTab("expenses"); GST is recorded per expense, never inferred.
  const { registerPrintExpenseRoutes } = await import("./print-expense-routes");
  registerPrintExpenseRoutes(app);

  // USG Invoices — tracked, payable invoices (org 7, super-admin only). Admin
  // side is gated by requireTab("invoices"); public endpoints are CORS-allow-
  // listed to usg-invoices.vercel.app and carry no session.
  const { registerInvoiceRoutes } = await import("./invoice-routes");
  registerInvoiceRoutes(app);

  // Stripe Payouts — explain every bulk bank deposit: list the account's
  // payouts and break each into its charges with programme + player + parent
  // resolved from ClubOS rows. Read-only against Stripe AND the DB; gated by
  // requireTab("payouts") (SUPER_ADMIN_ONLY_TABS — names families next to
  // amounts, same class of data as invoices).
  const { registerPayoutRoutes } = await import("./payout-routes");
  registerPayoutRoutes(app);
  // Fleet — company vehicles, assignments, insurance, servicing, running costs.
  // Gated by requireTab("vehicles"), which is in SUPER_ADMIN_ONLY_TABS: the
  // records tie a named staff member to an insurance policy and an FBT
  // private-use position, so it is Daniel-only until he says otherwise.
  const { registerVehicleRoutes } = await import("./vehicles-routes");
  registerVehicleRoutes(app);

  // Staff Videos — the in-house Loom. Recorder + library gated by
  // requireTab("videos") in the USG workspace; the /v/{token} share pages hit
  // public endpoints (random non-enumerable tokens, staff opens excluded from
  // analytics). Video bytes live on Cloudflare Stream, never in our DB.
  const { registerVideoRoutes } = await import("./videos-routes");
  registerVideoRoutes(app);

  // Sporty / NZ Football NRS — outbound registration push (the FM/Club Hub
  // pathway, approved by NZF 2026-07-20). Gated by requireTab("sporty"), which
  // is in SUPER_ADMIN_ONLY_TABS: it pushes children's identity data to a
  // national register, so it stays Daniel-only through UAT. No public surface.
  const { registerSportyRoutes } = await import("./sporty-routes");
  registerSportyRoutes(app);

  // Housing — the residency houses at the United Sports Centre: rooms, tenants,
  // rent and utility bills. Admin-only, gated by requireTab("housing") to the
  // venue workspace. No public surface: rent arrears are not a public fact.
  const { registerHousingRoutes } = await import("./housing-routes");
  registerHousingRoutes(app);

  // Christchurch Ethnic Cup — registrations of interest from ethniccup.com.
  // Public POST is CORS-scoped to that site; the admin board is gated by
  // requireTab("ethnic-cup-registrations") inside the CIC workspace.
  const { registerEthnicCupRoutes } = await import("./ethnic-cup-routes");
  registerEthnicCupRoutes(app);

  // Team Pay — team entries, per-player squad payment, the manager's dashboard
  // and the fill-in marketplace. Public routes are authenticated by a token in
  // the URL and no login; the staff board is gated by requireTab("team-entries").
  const { registerTeampayRoutes } = await import("./teampay-routes");
  registerTeampayRoutes(app);

  // Club Events — ticketed club events (first: the CUFC Club Dinner, 13 Nov
  // 2026). Public pages by slug/token, no login; the staff tab is gated by
  // requireTab("club-events"); refunds by requireRefundPermission.
  const { registerClubEventRoutes } = await import("./club-events-routes");
  registerClubEventRoutes(app);

  // Maintenance — the United Sports Centre's cleaning/consumable supplies and
  // its machines & equipment. Admin-only, gated by requireTab("maintenance") to
  // the venue workspace. Sibling of Housing, built for Riley (grounds staff).
  const { registerMaintenanceRoutes } = await import("./maintenance-routes");
  registerMaintenanceRoutes(app);

  // Equipment Register — one responsible person per team, the gear they hold,
  // and their termly declaration of it. USG workspace, gated by
  // requireTab("equipment"), which is locked in SUPER_ADMIN_ONLY_TABS.
  //
  // It DOES have a public surface, and deliberately so: the person responsible
  // maintains their own list through a signed "eqh:" link rather than a ClubOS
  // account, because handing twenty-five part-time coaches accounts would be a
  // far larger access change than a gear register warrants.
  const { registerEquipmentRoutes } = await import("./equipment-routes");
  registerEquipmentRoutes(app);

  // Fines — both directions (the club owes / owed to the club), with the notice
  // and the payment confirmation stored through the Club Drive storage adapter
  // and served by short-lived signed URL, never a public link.
  const { registerFinesRoutes } = await import("./fines-routes");
  registerFinesRoutes(app);

  // POS — one register for every brand, every programme, every counter. Gated by
  // requireTab("pos"); NOT super-admin-locked (Olga, Travis, Zach, Isaac). Money
  // rules live in Postgres (migrations/2026-09-09_pos.sql).
  const { registerPosRoutes } = await import("./pos-routes");
  registerPosRoutes(app);

  // Coding Budget — Victor's FY2026 chart of accounts (882 codes) and the
  // transactions mapped against it. Locked to super admins: code 21 names
  // eleven staff against their salaries.
  const { registerCodingBudgetRoutes } = await import("./coding-budget-routes");
  registerCodingBudgetRoutes(app);

  // Open Trainings — free open-training requests from cufc.co.nz. The
  // invite-only funnel for U9–U20 academy programmes (2026-07-21): public
  // POST + the CUFC workspace tab where staff approve/decline each request.
  const { registerOpenTrainingRoutes } = await import("./open-training-routes");
  registerOpenTrainingRoutes(app);

  // Management — the planning workspace (projects → statuses → tasks with
  // board/table/calendar/Gantt views). First home: United Prints (org 8);
  // org-scoped and generic by design.
  const { registerManagementRoutes } = await import("./management-routes");
  registerManagementRoutes(app);

  // Sales — the United Print prospect database + pipeline (prints workspace).
  // Gated by requireTab("sales"), which is in SUPER_ADMIN_ONLY_TABS while
  // Daniel shapes it. No public surface: a prospect list is a sales asset.
  const { registerSalesRoutes } = await import("./sales-routes");
  registerSalesRoutes(app);

  // Friendly Manager History — 10 years of CUFC registrations + payments,
  // imported 2026-07-14 (fm_registration_history / fm_payment_history).
  // Read-only, gated by requireTab("fm-history") which is SUPER_ADMIN_ONLY:
  // children's enrolment records and family payment history, Daniel-only
  // until he opens it up.
  const { registerFmHistoryRoutes } = await import("./fm-history-routes");
  registerFmHistoryRoutes(app);

  // FM Competitions — 11yr tournaments + social leagues (fm_competition_*).
  // Read-only, requireTab("fm-competitions") ∈ SUPER_ADMIN_ONLY.
  const { registerFmCompetitionsRoutes } = await import("./fm-competitions-routes");
  registerFmCompetitionsRoutes(app);

  // CIC Content Marketplace — live sales + engagement analytics for the CIC
  // photo store (content.cicyouth.com). Reads the usg-meet photos_* tables;
  // gated by requireTab("cic-content-marketplace") to the CIC workspace.
  const { registerContentMarketplaceRoutes } = await import("./content-marketplace-routes");
  registerContentMarketplaceRoutes(app);

  // CIC referee scoring — referees score their CIC games from their phones.
  // Public referee sign-up/login + token-scoped scoring endpoints (resolve CIC
  // org 5 server-side, never a staff session); admin approval + assignment gated
  // by requireTab("cic-referees") in the CIC workspace.
  const { registerCicRefereeRoutes } = await import("./cic-referee-routes");
  registerCicRefereeRoutes(app);

  // MFL referee scoring — clone of the CIC referee system for Mini Football
  // Leagues. Public referee sign-up/login + token-scoped scoring endpoints
  // (resolve MFL org server-side, never a staff session); admin approval gated
  // by requireTab("mfl-referees"), scheduling/assignment/media gated by
  // requireTab("competitions") — both in the MFL workspace.
  const { registerLeagueRefereeRoutes } = await import("./league-referee-routes");
  registerLeagueRefereeRoutes(app);

  // Periodically sweep abandoned facility-booking carts: cancel any pending bookings older
  // than 30 minutes and cancel their Stripe PaymentIntent so a late webhook can never flip
  // them back to paid (which would otherwise risk double-booking the slot).
  const sweepAbandonedFacilityBookings = async () => {
    try {
      const { storage } = await import("./storage");
      const stale = await storage.getStalePendingFacilityBookings(30);
      if (stale.length === 0) return;
      const groups = new Map<string, typeof stale>();
      for (const row of stale) {
        const key = row.bookingGroupId || `pi:${row.stripePaymentIntentId || row.id}`;
        if (!groups.has(key)) groups.set(key, [] as any);
        (groups.get(key) as any).push(row);
      }
      let cancelledCount = 0;
      const { stripe } = await import("./stripe");
      for (const [, rows] of groups) {
        const groupId = rows[0].bookingGroupId;
        const pi = rows[0].stripePaymentIntentId;

        // Safety check: if a Stripe PaymentIntent exists, only proceed when it is in a
        // cancelable state. If it has already succeeded (or capture is pending), the
        // webhook will flip the booking to paid — we must NOT pre-cancel it, otherwise
        // the customer ends up charged for a cancelled booking.
        // Stripe is the source of truth for whether the customer has been charged.
        // Only cancel the DB row when we can verify the PI is in a terminal, non-paid state.
        if (pi) {
          let safeToCancel = false;
          try {
            const piObj = await stripe.paymentIntents.retrieve(pi);
            if (piObj.status === "canceled") {
              // PI already canceled (e.g. by previous sweeper run that crashed before DB cancel) — clean up the orphan row
              safeToCancel = true;
            } else if (["succeeded", "requires_capture"].includes(piObj.status)) {
              // Customer has been (or is being) charged — webhook owns this row, never touch it
              continue;
            } else {
              const cancelled = await stripe.paymentIntents.cancel(pi, { cancellation_reason: "abandoned" });
              safeToCancel = cancelled.status === "canceled";
            }
          } catch (e: any) {
            // Cancel failed — re-fetch and only cancel the DB row if the PI is now canceled.
            // Crucially, do NOT cancel on 'succeeded' because the webhook will mark it paid.
            try {
              const piObj = await stripe.paymentIntents.retrieve(pi);
              safeToCancel = piObj.status === "canceled";
              if (!safeToCancel) {
                console.warn(`[Sweeper] Skipping DB cancel for PI ${pi} (status=${piObj.status})`, e?.message || e);
                continue;
              }
            } catch (e2: any) {
              if (String(e2?.message || "").match(/No such/i)) {
                // PI doesn't exist on Stripe at all — safe to cancel the orphan row
                safeToCancel = true;
              } else {
                console.error("[Sweeper] PI re-check failed", e2?.message || e2);
                continue;
              }
            }
          }
          if (!safeToCancel) continue;
        }

        if (groupId) {
          try {
            const out = await storage.cancelPendingFacilityBookingsByGroup(groupId);
            cancelledCount += out.length;
          } catch (e) {
            console.error("[Sweeper] cancel group failed", e);
          }
        }
      }
      if (cancelledCount > 0) console.log(`[Sweeper] Cancelled ${cancelledCount} abandoned facility booking(s)`);
    } catch (e) {
      console.error("[Sweeper] Error:", e);
    }
  };
  setInterval(sweepAbandonedFacilityBookings, 5 * 60 * 1000);
  setTimeout(sweepAbandonedFacilityBookings, 30 * 1000);

  // United Prints: 24h upload-reminder cron.
  const { startPrintCron } = await import("./print-cron");
  startPrintCron();

  // Sporty auto-sync: hourly push of new/changed CUFC registrations to the NRS.
  // No-ops unless SPORTY_AUTOSYNC=1 AND credentials are installed.
  const { startSportySyncCron } = await import("./sporty-cron");
  startSportySyncCron();

  // Calendar event reminders: per-minute sweeper.
  const { startReminderCron } = await import("./calendar-invites");
  startReminderCron();

  // MFL instalments: charge scheduled team-registration balances on their due date.
  const { startLeagueBalanceCron } = await import("./league-balance-cron");
  startLeagueBalanceCron();

  // Stripe payouts → Xero, already split by what was actually sold.
  // No-ops unless XERO_PAYOUT_AUTOPOST=1.
  const { startXeroPayoutCron } = await import("./xero-payout-cron");
  startXeroPayoutCron();

  // Mailer: dispatch scheduled newsletter sends when their time arrives.
  const { startMflMailerScheduler } = await import("./routes");
  startMflMailerScheduler();

  // External API security: nightly retention pruning of the key audit tables.
  const { startApiSecurityJobs } = await import("./api-security");
  startApiSecurityJobs();

  // AttributionOS: daily Meta ad-spend sync (no-op without META_ACCESS_TOKEN + accounts).
  const { startAdSpendCron } = await import("./ad-spend-cron");
  startAdSpendCron();

  // AttributionOS: nightly data-quality guards (prune stale page views, bot-flag
  // backstop, short-link counter reconciliation).
  const { startAttributionMaintenanceCron } = await import("./attribution-maintenance-cron");
  startAttributionMaintenanceCron();

  // Total Tracking Platform: nightly behavioral rollups (page/section/click/
  // journey/hour-of-day) + behavior_events partition maintenance + 13-month prune.
  const { startBehaviorRollupCron } = await import("./behavior-rollup-cron");
  startBehaviorRollupCron();
  // Marketing Suite ("MarketingOS", Phase B) — durable send worker (graphile-worker).
  // Self-guards on DATABASE_URL / MARKETING_WORKER_DISABLED and never crashes boot.
  const { startMarketingWorker } = await import("./marketing/worker");
  void startMarketingWorker();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // Anything under /api/* that wasn't matched by an explicit route is a real 404.
  // Without this, the SPA fallback below would happily return the index.html (200, text/html)
  // for any unknown API URL — causing stale clients to try `JSON.parse("<!DOCTYPE html>...")`
  // and produce confusing "Unexpected token '<'" errors instead of a clear 404 message.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ message: "API route not found" });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();

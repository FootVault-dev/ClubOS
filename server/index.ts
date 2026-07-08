import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupAuth } from "./auth";

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

(async () => {
  const { seedDatabase, migrateScheduleData } = await import("./seed");
  await seedDatabase().catch((e) => console.error("Seed error:", e));
  await migrateScheduleData().catch((e) => console.error("Schedule migration error:", e));
  await registerRoutes(httpServer, app);

  // Sandbox workspace — Club Dossier (isolated module; super_admin-gated).
  const { registerClubDossierRoutes } = await import("./club-dossier-routes");
  registerClubDossierRoutes(app);

  // Staff feedback board — Feature Requests / Bug Reports (any logged-in staff
  // can submit; managers triage). Universal tab, gated by requireAuth only.
  const { registerFeedbackRoutes } = await import("./feedback-routes");
  registerFeedbackRoutes(app);

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

  // Calendar event reminders: per-minute sweeper.
  const { startReminderCron } = await import("./calendar-invites");
  startReminderCron();

  // MFL instalments: charge scheduled team-registration balances on their due date.
  const { startLeagueBalanceCron } = await import("./league-balance-cron");
  startLeagueBalanceCron();

  // External API security: nightly retention pruning of the key audit tables.
  const { startApiSecurityJobs } = await import("./api-security");
  startApiSecurityJobs();

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

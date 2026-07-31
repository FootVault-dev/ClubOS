// PayShare inbound hooks + the participant pay bridge.
//
// Route map (the two inbound paths are configured in the PayShare portal and
// MUST NOT be renamed without changing them there too):
//   POST /api/payshare/create-payment   ← signed, PayShare asks us for a
//                                          checkout URL for one person's share
//   POST /api/webhooks/payshare         ← signed, group finished
//   GET  /api/payshare/pay/:token       → our pay page loads the share
//   POST /api/payshare/pay/:token/intent   → embedded Stripe PaymentIntent
//   POST /api/payshare/pay/:token/confirm  → record-payment, then back to PayShare
//
// `start-split` deliberately lives in routes.ts beside the Player Pay
// checkout-split it mirrors, because it needs that file's quote builder, slot
// conflict model and advisory-lock reservation. Splitting it out would mean
// either an import cycle or refactoring the live money path.
//
// Settlement (flipping the booking to paid) is injected as a dependency for the
// same no-cycle reason split-pay.ts uses.

import type { Express } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { payshareParticipants, payshareSessions } from "@shared/schema";
import {
  PAYSHARE_SITE_ORIGIN,
  getParticipantByToken,
  getPayShareClient,
  getSessionByPayShareId,
  payshareEnv,
  rememberEvent,
  upsertParticipant,
} from "./payshare";

export type PayShareRouteDeps = {
  /** Flip a pending facility-booking group to paid + send the USC email. */
  confirmBookingGroup: (groupId: string) => Promise<unknown[]>;
};

/**
 * Does PayShare's stated session total agree with what we reserved?
 *
 * `totalAmount` arrives as a string and the contract does not pin whether it is
 * minor or major units, so this accepts either reading — but ONLY if one of them
 * reconciles exactly. Anything else fails closed and the booking stays pending:
 * confirming a $170 pitch against a $1.70 session is not a rounding error.
 */
export function amountsReconcile(theirs: string | null | undefined, oursMinor: number): boolean {
  if (theirs == null) return false;
  const raw = String(theirs).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) return false;
  if (!raw.includes(".") && Number(raw) === oursMinor) return true; // minor units
  const major = Math.round(Number(raw) * 100);
  return Number.isFinite(major) && major === oursMinor; // major units
}

export function registerPayShareRoutes(app: Express, deps: PayShareRouteDeps) {
  // ── 1. create-payment (signed, inbound) ───────────────────────────────────
  // PayShare calls this each time someone joins the group. We answer with a URL
  // to OUR embedded-Stripe pay page — never a PayShare-hosted or Stripe-hosted
  // one. Idempotent by construction: upsertParticipant is unique on
  // (session, participant), so a retried hook returns the same token, the same
  // page and the same payment intent rather than charging anyone twice.
  app.post("/api/payshare/create-payment", async (req, res) => {
    const env = payshareEnv();
    if (!env) return res.status(503).json({ error: { code: "INTERNAL_ERROR", message: "PayShare is not configured" } });

    try {
      const { handleCreatePaymentRequest, platformHookError } = await import("@payshare/platform-sdk");
      const rawBody = (req.rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body ?? {});

      const result = await handleCreatePaymentRequest({
        rawBody,
        headers: { get: (name: string) => req.header(name) ?? null },
        signingSecret: env.createPaymentSigningSecret,
        handler: async (input) => {
          const session = await getSessionByPayShareId(input.sessionId);
          if (!session) {
            const e = platformHookError("BOOKING_NOT_FOUND", "Unknown PayShare session", 404);
            throw Object.assign(new Error(e.json.error.message), { payshareHook: e });
          }

          const participant = await upsertParticipant({
            payshareSessionId: session.id,
            participantId: input.participantId,
            role: input.role,
            shareAmountMinor: input.shareAmountMinor,
            currency: input.currency,
            // Where PayShare wants them back once their share is done.
            returnUrl: input.payshareParticipantReturnUrl ?? input.payshareParticipantResumeUrl ?? null,
          });

          // Audit trail only — the participant unique index is the real guard.
          await rememberEvent(input.eventId, "create_payment", input.sessionId, {
            participantId: input.participantId,
          }).catch(() => {});

          return { redirectUrl: `${PAYSHARE_SITE_ORIGIN}/book/payshare/pay/${participant.payToken}` };
        },
      });

      return res.status(result.status).json(result.json);
    } catch (e: any) {
      if (e?.payshareHook) return res.status(e.payshareHook.status).json(e.payshareHook.json);
      console.error("[PayShare] create-payment failed:", e);
      return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "create-payment failed" } });
    }
  });

  // ── 2. completion webhook (signed, inbound) ───────────────────────────────
  // The ONLY thing that marks a booking paid. Not the Stripe success page, not
  // the first record-payment — a group is not funded until PayShare says the
  // whole group is, and says it over a verified signature.
  app.post("/api/webhooks/payshare", async (req, res) => {
    const env = payshareEnv();
    if (!env) return res.status(503).json({ error: { code: "INTERNAL_ERROR", message: "PayShare is not configured" } });

    try {
      const { handlePayShareWebhookRequest, PAYSHARE_SESSION_COMPLETED } = await import("@payshare/platform-sdk");
      const rawBody = (req.rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body ?? {});

      const result = await handlePayShareWebhookRequest({
        rawBody,
        headers: { get: (name: string) => req.header(name) ?? null },
        signingSecret: env.webhookSigningSecret,
        handler: async (event) => {
          const type = String((event as any).eventType || "");

          // Capture-ready: our PaymentIntents capture on confirmation, so there
          // is never an authorised-but-uncaptured charge to sweep. Soft-return
          // rather than throw — the wizard self-test fires this with no Stripe
          // objects at all, and a throw there fails an otherwise-green run.
          if (type === "PAYSHARE_SESSION_CAPTURE_READY") {
            console.log("[PayShare] capture-ready — nothing to capture (intents capture on confirm)");
            return;
          }

          if (type !== PAYSHARE_SESSION_COMPLETED) {
            console.log(`[PayShare] ignoring event type ${type || "(none)"}`);
            return;
          }

          const eventId = String((event as any).eventId || "");
          const sessionId = String((event as any).sessionId || "");

          // Cross-machine dedupe. Prod runs two Fly machines; without this a
          // replayed completion can confirm the same group twice.
          const seen = await rememberEvent(eventId, "webhook", sessionId, { ok: true });
          if (!seen.fresh) {
            console.log(`[PayShare] completion ${eventId} already handled — replaying`);
            return;
          }

          const session = await getSessionByPayShareId(sessionId);
          if (!session) {
            console.error(`[PayShare] completion for unknown session ${sessionId}`);
            return;
          }

          // Reconcile before confirming. PayShare owns participant counts and
          // share maths; we own the price of the pitch. If those two disagree
          // the booking stays pending and a human looks at it.
          const theirTotal = (event as any).totalAmount;
          const theirCurrency = String((event as any).currency || "");
          if (!amountsReconcile(theirTotal, session.amountMinor)) {
            console.error(
              `[PayShare] REFUSING to confirm ${sessionId}: total ${theirTotal} does not reconcile with ${session.amountMinor} (minor)`,
            );
            return;
          }
          if (theirCurrency.toUpperCase() !== String(session.currency).toUpperCase()) {
            console.error(
              `[PayShare] REFUSING to confirm ${sessionId}: currency ${theirCurrency} ≠ ${session.currency}`,
            );
            return;
          }

          await db
            .update(payshareSessions)
            .set({ status: "completed", completedAt: new Date() })
            .where(eq(payshareSessions.id, session.id));

          if (session.bookingGroupId) {
            const confirmed = await deps.confirmBookingGroup(session.bookingGroupId);
            console.log(`[PayShare] session ${sessionId} completed → confirmed ${confirmed.length} booking row(s)`);
          } else {
            // A self-test session carries no booking group. Nothing to confirm.
            console.log(`[PayShare] session ${sessionId} completed with no booking group (self-test)`);
          }
        },
      });

      return res.status(result.status).json(result.json);
    } catch (e: any) {
      console.error("[PayShare] webhook failed:", e);
      return res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "webhook failed" } });
    }
  });

  // ── 3. the pay page's own API ─────────────────────────────────────────────
  app.get("/api/payshare/pay/:token", async (req, res) => {
    try {
      const found = await getParticipantByToken(req.params.token);
      if (!found) return res.status(404).json({ message: "This payment link isn't valid." });
      const { participant, session } = found;
      res.json({
        amountCents: participant.shareAmountMinor,
        currency: participant.currency,
        status: participant.status,
        role: participant.role,
        sessionStatus: session.status,
        expiresAt: session.expiresAt,
        returnUrl: participant.returnUrl,
        totalCents: session.amountMinor,
      });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.post("/api/payshare/pay/:token/intent", async (req, res) => {
    try {
      const found = await getParticipantByToken(req.params.token);
      if (!found) return res.status(404).json({ message: "This payment link isn't valid." });
      const { participant, session } = found;
      if (participant.status === "captured") return res.status(400).json({ message: "This share is already paid." });

      const { stripe } = await import("./stripe");

      // Reuse the existing intent so a refresh, a back button or a retried hook
      // can never open a second charge against the same person.
      if (participant.stripePaymentIntentId) {
        const existing = await stripe.paymentIntents.retrieve(participant.stripePaymentIntentId);
        if (existing && existing.status !== "canceled") {
          return res.json({ clientSecret: existing.client_secret, amountCents: participant.shareAmountMinor });
        }
      }

      const intent = await stripe.paymentIntents.create({
        // PayShare told us this person's share. We charge exactly that.
        amount: participant.shareAmountMinor,
        currency: String(participant.currency || "NZD").toLowerCase(),
        description: `PayShare share — United Sports Centre booking`,
        // Card + wallets only. `allow_redirects: "never"` blocks BNPL methods,
        // which matters twice over here: the club's surcharge doctrine, and the
        // fact that a redirect to Klarna would strand the payer outside the
        // return-to-PayShare hop entirely.
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        metadata: {
          kind: "payshare_share",
          payshareSessionId: session.sessionId,
          payshareParticipantId: participant.participantId,
          bookingGroupId: session.bookingGroupId || "",
        },
      });

      await db
        .update(payshareParticipants)
        .set({ stripePaymentIntentId: intent.id })
        .where(eq(payshareParticipants.id, participant.id));

      res.json({ clientSecret: intent.client_secret, amountCents: participant.shareAmountMinor });
    } catch (e: any) {
      console.error("[PayShare] intent failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // Called by our pay page once Stripe confirms. Tells PayShare the share is
  // in, then hands back where to send the payer. This does NOT confirm the
  // booking — only the completion webhook does that.
  app.post("/api/payshare/pay/:token/confirm", async (req, res) => {
    try {
      const found = await getParticipantByToken(req.params.token);
      if (!found) return res.status(404).json({ message: "This payment link isn't valid." });
      const { participant, session } = found;
      if (!participant.stripePaymentIntentId) return res.status(400).json({ message: "No payment to confirm." });

      const { stripe } = await import("./stripe");
      const intent = await stripe.paymentIntents.retrieve(participant.stripePaymentIntentId);
      if (intent.status !== "succeeded") {
        return res.status(400).json({ message: "That payment hasn't completed yet." });
      }

      if (participant.status !== "captured") {
        const client = await getPayShareClient();
        const common = {
          sessionId: session.sessionId,
          participantId: participant.participantId,
          amountMinor: String(participant.shareAmountMinor),
          currency: String(participant.currency),
          externalProvider: "stripe",
          // Stable per phase, as the contract requires — the intent id is the
          // same object for both, and PayShare dedupes on it.
          externalPaymentReference: intent.id,
          occurredAt: new Date().toISOString(),
        };
        // Our intents authorise and capture in one step, so both phases are
        // reported against the same charge.
        await client.recordPayment({ ...common, kind: "authorize" });
        await client.recordPayment({ ...common, kind: "capture" });

        await db
          .update(payshareParticipants)
          .set({ status: "captured", paidAt: new Date() })
          .where(eq(payshareParticipants.id, participant.id));
      }

      res.json({ ok: true, returnUrl: participant.returnUrl || null });
    } catch (e: any) {
      console.error("[PayShare] confirm failed:", e);
      res.status(500).json({ message: e.message });
    }
  });
}

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
  recordSession,
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

/**
 * Group capture — the step PayShare asks for once every share is authorised.
 *
 * Each participant's PaymentIntent has been sitting at `requires_capture` (money
 * held, not taken). Here we capture every hold and report each one back as
 * `capture`. Only after this does PayShare send the completion webhook that
 * actually marks the booking paid.
 *
 * Deliberately resilient rather than transactional: one card failing to capture
 * must not abandon the other five holds. A partial capture is a money state that
 * needs a human, so it is logged loudly rather than silently retried forever.
 */
async function captureGroup(sessionId: string): Promise<void> {
  const session = await getSessionByPayShareId(sessionId);
  if (!session) {
    console.error(`[PayShare] capture-ready for unknown session ${sessionId}`);
    return;
  }

  const parts = await db
    .select()
    .from(payshareParticipants)
    .where(eq(payshareParticipants.payshareSessionId, session.id));
  const holds = parts.filter(p => p.stripePaymentIntentId && p.status !== "captured");

  if (holds.length === 0) {
    // Soft-return, never throw. The wizard self-test fires capture-ready with
    // no Stripe objects behind it at all, and a throw there fails an otherwise
    // green run.
    console.log(`[PayShare] capture-ready ${sessionId} — no holds to capture (self-test, or already captured)`);
    return;
  }

  const { stripe } = await import("./stripe");
  const client = await getPayShareClient();
  let captured = 0;
  const failed: string[] = [];

  for (const p of holds) {
    try {
      let intent = await stripe.paymentIntents.retrieve(p.stripePaymentIntentId!);
      // Idempotent: a redelivered capture-ready must not re-capture.
      if (intent.status === "requires_capture") {
        intent = await stripe.paymentIntents.capture(p.stripePaymentIntentId!);
      }
      if (intent.status !== "succeeded") {
        failed.push(`${p.participantId}(${intent.status})`);
        continue;
      }

      await client.recordPayment({
        sessionId: session.sessionId,
        participantId: p.participantId,
        kind: "capture",
        amountMinor: String(p.shareAmountMinor),
        currency: String(p.currency),
        externalProvider: "stripe",
        externalPaymentReference: intent.id,
        occurredAt: new Date().toISOString(),
      });

      await db
        .update(payshareParticipants)
        .set({ status: "captured" })
        .where(eq(payshareParticipants.id, p.id));
      captured++;
    } catch (e: any) {
      failed.push(`${p.participantId}(${e?.message || "error"})`);
    }
  }

  if (failed.length > 0) {
    console.error(
      `[PayShare] capture-ready ${sessionId}: captured ${captured}/${holds.length} — FAILED: ${failed.join(", ")}. ` +
        `Booking group ${session.bookingGroupId} is part-captured and needs a human.`,
    );
  } else {
    console.log(`[PayShare] capture-ready ${sessionId}: captured ${captured}/${holds.length} hold(s)`);
  }
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
      const { handleCreatePaymentRequest } = await import("@payshare/platform-sdk");
      const rawBody = (req.rawBody as Buffer | undefined)?.toString("utf8") ?? JSON.stringify(req.body ?? {});

      const result = await handleCreatePaymentRequest({
        rawBody,
        headers: { get: (name: string) => req.header(name) ?? null },
        signingSecret: env.createPaymentSigningSecret,
        handler: async (input) => {
          // 🔴 An unknown session must still answer 2xx with a redirectUrl —
          // the contract reserves 401 for a bad signature alone, and the wizard
          // self-test signs a create-payment for a session we never started.
          // So adopt it, with NO bookingGroupId: a completion for an orphan
          // confirms nothing, because the webhook needs a group to confirm.
          // The signature is already verified by this point, so only PayShare
          // can reach here.
          let session = await getSessionByPayShareId(input.sessionId);
          if (!session) {
            console.log(`[PayShare] adopting unknown session ${input.sessionId} (ref ${input.merchantOrderRef ?? "—"})`);
            try {
              session = await recordSession({
                organizationId: 4, // United Sports Centre
                sessionId: input.sessionId,
                bookingGroupId: null,
                amountMinor: input.shareAmountMinor,
                currency: input.currency,
                sessionUrl: null,
                merchantOrderRef: input.merchantOrderRef,
                expiresAt: null,
              });
            } catch {
              // Lost the race with a concurrent hook — re-read theirs.
              session = await getSessionByPayShareId(input.sessionId);
            }
            if (!session) throw new Error("Could not open a PayShare session record");
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

          // Every share is authorised — capture the held funds together. This
          // is the step that actually takes the money, and it happens once the
          // whole group is in, never per payer.
          if (type === "PAYSHARE_SESSION_CAPTURE_READY") {
            await captureGroup(String((event as any).sessionId || ""));
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
        // 🔴 MANUAL capture — the heart of the PayShare model. Each person
        // AUTHORISES their share and the money is only held; every hold is
        // captured together once PayShare says the whole group is in. Automatic
        // capture would charge the first payer for a booking that may never
        // fill, leaving us owing refunds — which is the exact problem the
        // product exists to avoid.
        capture_method: "manual",
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
      const r = await recordAuthorisedShare(req.params.token);
      if (!r.ok) return res.status(r.status).json({ message: r.message });
      res.json({ ok: true, returnUrl: r.returnUrl });
    } catch (e: any) {
      console.error("[PayShare] confirm failed:", e);
      res.status(500).json({ message: e.message });
    }
  });

  // The PSP success bridge, at the conventional path PayShare probes for.
  // Our own pay page normally reports the authorisation over fetch and never
  // leaves the tab, so this exists for two other reasons: a redirect-style
  // return (a 3DS hop that lands the payer back here), and the wizard self-test,
  // which checks the route exists at all. It is GET because a browser lands on
  // it, and it never marks a booking paid — only the completion webhook does.
  app.get("/api/payshare/stripe-success", async (req, res) => {
    // Whatever happens, a browser is standing here — so every path ends in a
    // redirect back to PayShare, never a JSON body. PayShare's own probe checks
    // exactly that (a 302 to PAYSHARE_APP_URL), because a bridge that renders
    // JSON is a bridge that has stranded a payer.
    const fallback = payshareEnv()?.appUrl ?? PAYSHARE_SITE_ORIGIN;
    try {
      const token = String(req.query.token ?? "").trim();
      if (!token) return res.redirect(302, fallback);

      const r = await recordAuthorisedShare(token);
      if (!r.ok) {
        console.warn(`[PayShare] stripe-success for ${token}: ${r.message}`);
        return res.redirect(302, fallback);
      }
      return res.redirect(302, r.returnUrl || fallback);
    } catch (e: any) {
      console.error("[PayShare] stripe-success failed:", e);
      return res.redirect(302, fallback);
    }
  });
}

/**
 * One payer's share has been authorised on our Stripe — tell PayShare.
 *
 * Shared by the pay page's confirm call and the redirect-style success bridge
 * so the two can never drift on the thing that matters: `authorize` is recorded,
 * never `capture`. Reporting a capture here would tell PayShare the money is
 * banked while it is still only a hold, and the group-capture step would then
 * never be asked for.
 */
async function recordAuthorisedShare(
  token: string,
): Promise<{ ok: boolean; status: number; message?: string; returnUrl: string | null }> {
  const found = await getParticipantByToken(token);
  if (!found) return { ok: false, status: 404, message: "This payment link isn't valid.", returnUrl: null };
  const { participant, session } = found;
  if (!participant.stripePaymentIntentId) {
    return { ok: false, status: 400, message: "No payment to confirm.", returnUrl: null };
  }

  const { stripe } = await import("./stripe");
  const intent = await stripe.paymentIntents.retrieve(participant.stripePaymentIntentId);

  // 🔴 A manual-capture intent sits at `requires_capture` once the card is
  // authorised — that IS success at this stage, and the money is held, not
  // taken. `succeeded` only appears later, after the group capture. Testing for
  // `succeeded` here would reject every payer.
  const authorised = intent.status === "requires_capture" || intent.status === "succeeded";
  if (!authorised) {
    return { ok: false, status: 400, message: "That payment hasn't completed yet.", returnUrl: null };
  }

  if (participant.status === "pending") {
    const client = await getPayShareClient();
    await client.recordPayment({
      sessionId: session.sessionId,
      participantId: participant.participantId,
      kind: "authorize",
      amountMinor: String(participant.shareAmountMinor),
      currency: String(participant.currency),
      externalProvider: "stripe",
      // Stable per phase, as the contract requires.
      externalPaymentReference: intent.id,
      occurredAt: new Date().toISOString(),
    });

    await db
      .update(payshareParticipants)
      .set({ status: "authorized", paidAt: new Date() })
      .where(eq(payshareParticipants.id, participant.id));
  }

  return { ok: true, status: 200, returnUrl: participant.returnUrl || null };
}

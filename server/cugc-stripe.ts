import Stripe from "stripe";

// CUGC (Christchurch United Gymnastics Club) has its OWN Stripe account, entirely
// separate from the main ClubOS Stripe (server/stripe.ts). ONLY CUGC routes use
// this client — never the main STRIPE_SECRET_KEY, and the main client never uses
// the CUGC keys. Same apiVersion as the main client for consistency.
export const cugcStripe = new Stripe(process.env.CUGC_STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-04-30.basil",
});

/**
 * Verify a CUGC Stripe webhook signature against the raw request body. Mirrors
 * server/stripe.ts constructWebhookEvent but with the CUGC webhook secret.
 */
export function constructCugcWebhookEvent(payload: string | Buffer, sig: string): Stripe.Event {
  const webhookSecret = process.env.CUGC_STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("CUGC_STRIPE_WEBHOOK_SECRET not configured");
  }
  return cugcStripe.webhooks.constructEvent(payload, sig, webhookSecret);
}

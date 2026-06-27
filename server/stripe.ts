import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-04-30.basil",
});

export interface PaymentIntentParams {
  registrationId: number;
  campName: string;
  totalCents: number;
  currency: string;
  parentEmail: string;
  metadata?: Record<string, string>;
  /** Attach an existing Stripe customer (required when saving the card for later, e.g. instalments). */
  customerId?: string;
  /** Set to "off_session" to save the payment method for a future off-session charge (the MFL balance). */
  setupFutureUsage?: "off_session" | "on_session";
  /** Optional idempotency key to make retries safe. */
  idempotencyKey?: string;
}

export async function createPaymentIntent(params: PaymentIntentParams): Promise<Stripe.PaymentIntent> {
  const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: params.totalCents,
      currency: params.currency.toLowerCase(),
      receipt_email: params.parentEmail,
      ...(params.customerId ? { customer: params.customerId } : {}),
      ...(params.setupFutureUsage ? { setup_future_usage: params.setupFutureUsage } : {}),
      metadata: {
        registrationId: String(params.registrationId),
        ...params.metadata,
      },
      description: `${params.campName} — Registration #${params.registrationId}`,
      automatic_payment_methods: {
        enabled: true,
      },
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
  );

  return paymentIntent;
}

/**
 * Find an existing Stripe customer by email or create a new one. Used so the
 * deposit PaymentIntent can save a card on file for the later balance charge.
 */
export async function getOrCreateCustomer(params: {
  email: string;
  name?: string;
  phone?: string;
}): Promise<Stripe.Customer> {
  const existing = await stripe.customers.list({ email: params.email, limit: 1 });
  if (existing.data.length > 0) {
    return existing.data[0];
  }
  return stripe.customers.create({
    email: params.email,
    ...(params.name ? { name: params.name } : {}),
    ...(params.phone ? { phone: params.phone } : {}),
  });
}

/**
 * Create a SetupIntent to save a card on file with NO charge. Used by Split Pay:
 * each squad member saves their card while the split is 'open'; that saved card
 * is then charged its frozen share ONCE, off-session, when the captain locks the
 * roster (via createOffSessionPaymentIntent). usage:"off_session" so the saved
 * method is valid for the later merchant-initiated charge.
 */
export async function createSetupIntent(params: {
  customerId: string;
  metadata?: Record<string, string>;
}): Promise<Stripe.SetupIntent> {
  return stripe.setupIntents.create({
    customer: params.customerId,
    usage: "off_session",
    automatic_payment_methods: { enabled: true },
    metadata: params.metadata || {},
  });
}

/**
 * Charge a saved payment method off-session (no customer present). Used by the
 * MFL balance cron to collect the second instalment on the due date.
 * Throws if the charge requires authentication or is declined — caller handles state.
 */
export async function createOffSessionPaymentIntent(params: {
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  currency: string;
  description: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.PaymentIntent> {
  return stripe.paymentIntents.create(
    {
      amount: params.amountCents,
      currency: params.currency.toLowerCase(),
      customer: params.customerId,
      payment_method: params.paymentMethodId,
      off_session: true,
      confirm: true,
      description: params.description,
      metadata: params.metadata || {},
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined,
  );
}

export async function retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent> {
  return stripe.paymentIntents.retrieve(id);
}

export async function createRefund(params: {
  paymentIntentId: string;
  amountCents?: number;
  reason?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.Refund> {
  const refund = await stripe.refunds.create(
    {
      payment_intent: params.paymentIntentId,
      ...(params.amountCents ? { amount: params.amountCents } : {}),
      reason: "requested_by_customer",
      metadata: {
        ...(params.reason ? { admin_reason: params.reason } : {}),
        ...params.metadata,
      },
    },
    params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : undefined
  );
  return refund;
}

export async function retrieveRefund(id: string): Promise<Stripe.Refund> {
  return stripe.refunds.retrieve(id);
}

export function constructWebhookEvent(payload: string | Buffer, sig: string): Stripe.Event {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  }
  return stripe.webhooks.constructEvent(payload, sig, webhookSecret);
}

export { stripe };

import 'dotenv/config';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const pi = await stripe.paymentIntents.retrieve('pi_3TozlTB0V2tnya310cpo76hY', { expand: ['charges', 'latest_charge'] });
console.log('=== PaymentIntent ===');
console.log({ id: pi.id, amount: pi.amount, amount_received: pi.amount_received, currency: pi.currency, status: pi.status, created: new Date(pi.created*1000).toISOString(), latest_charge: pi.latest_charge?.id, description: pi.description });

// list refunds against this PI
const refunds = await stripe.refunds.list({ payment_intent: pi.id, limit: 10 });
console.log('\n=== Existing refunds ===');
console.log(refunds.data.map(r => ({ id: r.id, amount: r.amount, status: r.status, created: new Date(r.created*1000).toISOString() })));

for (const subId of ['sub_1TozlpB0V2tnya31McyInrQO', 'sub_1TozlrB0V2tnya311oAlrCnB']) {
  const s = await stripe.subscriptions.retrieve(subId);
  console.log(`\n=== Subscription ${subId} ===`);
  console.log({ status: s.status, items: s.items.data.map(i=>({price: i.price.id, unit_amount: i.price.unit_amount, interval: i.price.recurring?.interval})), current_period_end: new Date(s.current_period_end*1000).toISOString(), start: new Date(s.start_date*1000).toISOString() });
}

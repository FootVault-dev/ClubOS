import 'dotenv/config';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
for (const [label, subId] of [['Thursday reg370','sub_1TozlpB0V2tnya31McyInrQO'],['Monday reg371','sub_1TozlrB0V2tnya311oAlrCnB']]) {
  const s = await stripe.subscriptions.retrieve(subId);
  const inv = await stripe.invoices.list({ subscription: subId, limit: 20 });
  const paid = inv.data.filter(i=>i.status==='paid');
  console.log(label, subId, '→ status:', s.status, '| weekly price:', s.items.data[0]?.price?.unit_amount, '| invoices:', inv.data.length, '| paid invoices:', paid.length, '| paid total:', paid.reduce((a,i)=>a+i.amount_paid,0));
}

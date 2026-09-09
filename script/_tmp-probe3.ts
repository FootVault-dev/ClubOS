import Stripe from "stripe";
async function main(){
  const s = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });
  const subs = await s.subscriptions.list({ status: "active", limit: 100 });
  console.log("active subscriptions:", subs.data.length, subs.has_more ? "(more)" : "");
  let total = 0;
  for (const sub of subs.data.slice(0,5)) {
    const amt = sub.items.data.reduce((t,i)=> t + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
    total += amt;
    console.log(`  ${sub.id} $${(amt/100).toFixed(2)} next=${new Date((sub as any).current_period_end*1000).toISOString().slice(0,10)}`);
  }
}
main().catch(e=>{console.error(e.message);process.exit(1)});

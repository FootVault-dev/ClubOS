import Stripe from "stripe";
async function main() {
  const s = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });

  console.log("=== unfiltered payouts.list, newest 8, with real status ===");
  const all = await s.payouts.list({ limit: 8 });
  for (const p of all.data) {
    console.log(`  ${p.id} $${(p.amount/100).toFixed(2)} status=${p.status} arrival=${new Date(p.arrival_date*1000).toISOString().slice(0,10)}`);
  }

  console.log("\n=== filtered status:in_transit, with real status ===");
  const it = await s.payouts.list({ status: "in_transit", limit: 8 });
  for (const p of it.data) {
    console.log(`  ${p.id} $${(p.amount/100).toFixed(2)} status=${p.status} arrival=${new Date(p.arrival_date*1000).toISOString().slice(0,10)}`);
  }

  console.log("\n=== retrieve the top one directly ===");
  const one = await s.payouts.retrieve(all.data[0].id);
  console.log(`  ${one.id} status=${one.status} arrival=${new Date(one.arrival_date*1000).toISOString().slice(0,10)}`);

  console.log("\n=== balance detail ===");
  const b = await s.balance.retrieve();
  console.log("  available:", JSON.stringify(b.available));
  console.log("  pending:  ", JSON.stringify(b.pending));
}
main().catch(e => { console.error(e.message); process.exit(1); });
